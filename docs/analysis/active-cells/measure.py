"""Measurements behind ADR 0021: latency per layer, storm pipeline runs, live cell stability.

Read-only. Run it where the lake and Dagster settings are, the Dagster container on the VPS:

    docker compose exec -T -e MEASURE_OUT=/tmp/measure.json dagster-webserver python - < measure.py

The JSON goes to stdout and, after each section, to MEASURE_OUT. MEASURE_HOURS (72) bounds the
latency scan, MEASURE_SAMPLES (6) the hours replayed minute by minute, MEASURE_RUN_DAYS (7) the
Dagster run history. MEASURE_SECTIONS picks sections, MEASURE_STEPS the replay steps in minutes,
MEASURE_BUDGET (seconds) stops the replay from starting another hour, and MEASURE_NOW replays an
earlier day.
"""

import gzip
import hashlib
import json
import os
import sys
import time
import traceback
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
import polars as pl

HOUR = timedelta(hours=1)
NOW = datetime.fromisoformat(os.environ.get("MEASURE_NOW", datetime.now(UTC).isoformat()))
# One hour of margin, so the MTG LI files of the last hour have arrived.
END = NOW.replace(minute=0, second=0, microsecond=0) - HOUR
HOURS = int(os.environ.get("MEASURE_HOURS", "72"))
SAMPLES = int(os.environ.get("MEASURE_SAMPLES", "6"))
RUN_DAYS = int(os.environ.get("MEASURE_RUN_DAYS", "7"))
OUT = os.environ.get("MEASURE_OUT")
BACKFILL_LAG = 6 * 3600
STEPS = tuple(int(m) for m in os.environ.get("MEASURE_STEPS", "10,20,30,40,50,60,70,80").split(","))
SECTIONS = os.environ.get(
    "MEASURE_SECTIONS", "host,silver_commits,dagster,public,gold,silver,replay"
)
BUDGET = float(os.environ.get("MEASURE_BUDGET", "inf"))
LATE = (0, 5, 10, 15, 20, 25, 30, 60)
DEFAULT_READY = 30 * 60
TIME = pl.Datetime("us", "UTC")


def log(message: str) -> None:
    print(f"[{datetime.now(UTC):%H:%M:%S}] {message}", file=sys.stderr, flush=True)


def catalog() -> Any:
    path = os.environ.get("MEASURE_SQLITE")
    if path:
        from pyiceberg.catalog.sql import SqlCatalog

        return SqlCatalog("test", uri=f"sqlite:///{path}/catalog.db", warehouse=f"file://{path}")
    from scintille_lake.connect import pyiceberg_catalog

    return pyiceberg_catalog()


def between(column: str, lo: datetime, hi: datetime) -> str:
    return f"{column} >= '{lo.isoformat()}' AND {column} < '{hi.isoformat()}'"


def scan(table: Any, row_filter: str, fields: tuple[str, ...] | None = None) -> pl.DataFrame:
    kwargs: dict[str, Any] = {"row_filter": row_filter}
    if fields:
        kwargs["selected_fields"] = fields
    df = pl.from_arrow(table.scan(**kwargs).to_arrow())
    assert isinstance(df, pl.DataFrame)
    return df


def pct(values: Any, qs: tuple[float, ...] = (50, 90, 95, 99, 99.9)) -> dict[str, float] | None:
    a = np.asarray(values, dtype=np.float64)
    a = a[np.isfinite(a)]
    if a.size == 0:
        return None
    out: dict[str, float] = {f"p{q:g}": round(float(np.percentile(a, q)), 1) for q in qs}
    out["max"] = round(float(a.max()), 1)
    out["n"] = int(a.size)
    return out


def epoch(column: str) -> pl.Expr:
    return pl.col(column).dt.epoch("us") / 1e6


def batch_commits(table: Any) -> dict[str, float]:
    """Commit time (epoch seconds) of each batch recorded in the retained silver snapshots."""
    out: dict[str, float] = {}
    for snapshot in table.metadata.snapshots:
        summary = snapshot.summary
        value = summary.additional_properties.get("scintille.batch_ids") if summary else None
        for batch in (value or "").split(","):
            if batch:
                t = snapshot.timestamp_ms / 1000
                out[batch] = min(out.get(batch, t), t)
    return out


