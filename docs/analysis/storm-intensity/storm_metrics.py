"""Inputs of storm-intensity.ipynb: storms of a month and per-storm measures.

Runs the functions of gold/storm_cells, gold/storm_tracks and gold/storms with default parameters,
with and without the fixed hot spot filter, outside Dagster. Writes only under STORM_ANALYSIS_DIR
(parquet, plus a SQLite catalog); silver is read once through the SCINTILLE_LAKE_* catalog.

    uv run python storm_metrics.py export|cells|tracks|metrics|catalog
"""

import os
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, date, datetime, timedelta

import numpy as np
import polars as pl
from scintille_pipelines.clustering import st_dbscan, summarize
from scintille_pipelines.hotspots import drop_hotspots, fixed_hotspots
from scintille_pipelines.storm_cells import StormCellsConfig, range_cells
from scintille_pipelines.storms import StormTracksConfig
from scintille_pipelines.tracking import TRACK_SCHEMA, summarize_storms, track_range

T = os.environ["STORM_ANALYSIS_DIR"]
FIRST, LAST = date(2026, 9, 8), date(2026, 10, 8)
CFG = StormCellsConfig()
OVERLAP = timedelta(minutes=CFG.overlap_minutes)


def export() -> None:
    from scintille_lake.connect import pyiceberg_catalog
    from scintille_lake.tables import FLASHES

    table = pyiceberg_catalog().load_table(FLASHES.identifier)
    os.makedirs(f"{T}/silver", exist_ok=True)
    d = FIRST
    while d <= LAST:
        s = datetime(d.year, d.month, d.day, tzinfo=UTC)
        e = s + timedelta(days=1)
        span = f"event_time >= '{s.isoformat()}' AND event_time < '{e.isoformat()}'"
        cols = ("flash_id", "source", "event_time", "lat", "lon", "energy_raw")
        df = pl.from_arrow(table.scan(row_filter=span, selected_fields=cols).to_arrow())
        assert isinstance(df, pl.DataFrame)
        if df.height:
            df.write_parquet(f"{T}/silver/{d}.parquet")
        d += timedelta(days=1)


def days() -> list[date]:
    out, d = [], FIRST
    while d <= LAST:
        if os.path.exists(f"{T}/silver/{d}.parquet"):
            out.append(d)
        d += timedelta(days=1)
    return out


def load(d: date, with_previous: bool) -> pl.DataFrame:
    frames = []
    for x in ([d - timedelta(days=1)] if with_previous else []) + [d]:
        p = f"{T}/silver/{x}.parquet"
        if os.path.exists(p):
            frames.append(pl.read_parquet(p))
    return pl.concat(frames).sort("event_time")


def hour_cells_members(flashes, hour, rule):
    """`storm_cells.hour_cells`, plus the in-hour flashes of each cell."""
    params = CFG.params
    end = hour + timedelta(hours=1)
    window = flashes.filter(pl.col("event_time").is_between(hour - OVERLAP, end, closed="left"))
    if rule is not None:
        window = drop_hotspots(window, fixed_hotspots(flashes, end, rule), rule.radius_km)
    t = window["event_time"].dt.epoch("us").to_numpy() / 1e6
    labels = st_dbscan(window["lat"].to_numpy(), window["lon"].to_numpy(), t, params)
    cells = summarize(window, labels, hour, end, params)
    in_hour = (labels >= 0) & (t >= hour.timestamp())
    own = np.bincount(labels[in_hour], minlength=cells.height)
    cells = cells.with_columns(hour_flash_count=pl.Series(own, dtype=pl.Int64))
    members = (
        window.filter(pl.Series(in_hour))
        .select("source", "event_time", "energy_raw")
        .with_columns(cell_id=cells["cell_id"].gather(labels[in_hour]))
    )
    return cells.filter(pl.col("t_end") >= hour), members


