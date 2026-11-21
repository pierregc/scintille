"""`cyclones/tracks.json`: tropical cyclone tracks from NCEP TC vitals (ADR 0040)."""

import argparse
import csv
import io
import os
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from dagster import (
    Backoff,
    DefaultScheduleStatus,
    MaterializeResult,
    RetryPolicy,
    ScheduleDefinition,
    asset,
    define_asset_job,
)
from scintille_contract.models import SCHEMA_VERSION, Cyclone, CycloneFeed
from scintille_ingest.cli import live_store

from .resources import FeedResource
from .storm_catalog import CatalogStore, ObjectCatalogStore

PATH = "cyclones/tracks.json"
HEADERS = {"Content-Type": "application/json", "Cache-Control": "public, max-age=300"}
ATTRIBUTION = "NOAA NCEP TC vitals (NHC, CPHC, JTWC)"
NOMADS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod"
USER_AGENT = "scintille-cyclones"
CYCLE = timedelta(hours=6)
# Each run reads the last day again: a cycle comes out about 3 h late and may be reissued.
READ_CYCLES = 4
RETENTION = timedelta(days=60)
# A storm number comes back every season: a longer silence starts another storm.
SAME_STORM = timedelta(days=5)
# A storm absent from two cycles in a row is over.
ACTIVE_CYCLES = 2
MS_TO_KT = 1.943844
NM_TO_KM = 1.852
ONES = [
    "ONE",
    "TWO",
    "THREE",
    "FOUR",
    "FIVE",
    "SIX",
    "SEVEN",
    "EIGHT",
    "NINE",
    "TEN",
    "ELEVEN",
    "TWELVE",
    "THIRTEEN",
    "FOURTEEN",
    "FIFTEEN",
    "SIXTEEN",
    "SEVENTEEN",
    "EIGHTEEN",
    "NINETEEN",
]
TENS = ["TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY"]

Fetch = Callable[[str], str | None]
"""Body of a URL, or None when the server has no such file."""


@dataclass(frozen=True)
class Fix:
    agency: str
    number: str
    name: str
    time: datetime
    lat: float
    lon: float
    heading: int | None
    speed_ms: float | None
    wind_kt: int | None
    r34_km: int | None


def _number(text: str) -> int | None:
    try:
        value = int(text)
    except ValueError:
        return None
    return None if value < 0 else value


def _angle(text: str, negative: str) -> float:
    return int(text[:-1]) / 10 * (-1 if text[-1] == negative else 1)


def parse_vitals(text: str) -> list[Fix]:
    """Fixes of numbered cyclones; invests (90 to 99) and broken lines are skipped."""
    fixes = []
    for line in text.splitlines():
        f = line.split()
        if len(f) < 13 or len(f[1]) != 3 or not f[1][:2].isdigit() or int(f[1][:2]) >= 90:
            continue
        try:
            time = datetime.strptime(f[3] + f[4], "%Y%m%d%H%M").replace(tzinfo=UTC)
            lat, lon = _angle(f[5], "S"), _angle(f[6], "W")
        except ValueError:
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180) or f[1][2] not in "LECWABSPQ":
            continue
        heading, speed, wind = _number(f[7]), _number(f[8]), _number(f[12])
        radii = [r for r in map(_number, f[14:18]) if r]
        fixes.append(
            Fix(
                agency=f[0],
                number=f[1],
                name=f[2],
                time=time,
                lat=lat,
                lon=lon,
                heading=heading if heading is not None and heading <= 360 else None,
                speed_ms=None if speed is None else speed / 10,
                wind_kt=None if wind is None else round(wind * MS_TO_KT),
                r34_km=round(sum(radii) / len(radii)) if radii else None,
            )
        )
    return fixes


def spelled(number: int) -> str:
    if number < 20:
        return ONES[number - 1]
    tens, ones = divmod(number, 10)
    return TENS[tens - 2] + (ONES[ones - 1] if ones else "")


def display_name(name: str, number: str) -> str:
    """The storm's name, or its number while the advisory only spells the number out."""
    compact = name.replace("-", "").upper()
    count = int(number[:2])
    if not compact or (count and len(compact) >= 3 and spelled(count).startswith(compact)):
        return number
    return name.title()


def _row(fix: Fix) -> dict[str, Any]:
    return {
        "time": fix.time,
        "lat": fix.lat,
        "lon": fix.lon,
        "wind_kt": fix.wind_kt,
        "r34_km": fix.r34_km,
        "heading": fix.heading,
        "speed_ms": fix.speed_ms,
    }