def files(cat: Any, batches: dict[str, float]) -> pl.DataFrame:
    """Product files of the window with delivery, reception and silver commit times."""
    lo = END - HOURS * HOUR - 2 * HOUR
    df = scan(
        cat.load_table(("bronze", "ingest_log")),
        between("product_start", lo, END + 2 * HOUR),
        ("key", "source", "product_start", "product_end", "received_at", "checksum", "status"),
    )
    ids = [
        hashlib.sha256(f"{k}|{c}".encode()).hexdigest()[:32]
        for k, c in zip(df["key"], df["checksum"], strict=True)
    ]
    committed = [batches.get(b) for b in ids]
    return df.with_columns(
        committed=pl.Series(committed, dtype=pl.Float64),
        product_end_s=epoch("product_end"),
        received_s=epoch("received_at"),
    )


def file_latency(df: pl.DataFrame) -> dict[str, Any]:
    live = df.filter(
        (pl.col("received_s") - pl.col("product_end_s") <= BACKFILL_LAG)
        & (pl.col("product_start") >= END - HOURS * HOUR)
        & (pl.col("product_start") < END)
    )
    out: dict[str, Any] = {"files": {}, "commit_matched": {}}
    for (source,), part in live.group_by(["source"]):
        delivered = (part["received_s"] - part["product_end_s"]).to_numpy()
        matched = part.filter(pl.col("committed").is_not_null())
        out["files"][source] = {
            "count": part.height,
            "received_after_product_end_s": pct(delivered),
            "committed_after_received_s": pct(
                (matched["committed"] - matched["received_s"]).to_numpy()
            ),
            "committed_after_product_end_s": pct(
                (matched["committed"] - matched["product_end_s"]).to_numpy()
            ),
            "product_seconds": pct(
                (part["product_end_s"] - epoch_series(part["product_start"])).to_numpy(), (50,)
            ),
        }
        out["commit_matched"][source] = round(matched.height / max(1, part.height), 4)
    return out


def epoch_series(s: pl.Series) -> pl.Series:
    return s.dt.epoch("us") / 1e6


def dagster_runs() -> dict[str, Any]:
    from dagster import AssetKey, DagsterEventType, DagsterInstance, RunsFilter

    instance = DagsterInstance.get()
    since = NOW - timedelta(days=RUN_DAYS)
    records = instance.get_run_records(filters=RunsFilter(created_after=since), limit=10000)
    storm_keys = {AssetKey(["gold", "storm_cells"]), AssetKey(["feeds", "storm_catalog"])}
    jobs: dict[str, dict[str, int]] = {}
    busy: dict[str, list[float]] = {}
    waits: dict[str, list[float]] = {}
    runs = []
    for record in records:
        run = record.dagster_run
        status = run.status.value
        jobs.setdefault(run.job_name, {}).setdefault(status, 0)
        jobs[run.job_name][status] += 1
        if record.start_time and record.end_time:
            busy.setdefault(run.job_name, []).append(record.end_time - record.start_time)
            waits.setdefault(run.job_name, []).append(
                record.start_time - record.create_timestamp.timestamp()
            )
        storm = set(run.asset_selection or ()) & storm_keys or run.job_name.startswith("__")
        if run.job_name != "hourly_storm_catalog" and not storm:
            continue
        tags = run.tags
        kind = (
            "schedule"
            if "dagster/schedule_name" in tags
            else "backfill"
            if "dagster/backfill" in tags
            else "manual"
        )
        steps = {
            s.step_key: {
                "start": s.start_time,
                "end": s.end_time,
                "status": s.status.value if s.status else None,
            }
            for s in instance.get_run_step_stats(run.run_id)
        }
        meta: dict[str, list[dict[str, Any]]] = {}
        for entry in instance.all_logs(run.run_id, of_type=DagsterEventType.ASSET_MATERIALIZATION):
            materialization = entry.asset_materialization
            if materialization is None:
                continue
            meta.setdefault("/".join(materialization.asset_key.path), []).append(
                {
                    k: getattr(v, "value", str(v))
                    for k, v in materialization.metadata.items()
                    if k != "hotspot_positions"
                }
            )
        runs.append(
            {
                "run_id": run.run_id,
                "job": run.job_name,
                "kind": kind,
                "status": status,
                "partition": tags.get("dagster/partition"),
                "range": [
                    tags.get("dagster/asset_partition_range_start"),
                    tags.get("dagster/asset_partition_range_end"),
                ],
                "created": record.create_timestamp.timestamp(),
                "start": record.start_time,
                "end": record.end_time,
                "steps": steps,
                "metadata": meta,
            }
        )
    return {
        "jobs": jobs,
        "job_duration_s": {job: pct(v, (50, 95)) for job, v in busy.items()},
        "job_queue_s": {job: pct(v, (50, 95)) for job, v in waits.items()},
        "busy_hours_per_day": round(sum(sum(v) for v in busy.values()) / 3600 / RUN_DAYS, 2),
        "summary": summarize_runs(runs),
        "tracked_at": tracked_at(runs),
        "recent": [compact(r) for r in sorted(runs, key=lambda r: r["created"])[-36:]],
    }