def cells_for_day(args):
    d, mode = args
    rule = CFG.rule if mode == "filtered" else None
    flashes = load(d, with_previous=True)
    start = datetime(d.year, d.month, d.day, tzinfo=UTC)
    cells, members = [], []
    for h in range(24):
        c, m = hour_cells_members(flashes, start + timedelta(hours=h), rule)
        cells.append(c)
        members.append(m)
    cells_df = pl.concat(cells)
    if d == FIRST:
        ref = range_cells(flashes, start, start + timedelta(hours=2), OVERLAP, CFG.params, rule)
        assert ref.equals(cells_df.filter(pl.col("window_start") < start + timedelta(hours=2)))
    os.makedirs(f"{T}/out/{mode}", exist_ok=True)
    cells_df.write_parquet(f"{T}/out/{mode}/cells-{d}.parquet")
    pl.concat(members).write_parquet(f"{T}/out/{mode}/members-{d}.parquet")
    hotspots = fixed_hotspots(flashes, start + timedelta(days=1), CFG.rule)
    removed = (
        flashes.filter(pl.col("event_time") >= start).height
        - drop_hotspots(
            flashes.filter(pl.col("event_time") >= start), hotspots, CFG.rule.radius_km
        ).height
    )
    return d, cells_df.height, hotspots.height, removed


def bounds_energy_for_day(d: date) -> pl.DataFrame:
    """Energy and count of silver flashes inside each track row's bbox and in-hour time range."""
    tracks = pl.read_parquet(f"{T}/out/filtered/tracks.parquet").filter(
        pl.col("window_start").dt.date() == d
    )
    flashes = load(d, with_previous=False)
    t = flashes["event_time"].dt.epoch("us").to_numpy()
    lat, lon, e = (flashes[c].to_numpy() for c in ("lat", "lon", "energy_raw"))
    out = []
    for r in tracks.select(
        "window_start", "cell_id", "t_start", "t_end", "west", "south", "east", "north"
    ).iter_rows(named=True):
        t0 = max(r["t_start"], r["window_start"]).timestamp() * 1e6
        t1 = min(r["t_end"], r["window_start"] + timedelta(hours=1)).timestamp() * 1e6
        i, j = np.searchsorted(t, t0, "left"), np.searchsorted(t, t1, "right")
        la, lo = lat[i:j], lon[i:j]
        inside = (la >= r["south"]) & (la <= r["north"])
        if r["west"] <= r["east"]:
            inside &= (lo >= r["west"]) & (lo <= r["east"])
        else:
            inside &= (lo >= r["west"]) | (lo <= r["east"])
        out.append((r["cell_id"], int(inside.sum()), float(e[i:j][inside].sum())))
    return pl.DataFrame(out, schema=["cell_id", "bounds_flashes", "bounds_energy"], orient="row")


def track_and_summarize(mode: str) -> None:
    cells = pl.concat(pl.read_parquet(f"{T}/out/{mode}/cells-{d}.parquet") for d in days())
    start = datetime(FIRST.year, FIRST.month, FIRST.day, tzinfo=UTC)
    end = datetime(LAST.year, LAST.month, LAST.day, tzinfo=UTC) + timedelta(days=1)
    prev = pl.DataFrame(schema=TRACK_SCHEMA)
    params = StormTracksConfig().params
    tracks = track_range(prev, cells, start, end, params).with_columns(params=pl.lit(str(params)))
    tracks.write_parquet(f"{T}/out/{mode}/tracks.parquet")
    storms = summarize_storms(tracks, end - timedelta(hours=1))
    storms.write_parquet(f"{T}/out/{mode}/storms.parquet")
    cells.write_parquet(f"{T}/out/{mode}/cells.parquet")
    print(mode, "cells", cells.height, "storms", storms.height, flush=True)