def _same_storm(storm: dict[str, Any], fix: Fix) -> bool:
    track = storm["track"]
    return bool(
        storm["number"] == fix.number
        and track[0]["time"] - SAME_STORM <= fix.time <= track[-1]["time"] + SAME_STORM
    )


def merge(
    previous: Iterable[Cyclone], fixes: Iterable[Fix], cycle: datetime | None, now: datetime
) -> list[Cyclone]:
    """Tracks with the new fixes added: a fix replaces the one at its time, an unknown or long
    silent number starts a storm, and storms silent for the retention leave."""
    storms = [c.model_dump() for c in previous]
    for fix in sorted(fixes, key=lambda x: x.time):
        row = _row(fix)
        storm = next((s for s in reversed(storms) if _same_storm(s, fix)), None)
        if storm is None:
            storm = {
                "id": f"{fix.time:%Y%m%d}-{fix.number.lower()}",
                "number": fix.number,
                "basin": fix.number[-1],
                "track": [],
            }
            storms.append(storm)
        track = [r for r in storm["track"] if r["time"] != fix.time]
        storm["track"] = sorted([*track, row], key=lambda r: r["time"])
        if storm["track"][-1] is row or "name" not in storm:
            storm["name"] = display_name(fix.name, fix.number)
            storm["agency"] = fix.agency
    kept = [s for s in storms if now - s["track"][-1]["time"] <= RETENTION]
    for storm in kept:
        last = storm["track"][-1]["time"]
        storm["active"] = cycle is not None and cycle - last < ACTIVE_CYCLES * CYCLE
    kept.sort(key=lambda s: (s["track"][0]["time"], s["number"]))
    return [Cyclone.model_validate(s) for s in kept]


def cycles(now: datetime, count: int) -> list[datetime]:
    """The latest advisory cycles at or before `now`, newest first."""
    start = now.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
    start -= timedelta(hours=start.hour % 6)
    return [start - i * CYCLE for i in range(count)]


def _cycle_dir(cycle: datetime) -> str:
    return f"{NOMADS}/gfs.{cycle:%Y%m%d}/{cycle:%H}/atmos/gfs.t{cycle:%H}z"


def vitals_url(cycle: datetime) -> str:
    return f"{_cycle_dir(cycle)}.syndata.tcvitals.tm00"


def marker_url(cycle: datetime) -> str:
    """A file every finished cycle has: without vitals next to it, no storm was followed."""
    return f"{_cycle_dir(cycle)}.pgrb2.1p00.anl.idx"


def http_get(url: str) -> str | None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body: bytes = response.read()
    except urllib.error.HTTPError as error:
        # NOMADS answers 403 for a file that does not exist yet.
        if error.code in (403, 404):
            return None
        raise
    return body.decode("ascii", errors="replace")


def read_cycles(times: list[datetime], fetch: Fetch) -> tuple[list[Fix], datetime | None]:
    """Fixes of the cycles published so far, and the newest of these cycles."""
    fixes: list[Fix] = []
    newest = None
    for cycle in times:
        text = fetch(vitals_url(cycle))
        if text is None and (newest is not None or fetch(marker_url(cycle)) is None):
            continue
        newest = newest or cycle
        fixes += parse_vitals(text or "")
    return fixes, newest


def read_feed(store: CatalogStore) -> CycloneFeed | None:
    body = store.get(PATH)
    return None if body is None else CycloneFeed.model_validate_json(body)


def update(
    store: CatalogStore,
    fetch: Fetch,
    now: datetime,
    *,
    read: int = READ_CYCLES,
    older: Iterable[Fix] = (),
    dry_run: bool = False,
) -> tuple[CycloneFeed, bool]:
    """Reads the latest cycles into the published feed; writes it only when it changed."""
    previous = read_feed(store)
    fixes, newest = read_cycles(cycles(now, read), fetch)
    if newest is None:
        raise RuntimeError(f"no advisory cycle found in the last {read * 6} h")
    known = previous.source_cycle if previous else None
    cycle = max(newest, known) if known else newest
    tracks = merge(previous.cyclones if previous else [], [*older, *fixes], cycle, now)
    if previous and previous.cyclones == tracks and known == cycle:
        return previous, False
    feed = CycloneFeed(
        schema_version=SCHEMA_VERSION,
        generated_at=now,
        attribution=ATTRIBUTION,
        source_cycle=cycle,
        cyclones=tracks,
    )
    if not dry_run:
        store.put(PATH, feed.model_dump_json().encode(), HEADERS)
    return feed, True