def compact(run: dict[str, Any]) -> dict[str, Any]:
    def span(step: dict[str, Any]) -> float | None:
        ok = step["start"] and step["end"]
        return round(step["end"] - step["start"], 1) if ok else None

    return {
        "kind": run["kind"],
        "status": run["status"],
        "partition": run["partition"] or run["range"],
        "start": datetime.fromtimestamp(run["start"], UTC).isoformat() if run["start"] else None,
        "duration_s": round(run["end"] - run["start"], 1) if run["start"] and run["end"] else None,
        "steps_s": {k: span(v) for k, v in run["steps"].items()},
        "metadata": run["metadata"],
    }


def summarize_runs(runs: list[dict[str, Any]]) -> dict[str, Any]:
    done = [r for r in runs if r["kind"] == "schedule" and r["status"] == "SUCCESS" and r["end"]]
    out: dict[str, Any] = {
        "scheduled": sum(r["kind"] == "schedule" for r in runs),
        "scheduled_success": len(done),
        "scheduled_failure": sum(
            r["kind"] == "schedule" and r["status"] == "FAILURE" for r in runs
        ),
        "duration_s": pct([r["end"] - r["start"] for r in done if r["start"]]),
        "queue_s": pct([r["start"] - r["created"] for r in done if r["start"]]),
    }
    boot, lag = [], []
    for r in done:
        starts = [s["start"] for s in r["steps"].values() if s["start"]]
        if starts and r["start"]:
            boot.append(min(starts) - r["start"])
        if r["partition"]:
            hour = datetime.strptime(r["partition"], "%Y-%m-%d-%H:%M").replace(tzinfo=UTC)
            lag.append(r["end"] - (hour + HOUR).timestamp())
    out["boot_s"] = pct(boot)
    out["end_after_partition_end_s"] = pct(lag)
    names = sorted({k for r in done for k in r["steps"]})
    out["steps_s"] = {
        k: pct(
            [
                r["steps"][k]["end"] - r["steps"][k]["start"]
                for r in done
                if k in r["steps"] and r["steps"][k]["start"] and r["steps"][k]["end"]
            ]
        )
        for k in names
    }
    return out


def tracked_at(runs: list[dict[str, Any]]) -> dict[str, float]:
    """End of the first successful run that tracked each hourly partition."""
    out: dict[str, float] = {}
    for r in runs:
        step = r["steps"].get("gold__storm_tracks")
        if r["partition"] and step and step["status"] == "SUCCESS" and step["end"]:
            out[r["partition"]] = min(out.get(r["partition"], step["end"]), step["end"])
    return out