def metrics(mode: str, bounds: pl.DataFrame | None) -> None:
    tracks = pl.read_parquet(f"{T}/out/{mode}/tracks.parquet")
    storms = pl.read_parquet(f"{T}/out/{mode}/storms.parquet")
    members = pl.concat(
        pl.read_parquet(f"{T}/out/{mode}/members-{d}.parquet") for d in days()
    ).join(tracks.select("cell_id", "storm_id"), on="cell_id")
    exact = members.group_by("storm_id").agg(
        pl.col("energy_raw").sum().alias("energy_exact_j"), pl.len().alias("member_flashes")
    )
    if "source" not in members.columns:
        members = members.with_columns(source=pl.lit("?"))
    by_source = (
        members.group_by("storm_id", "source")
        .agg(pl.len().alias("n"), pl.col("energy_raw").sum().alias("e"))
        .group_by("storm_id")
        .agg(
            pl.col("n").max().alias("flash_count_one_source"),
            pl.col("e").max().alias("energy_one_source_j"),
        )
    )
    exact = exact.join(by_source, on="storm_id")
    src_min = members.group_by("storm_id", "source", pl.col("event_time").dt.truncate("1m")).len()
    peak_src = src_min.group_by("storm_id").agg(pl.col("len").max().alias("peak_rate_one_source"))
    exact = exact.join(peak_src, on="storm_id")
    per_min = members.group_by("storm_id", pl.col("event_time").dt.truncate("1m")).len()
    per_10 = members.group_by("storm_id", pl.col("event_time").dt.truncate("10m")).len()
    peak = (
        per_min.group_by("storm_id")
        .agg(pl.col("len").max().alias("peak_rate_per_min"))
        .join(
            per_10.group_by("storm_id").agg((pl.col("len").max() / 10).alias("peak_rate_10min")),
            on="storm_id",
        )
    )
    out = (
        storms.select(
            "storm_id",
            "storm_start",
            "t_start",
            "t_end",
            "closed",
            "steps",
            "flash_count",
            "max_cell_flashes",
            "max_area_km2",
            "lat",
            "lon",
            "sources",
            "split_from",
        )
        .with_columns(
            duration_min=(pl.col("t_end") - pl.col("t_start")).dt.total_seconds() / 60,
            satellite=pl.when(pl.col("sources").list.len() > 1)
            .then(pl.lit("both"))
            .otherwise(pl.col("sources").list.first()),
        )
        .join(exact, on="storm_id", how="left")
        .join(peak, on="storm_id", how="left")
    )
    if bounds is not None:
        b = (
            bounds.join(tracks.select("cell_id", "storm_id"), on="cell_id")
            .group_by("storm_id")
            .agg(
                pl.col("bounds_energy").sum().alias("energy_j"),
                pl.col("bounds_flashes").sum().alias("bounds_flashes"),
            )
        )
        out = out.join(b, on="storm_id", how="left")
    out.drop("sources").write_parquet(f"{T}/out/{mode}/storm_metrics.parquet")
    print(mode, "metrics", out.height, flush=True)


def to_catalog() -> None:
    from pyiceberg.catalog.sql import SqlCatalog
    from scintille_lake.migrate import sync_table
    from scintille_pipelines.storm_cells import STORM_CELLS
    from scintille_pipelines.storms import STORM_TRACKS, STORMS

    os.makedirs(f"{T}/warehouse", exist_ok=True)
    cat = SqlCatalog("t71", uri=f"sqlite:///{T}/catalog.db", warehouse=f"file://{T}/warehouse")
    cat.create_namespace_if_not_exists("gold")
    tracks = pl.read_parquet(f"{T}/out/filtered/tracks.parquet")
    storms = pl.read_parquet(f"{T}/out/filtered/storms.parquet").join(
        tracks.group_by("storm_id").agg(pl.col("params").first()), on="storm_id"
    )
    for tdef, name in ((STORM_CELLS, "cells"), (STORM_TRACKS, "tracks"), (STORMS, None)):
        sync_table(cat, tdef)
        table = cat.load_table(tdef.identifier)
        df = storms if name is None else pl.read_parquet(f"{T}/out/filtered/{name}.parquet")
        table.overwrite(df.to_arrow().cast(table.schema().as_arrow()))
        print("catalog", tdef.identifier, df.height, flush=True)


if __name__ == "__main__":
    step = sys.argv[1]
    if step == "export":
        export()
    elif step == "cells":
        modes = sys.argv[2:] or ["filtered", "unfiltered"]
        jobs = [(d, m) for m in modes for d in days()]
        with ProcessPoolExecutor(7) as pool:
            rows = list(pool.map(cells_for_day, jobs))
        stats = pl.DataFrame(
            [(d, m, c, h, r) for (d, c, h, r), (_, m) in zip(rows, jobs, strict=True)],
            schema=["day", "mode", "cells", "hotspots", "removed_flashes"],
            orient="row",
        )
        if len(modes) == 2:
            stats.write_parquet(f"{T}/out/day_stats.parquet")
        print(stats.group_by("mode").agg(pl.col("cells", "removed_flashes").sum()))
    elif step == "tracks":
        for m in ("filtered", "unfiltered"):
            track_and_summarize(m)
    elif step == "metrics":
        with ProcessPoolExecutor(7) as pool:
            bounds = pl.concat(pool.map(bounds_energy_for_day, days()))
        metrics("filtered", bounds)
        metrics("unfiltered", None)
    elif step == "catalog":
        to_catalog()
