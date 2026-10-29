"""Live latency of the feed, measured from public data only (#115).

Run from `data/`: `uv run python ../docs/analysis/live-latency/measure.py --poll 1200 > out.json`

- NOAA: when each GLM file of the last `--hours` became listable (S3 LastModified).
- Feed: the chunks of the current manifest, age of every flash when its chunk was listed.
- Edge: the manifest polled every second through the CDN for `--poll` seconds.
- Chains: the end-to-end age at the client for each option of ADR 0026, from the NOAA files.
"""

import argparse
import gzip
import json
import re
import sys
import time
import urllib.request
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
from numpy.typing import NDArray
from scintille_contract.chunk import SOURCE_VALUES, decode

FEED = "https://data.scintille.app/live/"
BUCKETS = {"glm-east": "noaa-goes19", "glm-west": "noaa-goes18"}
PRODUCT = "GLM-L2-LCFA"
FETCH_PARSE_S = 1.5
UPLOAD_S = 0.5
PCTS = (50, 95, 99, 99.9)

type Array = NDArray[np.float64]


def get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "scintille-latency"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return bytes(response.read())


def goes_time(value: str) -> float:
    start = datetime(int(value[:4]), 1, 1, tzinfo=UTC)
    return (
        start
        + timedelta(
            days=int(value[4:7]) - 1,
            hours=int(value[7:9]),
            minutes=int(value[9:11]),
            seconds=int(value[11:13]),
            milliseconds=100 * int(value[13]),
        )
    ).timestamp()