def silver_latency(flashes: Any, commits: pl.DataFrame) -> dict[str, Any]:
    start = END - HOURS * HOUR
    lags: dict[str, list[np.ndarray]] = {}
    ages: dict[str, list[np.ndarray]] = {}
    hourly = []
    backfilled: dict[str, int] = {}
    lo = start
    while lo < END:
        hi = min(lo + 6 * HOUR, END)
        log(f"silver {lo:%m-%d %H}h to {hi:%m-%d %H}h")
        df = scan(
            flashes,
            between("event_time", lo, hi),
            ("source", "product_file", "event_time", "ingest_time"),
        ).with_columns(
            lag=(pl.col("ingest_time") - pl.col("event_time")).dt.total_microseconds() / 1e6,
            hour=pl.col("event_time").dt.truncate("1h"),
            ingest=epoch("ingest_time"),
            event=epoch("event_time"),
        )
        for (source,), part in df.filter(pl.col("lag") > BACKFILL_LAG).group_by(["source"]):
            backfilled[str(source)] = backfilled.get(str(source), 0) + part.height
        live = (
            df.filter(pl.col("lag") <= BACKFILL_LAG)
            .join(commits, left_on="product_file", right_on="key", how="left")
            .drop("product_file")
        )
        for (source,), part in live.group_by(["source"]):
            lags.setdefault(str(source), []).append(part["lag"].to_numpy().astype(np.float32))
            age = (part["committed"] - part["event"]).to_numpy()
            ages.setdefault(str(source), []).append(age.astype(np.float32))
        hour_end = epoch("hour") + 3600
        hourly.append(
            live.group_by("hour", "source").agg(
                pl.len().alias("flashes"),
                pl.col("committed").is_null().sum().alias("uncommitted"),
                *(
                    (pl.col("ingest") > hour_end + 60 * m).sum().alias(f"received_after_{m}m")
                    for m in LATE
                ),
                *(
                    (pl.col("committed") > hour_end + 60 * m).sum().alias(f"silver_after_{m}m")
                    for m in LATE
                ),
            )
        )
        lo = hi
    out: dict[str, Any] = {"window": [start.isoformat(), END.isoformat()], "backfilled": backfilled}
    out["event_to_received_s"] = {s: pct(np.concatenate(v)) for s, v in lags.items()}
    out["event_to_silver_s"] = {s: pct(np.concatenate(v)) for s, v in ages.items()}
    per_hour = pl.concat(hourly) if hourly else pl.DataFrame()
    if per_hour.height:
        totals = per_hour.group_by("source").agg(pl.exclude("hour").sum()).sort("source")
        out["late_share"] = {
            row["source"]: {
                k: round(v / row["flashes"], 5)
                for k, v in row.items()
                if k.endswith("m") or k == "uncommitted"
            }
            for row in totals.iter_rows(named=True)
        }
        out["flashes_per_hour"] = {
            str(s): pct(part["flashes"].to_numpy(), (50, 95))
            for (s,), part in per_hour.group_by(["source"])
        }
        out["flashes_per_hour_all"] = pct(
            per_hour.group_by("hour").agg(pl.col("flashes").sum())["flashes"].to_numpy(), (50, 95)
        )
    return out


def silver_commits(batches: dict[str, float]) -> dict[str, Any]:
    times = sorted(set(round(t) for t in batches.values()))
    recent = np.asarray([t for t in times if t >= (END - HOURS * HOUR).timestamp()])
    gaps = pl.DataFrame({"t": times[1:], "gap": np.diff(times)}).with_columns(
        day=pl.from_epoch("t", "s").dt.date()
    )
    per_day = gaps.group_by("day").agg(pl.col("gap").median().round(), pl.len()).sort("day")
    return {
        "batches": len(batches),
        "commits": len(times),
        "first": datetime.fromtimestamp(times[0], UTC).isoformat() if times else None,
        "interval_s": pct(np.diff(recent), (50, 90, 95, 99)) if len(recent) > 1 else None,
        "interval_p50_per_day": {str(d): [g, n] for d, g, n in per_day.iter_rows()},
    }


def gold_volume(cat: Any) -> dict[str, Any]:
    start = END - HOURS * HOUR
    window = between("window_start", start, END)
    tracks_table = cat.load_table(("gold", "storm_tracks"))
    last = scan(tracks_table, "true", ("window_start",))["window_start"].max()
    assert isinstance(last, datetime)
    tracked_end = min(END, last + HOUR)
    tracked = between("window_start", tracked_end - HOURS * HOUR, tracked_end)
    cells = scan(
        cat.load_table(("gold", "storm_cells")),
        window,
        ("cell_id", "window_start", "flash_count", "hour_flash_count", "area_km2", "hull"),
    ).with_columns(
        vertices=pl.col("hull").str.count_matches(",").cast(pl.Int64),
        hull_bytes=pl.col("hull").str.len_bytes(),
    )
    tracks = scan(
        tracks_table,
        tracked,
        (
            "storm_id",
            "window_start",
            "previous_cell_id",
            "split_from",
            "merged",
            "hour_flash_count",
        ),
    )
    levels = scan(cat.load_table(("gold", "storm_levels")), "true", ("storm_id", "level"))
    per_window = (
        tracks.join(levels, on="storm_id", how="left")
        .group_by("window_start")
        .agg(
            pl.len().alias("storms"),
            pl.col("previous_cell_id").is_null().sum().alias("new"),
            pl.col("split_from").is_not_null().sum().alias("splits"),
            pl.col("merged").list.len().sum().alias("merged"),
            (pl.col("level") >= 2).sum().alias("level_2_plus"),
            (pl.col("level") >= 3).sum().alias("level_3_plus"),
            (pl.col("hour_flash_count") >= 100).sum().alias("hour_flashes_100_plus"),
        )
    )
    storms = scan(
        cat.load_table(("gold", "storms")),
        between("storm_start", tracked_end - HOURS * HOUR, tracked_end),
        ("storm_id", "steps", "flash_count", "closed"),
    ).join(levels, on="storm_id", how="left")
    closed = storms.filter(pl.col("closed"))
    return {
        "tracked_until": tracked_end.isoformat(),
        "windows": per_window.height,
        "per_window": {c: pct(per_window[c].to_numpy(), (50, 95)) for c in per_window.columns[1:]},
        "cells_per_window": pct(cells.group_by("window_start").len()["len"].to_numpy(), (50, 95)),
        "hull_vertices": pct(cells["vertices"].to_numpy(), (50, 95, 99)),
        "hull_bytes": pct(cells["hull_bytes"].to_numpy(), (50, 95, 99)),
        "storm_steps": pct(closed["steps"].to_numpy(), (50, 90, 99)),
        "storm_steps_level_3_plus": pct(
            closed.filter(pl.col("level") >= 3)["steps"].to_numpy(), (50, 90, 99)
        ),
        "storms": storms.height,
        "level_counts": {str(k): v for k, v in storms.group_by("level").len().iter_rows()},
    }