@asset(
    key=["feeds", "cyclones"],
    group_name="feeds",
    retry_policy=RetryPolicy(max_retries=2, delay=60, backoff=Backoff.EXPONENTIAL),
    description="Publishes `cyclones/tracks.json` to R2: tropical cyclone tracks, 60 days.",
)
def cyclones_feed(feed_bucket: FeedResource) -> MaterializeResult:  # type: ignore[type-arg]
    store = ObjectCatalogStore(feed_bucket.store())
    feed, written = update(store, http_get, datetime.now(UTC))
    assert feed.source_cycle is not None
    return MaterializeResult(
        metadata={
            "written": written,
            "source_cycle": feed.source_cycle.isoformat(),
            "active": sum(c.active for c in feed.cyclones),
            "tracked": len(feed.cyclones),
        }
    )


hourly_cyclones = define_asset_job("hourly_cyclones", selection=[cyclones_feed])
# Cycles come out near 02:40, 08:40, 14:40 and 20:40 UTC.
cyclones_schedule = ScheduleDefinition(
    job=hourly_cyclones,
    cron_schedule="50 * * * *",
    execution_timezone="UTC",
    default_status=DefaultScheduleStatus.RUNNING,
)

IBTRACS_BASIN = {"AL": "L", "EP": "E", "CP": "C", "WP": "W"}


def _ibtracs_letter(row: dict[str, str]) -> str | None:
    area = row["USA_ATCF_ID"][:2]
    if area == "IO":
        return "A" if row["SUBBASIN"] == "AS" else "B"
    if area == "SH":
        return "P" if row["BASIN"] == "SP" else "S"
    return IBTRACS_BASIN.get(area)


def parse_ibtracs(text: str) -> list[Fix]:
    """Six-hourly fixes of an IBTrACS v04r01 CSV, from its US agency columns."""
    lines = text.splitlines()
    fixes = []
    for row in csv.DictReader(io.StringIO("\n".join([lines[0], *lines[2:]]))):
        letter = _ibtracs_letter(row)
        time = datetime.strptime(row["ISO_TIME"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC)
        count = row["USA_ATCF_ID"][2:4]
        if letter is None or time.hour % 6 or time.minute or not row["USA_LAT"].strip():
            continue
        if not count.isdigit() or int(count) >= 90:
            continue
        speed = _number(row["STORM_SPEED"].strip())
        radii = [
            r for r in (_number(row[f"USA_R34_{q}"].strip()) for q in ("NE", "SE", "SW", "NW")) if r
        ]
        fixes.append(
            Fix(
                agency="NHC" if letter in "LEC" else "JTWC",
                number=count + letter,
                name="" if row["NAME"] in ("NOT_NAMED", "UNNAMED") else row["NAME"],
                time=time,
                lat=float(row["USA_LAT"]),
                lon=(float(row["USA_LON"]) + 180) % 360 - 180,
                heading=_number(row["STORM_DIR"].strip()),
                speed_ms=None if speed is None else round(speed / MS_TO_KT, 1),
                wind_kt=_number(row["USA_WIND"].strip()),
                r34_km=round(sum(radii) / len(radii) * NM_TO_KM) if radii else None,
            )
        )
    return fixes


def main() -> None:
    parser = argparse.ArgumentParser(description="Updates cyclones/tracks.json once.")
    parser.add_argument("--days", type=int, default=1, help="days of TC vitals to read again")
    parser.add_argument("--ibtracs", type=Path, help="IBTrACS CSV to fill older days from")
    parser.add_argument("--dry-run", action="store_true", help="print the feed, write nothing")
    args = parser.parse_args()
    bucket = os.environ.get("SCINTILLE_LIVE_BUCKET", "scintille-live")
    store = ObjectCatalogStore(live_store(bucket))
    feed, written = update(
        store,
        http_get,
        datetime.now(UTC),
        read=args.days * 4,
        older=parse_ibtracs(args.ibtracs.read_text()) if args.ibtracs else [],
        dry_run=args.dry_run,
    )
    if args.dry_run:
        print(feed.model_dump_json())
    else:
        print(f"{PATH}: {len(feed.cyclones)} cyclones, written={written}")


if __name__ == "__main__":
    main()