def iso(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def summary(values: Array) -> dict[str, float]:
    out = {f"p{p}": round(float(np.percentile(values, p)), 1) for p in PCTS}
    out |= {"max": round(float(values.max()), 1), "mean": round(float(values.mean()), 1)}
    return out | {"n": len(values)}


def noaa_files(bucket: str, hours: int) -> Array:
    """Rows of (start, end, listable) for every GLM file of the last `hours` hours."""
    now = datetime.now(UTC)
    rows = []
    for back in range(hours, -1, -1):
        hour = now - timedelta(hours=back)
        prefix = f"{PRODUCT}/{hour:%Y/%j/%H}/"
        xml = get(f"https://{bucket}.s3.amazonaws.com/?list-type=2&prefix={prefix}").decode()
        for key, modified in re.findall(
            r"<Key>([^<]+)</Key><LastModified>([^<]+)</LastModified>", xml
        ):
            match = re.search(r"_s(\d{14})_e(\d{14})_c\d{14}", key)
            if match:
                rows.append((goes_time(match[1]), goes_time(match[2]), iso(modified)))
    return np.array(sorted(rows))


def feed_ages() -> dict[str, Array]:
    """Age of every flash of the last hour when the manifest first listed its chunk."""
    manifest = json.loads(get(FEED + "manifest.json"))
    ages: dict[str, list[Array]] = {source: [] for source in SOURCE_VALUES}
    for ref in manifest["chunks"]:
        chunk = decode(gzip.decompress(get(FEED + ref["path"])))
        times = chunk.start.timestamp() + chunk.columns["event_offset_ms"] / 1000
        for index, source in enumerate(SOURCE_VALUES):
            selected = chunk.columns["source"] == index
            ages[source].append(iso(ref["end"]) - times[selected])
    return {source: np.concatenate(parts) for source, parts in ages.items()}


def poll_edge(seconds: float) -> dict[str, Any]:
    """Delay between a manifest's generation and its first sight at the nearest edge."""
    seen: dict[str, float] = {}
    ingests: dict[str, set[float]] = {source: set() for source in BUCKETS}
    end = time.time() + seconds
    while time.time() < end:
        tick = time.time()
        manifest = json.loads(get(FEED + "manifest.json"))
        seen.setdefault(manifest["generated_at"], time.time())
        for status in manifest["sources"]:
            if status["source"] in ingests and status["last_ingest_time"]:
                ingests[status["source"]].add(iso(status["last_ingest_time"]))
        time.sleep(max(0.0, 1 - (time.time() - tick)))
    generated = sorted(seen)[1:]
    delays = np.array([seen[g] - iso(g) for g in generated])
    return {"edge_delay_s": summary(delays), "ingests": {s: sorted(v) for s, v in ingests.items()}}


def ingest_delay(files: Array, ingests: list[float]) -> Array:
    """Time from a file becoming listable to the next ingest of that source."""
    listable = np.sort(files[:, 2])
    previous = np.searchsorted(listable, ingests, side="right") - 1
    return np.array(ingests)[previous >= 0] - listable[previous[previous >= 0]]


def flush_times(ingest: Array, sources: Array, rule: str, timeout: float, spacing: float) -> Array:
    """When the chunk holding each file is listed, for files sorted by ingest time."""
    if rule.startswith("clock"):
        every = float(rule[5:])
        return np.ceil(ingest / every) * every
    out = np.empty(len(ingest))
    last, i = -np.inf, 0
    while i < len(ingest):
        deadline = max(ingest[i] + timeout, last + spacing)
        seen, j, at = {sources[i]}, i + 1, deadline
        while j < len(ingest) and ingest[j] <= deadline:
            seen.add(sources[j])
            j += 1
            if len(seen) == len(BUCKETS):
                at = max(ingest[j - 1], last + spacing)
                break
        while j < len(ingest) and ingest[j] <= at:
            j += 1
        out[i:j] = at
        last, i = at, j
    return out


def chain(
    files: dict[str, Array], *, listing: float, rule: str, ttl: float, poll: float, lags: list[int]
) -> dict[str, Any]:
    rng = np.random.default_rng(115)
    parts = []
    for index, rows in enumerate(files.values()):
        listable = rows[:, 2] + rng.uniform(0, 1, len(rows))
        phase = rng.uniform(0, listing)
        ingest = np.ceil((listable - phase) / listing) * listing + phase + FETCH_PARSE_S
        parts.append(np.c_[rows[:, :2], ingest, np.full(len(rows), index)])
    rows = np.concatenate(parts)
    rows = rows[np.argsort(rows[:, 2])]
    listed = flush_times(rows[:, 2], rows[:, 3], rule, timeout=10, spacing=15) + UPLOAD_S
    samples = 40
    events = rows[:, :1] + rng.uniform(0, 1, (len(rows), samples)) * (rows[:, 1:2] - rows[:, :1])
    received = (
        listed[:, None] + rng.uniform(0, ttl, events.shape) + rng.uniform(0, poll, events.shape)
    )
    age = received - events
    hours = (rows[:, 2].max() - rows[:, 2].min()) / 3600
    flushes = len(np.unique(np.round(listed, 3))) / hours * 24 * 30
    late = {
        str(lag): {
            "flashes_pct": round(float((age > lag).mean() * 100), 3),
            "gaps_per_viewer_day": round(float((received - rows[:, :1] > lag).mean() * 8640), 1),
        }
        for lag in lags
    }
    return {
        "listed_s": summary((listed[:, None] - events).ravel()),
        "client_s": summary(age.ravel()),
        "puts_per_month": round(2 * flushes),
        "late": late,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hours", type=int, default=24)
    parser.add_argument("--poll", type=float, default=0, help="seconds of edge polling")
    args = parser.parse_args()

    out: dict[str, Any] = {"measured_at": datetime.now(UTC).isoformat()}
    edge = poll_edge(args.poll) if args.poll else None
    files = {source: noaa_files(bucket, args.hours) for source, bucket in BUCKETS.items()}
    out["noaa"] = {
        source: {
            "files": len(rows),
            "file_end_to_listable_s": summary(rows[:, 2] - rows[:, 1]),
            "event_to_listable_s": summary(
                (rows[:, 2:3] - rows[:, :1] - np.linspace(0, 1, 41) * 20).ravel()
            ),
        }
        for source, rows in files.items()
    }
    out["feed_listed_s"] = {
        source: summary(ages) for source, ages in feed_ages().items() if len(ages)
    }
    if edge:
        out["edge"] = edge["edge_delay_s"]
        out["listable_to_ingest_s"] = {
            source: summary(ingest_delay(files[source], edge["ingests"][source]))
            for source in BUCKETS
        }
    lags = [60, 70, 90, 120]
    out["chains"] = {
        "today": chain(files, listing=10, rule="clock30", ttl=10, poll=30, lags=lags),
        "client_only": chain(files, listing=2, rule="clock30", ttl=2, poll=5, lags=lags),
        "proposed": chain(files, listing=2, rule="event", ttl=2, poll=5, lags=lags),
        "push": chain(files, listing=2, rule="event", ttl=0, poll=0.3, lags=lags),
    }
    json.dump(out, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