def cluster(window: pl.DataFrame, hour: datetime, spots: pl.DataFrame) -> tuple[Any, pl.DataFrame]:
    """Label per row of `window` (-1 noise) and the cells of `hour`, as `hour_cells` builds them."""
    from scintille_pipelines.clustering import st_dbscan, summarize
    from scintille_pipelines.hotspots import drop_hotspots
    from scintille_pipelines.storm_cells import StormCellsConfig

    config = StormCellsConfig()
    kept = drop_hotspots(window, spots, config.rule.radius_km)
    t = kept["event_time"].dt.epoch("us").to_numpy() / 1e6
    labels = st_dbscan(kept["lat"].to_numpy(), kept["lon"].to_numpy(), t, config.params)
    cells = summarize(kept, labels, hour, hour + HOUR, config.params)
    counted = (labels >= 0) & (t >= hour.timestamp())
    own = np.bincount(labels[counted], minlength=cells.height)
    cells = cells.with_columns(
        label=pl.int_range(pl.len(), dtype=pl.Int64),
        hour_flash_count=pl.Series(own, dtype=pl.Int64),
    ).filter(pl.col("t_end") >= hour)
    rows = pl.DataFrame({"row": kept["row"], "label": labels})
    full = window.select("row").join(rows, on="row", how="left").fill_null(-1)
    return full["label"].to_numpy(), cells


def link_cells(prev: pl.DataFrame, cells: pl.DataFrame) -> pl.DataFrame:
    from scintille_pipelines.tracking import TrackParams, link

    labels = dict(zip(cells["cell_id"], cells["label"], strict=True))
    tracks = link(prev, cells.drop("label"), TrackParams(100.0, 30.0))
    return tracks.with_columns(
        label=pl.col("cell_id").replace_strict(labels, return_dtype=pl.Int64)
    )


def snapshot(window: pl.DataFrame, labels: Any, tracks: pl.DataFrame) -> bytes:
    """A candidate active-cell document: per storm, a light hull and 10-minute slices."""
    flashes = window.with_columns(label=pl.Series(labels)).filter(pl.col("label") >= 0)
    slices = (
        flashes.group_by("label", pl.col("event_time").dt.truncate("10m").alias("t"))
        .agg(pl.col("lat").mean().round(3), pl.col("lon").mean().round(3), pl.len().alias("n"))
        .sort("label", "t")
    )
    by_label: dict[int, list[list[Any]]] = {}
    for row in slices.iter_rows(named=True):
        by_label.setdefault(row["label"], []).append(
            [row["t"].strftime("%H:%M"), row["lat"], row["lon"], row["n"]]
        )
    items = []
    for row in tracks.iter_rows(named=True):
        ring = row["hull"][row["hull"].index("((") + 2 : row["hull"].rindex("))")].split(",")
        step = max(1, len(ring) // 24)
        hull = [[round(float(c), 3) for c in p.split()] for p in ring[::step]]
        items.append(
            {
                "id": row["storm_id"],
                "cell": row["cell_id"],
                "split_from": row["split_from"],
                "merged": row["merged"],
                "t_start": row["t_start"].isoformat(),
                "t_end": row["t_end"].isoformat(),
                "flashes": row["hour_flash_count"],
                "lat": round(row["lat"], 3),
                "lon": round(row["lon"], 3),
                "bbox": [round(row[k], 3) for k in ("west", "south", "east", "north")],
                "hull": hull,
                "slices": by_label.get(row["label"], []),
            }
        )
    return json.dumps({"cells": items}, separators=(",", ":")).encode()


def compare(
    labels: Any,
    tracks: pl.DataFrame,
    final_labels: Any,
    final: pl.DataFrame,
    published: set[str],
) -> dict[str, Any]:
    """Storms seen at a partial time against the storms of the complete window."""
    both = pl.DataFrame({"p": labels, "f": final_labels})
    pairs = (
        both.filter((pl.col("p") >= 0) & (pl.col("f") >= 0))
        .group_by("p", "f")
        .len()
        .sort("len", descending=True)
        .unique("p", keep="first")
    )
    best = dict(zip(pairs["p"], pairs["f"], strict=True))
    final_id = dict(zip(final["label"], final["storm_id"], strict=True))
    counts = {"stable": 0, "renamed_new": 0, "renamed_continuing": 0, "orphan": 0}
    weights = {"stable": 0, "all": 0, "published_stable": 0, "published_all": 0}
    for row in tracks.iter_rows(named=True):
        target = final_id.get(best.get(row["label"], -2))
        weight = row["hour_flash_count"] or 0
        weights["all"] += weight
        if target in published:
            weights["published_all"] += weight
        if target is None:
            counts["orphan"] += 1
        elif target == row["storm_id"]:
            counts["stable"] += 1
            weights["stable"] += weight
            if target in published:
                weights["published_stable"] += weight
        elif row["previous_cell_id"] is None:
            counts["renamed_new"] += 1
        else:
            counts["renamed_continuing"] += 1
    detectable = (both.filter((pl.col("f") >= 0) & (pl.col("p") > -2)).group_by("f").len()).filter(
        pl.col("len") >= 10
    )
    seen = {final_id[f] for f in detectable["f"] if f in final_id}
    ids = set(tracks["storm_id"])
    return {
        "partial_storms": tracks.height,
        **counts,
        "stable_flash_share": round(weights["stable"] / weights["all"], 4)
        if weights["all"]
        else None,
        "published_stable_flash_share": round(
            weights["published_stable"] / weights["published_all"], 4
        )
        if weights["published_all"]
        else None,
        "final_detectable": len(seen),
        "final_detectable_with_final_id": len(seen & ids),
        "published_detectable": len(seen & published),
        "published_detectable_with_final_id": len(seen & published & ids),
    }


def replay(
    cat: Any,
    flashes: Any,
    commits: pl.DataFrame,
    ready: dict[str, float],
    flush: Callable[[dict[str, Any]], None],
) -> Any:
    from scintille_pipelines.storm_cells import StormCellsConfig, scan_hotspots
    from scintille_pipelines.tracking import TRACK_SCHEMA

    config = StormCellsConfig()
    overlap = timedelta(minutes=config.overlap_minutes)
    tracks_table = cat.load_table(("gold", "storm_tracks"))
    levels = scan(cat.load_table(("gold", "storm_levels")), "true", ("storm_id", "level"))
    published = set(levels.filter(pl.col("level") >= 3)["storm_id"])
    timings: dict[str, Any] = {}
    t0 = time.perf_counter()
    spots = scan_hotspots(flashes, END, config.rule)
    timings["hotspot_scan_s"] = round(time.perf_counter() - t0, 1)
    timings["hotspots"] = spots.height

    def gold(lo: datetime) -> pl.DataFrame:
        df = scan(tracks_table, between("window_start", lo, lo + HOUR))
        return df.select(TRACK_SCHEMA.names()).cast(TRACK_SCHEMA)

    span = max(1, 24 // SAMPLES)
    hours = [END - HOUR - k * span * HOUR for k in range(SAMPLES)]
    samples: list[dict[str, Any]] = []
    started = time.perf_counter()
    for hour in hours:
        flush({"timings": timings, "samples": samples})
        if time.perf_counter() - started > BUDGET:
            samples.append({"hour": hour.isoformat(), "skipped": "budget"})
            continue
        log(f"replay {hour:%m-%d %H}h")
        t0 = time.perf_counter()
        both = scan(
            flashes,
            between("event_time", hour - HOUR - overlap, hour + HOUR),
            ("flash_id", "source", "product_file", "event_time", "ingest_time", "lat", "lon"),
        )
        read_s = time.perf_counter() - t0
        lag = (pl.col("ingest_time") - pl.col("event_time")).dt.total_microseconds() / 1e6
        if both.filter(lag > BACKFILL_LAG).height > 0.01 * max(1, both.height):
            samples.append({"hour": hour.isoformat(), "skipped": "backfilled"})
            continue
        both = (
            both.join(commits, left_on="product_file", right_on="key", how="left")
            .drop("product_file")
            .sort("event_time", "flash_id")
            .with_columns(ingest=epoch("ingest_time"))
        )
        previous = both.filter(pl.col("event_time") < hour)
        window = both.filter(pl.col("event_time") >= hour - overlap)
        window = window.with_columns(row=pl.int_range(pl.len(), dtype=pl.Int64))
        previous = previous.with_columns(row=pl.int_range(pl.len(), dtype=pl.Int64))
        before, prev, current = gold(hour - 2 * HOUR), gold(hour - HOUR), gold(hour)
        if prev.is_empty() or current.is_empty():
            samples.append({"hour": hour.isoformat(), "skipped": "not tracked"})
            continue
        key = (hour - HOUR).strftime("%Y-%m-%d-%H:%M")
        prev_ready = ready.get(key, (hour + timedelta(seconds=DEFAULT_READY)).timestamp())
        t0 = time.perf_counter()
        final_labels, final_cells = cluster(window, hour, spots)
        final = link_cells(prev, final_cells)
        sample: dict[str, Any] = {
            "hour": hour.isoformat(),
            "window_flashes": window.height,
            "read_s": round(read_s, 1),
            "full_compute_s": round(time.perf_counter() - t0, 2),
            "previous_hour_tracked_after_s": round(prev_ready - hour.timestamp()),
            "cells": final.height,
            "gold_cells": current.height,
            "gold_storm_ids_matched": len(set(final["storm_id"]) & set(current["storm_id"])),
            "steps": {},
        }
        for model in ("committed", "ingest"):
            for minutes in STEPS:
                t = hour + timedelta(minutes=minutes)
                ready_at = pl.col(model) <= t.timestamp()
                part = window.filter(ready_at & (pl.col("event_time") < t))
                if part.is_empty():
                    continue
                t0 = time.perf_counter()
                link_from = prev
                if t.timestamp() < prev_ready:
                    older = previous.filter(ready_at)
                    _, older_cells = cluster(older, hour - HOUR, spots)
                    link_from = link_cells(before, older_cells).drop("label")
                labels_part, cells = cluster(part, hour, spots)
                tracks = link_cells(link_from, cells)
                compute_s = time.perf_counter() - t0
                labels = np.full(window.height, -2)
                labels[part["row"].to_numpy()] = labels_part
                result = compare(labels, tracks, final_labels, final, published)
                result["compute_s"] = round(compute_s, 2)
                result["flashes"] = part.height
                result["own_previous_hour"] = t.timestamp() < prev_ready
                newest = part.group_by("source").agg(pl.col("event_time").max())
                result["newest_age_s"] = {
                    r["source"]: round((t - r["event_time"]).total_seconds())
                    for r in newest.iter_rows(named=True)
                }
                if minutes in (30, 60) and model == "committed":
                    body = snapshot(part, labels_part, tracks)
                    keep = tracks.filter(
                        pl.col("storm_id").is_in(list(published))
                        | (pl.col("hour_flash_count") >= 100)
                    )
                    light = snapshot(part, labels_part, keep)
                    result["snapshot_bytes"] = len(body)
                    result["snapshot_gzip"] = len(gzip.compress(body, 6))
                    result["snapshot_selected_storms"] = keep.height
                    result["snapshot_selected_gzip"] = len(gzip.compress(light, 6))
                sample["steps"][f"{model}+{minutes}"] = result
        samples.append(sample)
    return {"timings": timings, "samples": samples}


def public_feed() -> dict[str, Any]:
    import obstore
    from obstore.store import S3Store

    store = S3Store(
        os.environ.get("SCINTILLE_LIVE_BUCKET", "scintille-live"),
        endpoint=os.environ["SCINTILLE_R2_ENDPOINT"],
        access_key_id=os.environ["SCINTILLE_R2_ACCESS_KEY_ID"],
        secret_access_key=os.environ["SCINTILLE_R2_SECRET_ACCESS_KEY"],
        region="auto",
        virtual_hosted_style_request=False,
    )

    def get(path: str) -> Any:
        try:
            return json.loads(obstore.get(store, path).bytes().to_bytes())
        except FileNotFoundError:
            return None

    def when(stamp: str | None) -> datetime | None:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")) if stamp else None

    def age(stamp: str | None) -> float | None:
        moment = when(stamp)
        return round((NOW - moment).total_seconds()) if moment else None

    out: dict[str, Any] = {}
    manifest = get("live/manifest.json") or {}
    out["manifest"] = {
        "generated_age_s": age(manifest.get("generated_at")),
        "chunks": len(manifest.get("chunks", [])),
        "sources": manifest.get("sources"),
    }
    metrics = get("live/metrics.json") or {}
    out["metrics"] = {k: metrics.get(k) for k in ("generated_at", "freshness", "sources")}
    index = get("storms/index/0.json") or {}
    out["index"] = {
        "published_age_s": age(index.get("published_at")),
        "last_observation_age_s": age(index.get("last_observation_time")),
        "total_storms": index.get("total_storms"),
    }
    details = []
    for summary in (index.get("storms") or [])[:20]:
        detail = get(f"storms/{summary['slug']}.json")
        published, observed = when(detail and detail["published_at"]), None
        if detail:
            observed = when(detail["last_observation_time"])
        if detail and published and observed:
            details.append(
                {
                    "closed": detail["storm"].get("closed"),
                    "published_after_last_observation_s": round(
                        (published - observed).total_seconds()
                    ),
                    "last_observation_age_s": round((NOW - observed).total_seconds()),
                }
            )
    out["recent_details"] = details
    highlights = get("storms/highlights.json") or {}
    out["highlights_published_age_s"] = age(highlights.get("published_at"))
    return out


def host() -> dict[str, Any]:
    out: dict[str, Any] = {"cpus": os.cpu_count(), "loadavg": os.getloadavg()}
    with open("/proc/meminfo") as f:
        for line in f:
            key, value = line.split(":", 1)
            if key in ("MemTotal", "MemAvailable"):
                out[key] = value.strip()
    for path in ("/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/memory.max"):
        if os.path.exists(path):
            with open(path) as f:
                out[path] = f.read().strip()
    return out


def dump(results: dict[str, Any]) -> None:
    if OUT:
        with open(OUT, "w") as f:
            json.dump(results, f, default=str, indent=1)


def section(results: dict[str, Any], name: str, fn: Callable[[], Any]) -> None:
    if name not in SECTIONS.split(","):
        return
    log(f"start {name}")
    t0 = time.perf_counter()
    try:
        results[name] = fn()
    except Exception:
        results[name] = {"error": traceback.format_exc()}
    log(f"done {name} in {time.perf_counter() - t0:.0f} s")
    dump(results)


def main() -> None:
    from scintille_lake.tables import FLASHES

    results: dict[str, Any] = {"now": NOW.isoformat(), "end": END.isoformat(), "hours": HOURS}
    cat = catalog()
    flashes = cat.load_table(FLASHES.identifier)
    batches = batch_commits(flashes)
    commits = pl.DataFrame(schema={"key": pl.String(), "committed": pl.Float64()})
    section(results, "host", host)
    section(results, "silver_commits", lambda: silver_commits(batches))
    section(results, "dagster", dagster_runs)
    section(results, "public", public_feed)
    section(results, "gold", lambda: gold_volume(cat))
    try:
        table = files(cat, batches)
        results["files"] = file_latency(table)
        commits = (
            table.filter(pl.col("committed").is_not_null())
            .group_by(pl.col("key").str.split("/").list.last())
            .agg(pl.col("committed").min())
        )
    except Exception:
        results["files"] = {"error": traceback.format_exc()}
    section(results, "silver", lambda: silver_latency(flashes, commits))
    ready = results.get("dagster", {}).get("tracked_at", {})

    def partial(value: dict[str, Any]) -> None:
        results["replay"] = value
        dump(results)

    section(results, "replay", lambda: replay(cat, flashes, commits, ready, partial))
    json.dump(results, sys.stdout, default=str, indent=1)
    print()


if __name__ == "__main__":
    main()
