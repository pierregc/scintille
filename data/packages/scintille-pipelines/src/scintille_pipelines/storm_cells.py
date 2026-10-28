"""`gold/storm_cells`: flashes clustered into storm cells, one hourly window at a time."""

import math
from collections.abc import Callable
from datetime import datetime, timedelta

import numpy as np
import polars as pl
from dagster import (
    AssetCheckResult,
    AssetCheckSeverity,
    AssetCheckSpec,
    AssetExecutionContext,
    AssetKey,
    BackfillPolicy,
    Config,
    HourlyPartitionsDefinition,
    MaterializeResult,
    asset,
)
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.table import Table
from pyiceberg.transforms import DayTransform
from pyiceberg.types import (
    DoubleType,
    ListType,
    LongType,
    NestedField,
    StringType,
    StructType,
    TimestamptzType,
)
from scintille_lake.migrate import sync_table
from scintille_lake.tables import FLASHES, gold_table

from .clustering import Params, st_dbscan, summarize
from .hotspots import HotspotRule, drop_hotspots, fixed_hotspots, hotspots_from_days, pixel_days
from .resources import LakeResource

hourly = HourlyPartitionsDefinition(start_date="2026-07-01-00:00", timezone="UTC")
# Six hours per run keep the catalog export within memory when catching up.
RUN_HOURS = 6
BACKFILL = BackfillPolicy.multi_run(RUN_HOURS)
CHUNK = timedelta(days=1)

STORM_CELLS = gold_table(
    "storm_cells",
    Schema(
        NestedField(1, "cell_id", StringType(), required=True),
        NestedField(2, "window_start", TimestamptzType(), required=True, doc="Partition hour."),
        NestedField(3, "window_end", TimestamptzType(), required=True),
        NestedField(4, "t_start", TimestamptzType(), required=True, doc="First flash."),
        NestedField(5, "t_end", TimestamptzType(), required=True, doc="Last flash."),
        NestedField(6, "flash_count", LongType(), required=True),
        NestedField(7, "lat", DoubleType(), required=True, doc="Centroid of the flashes."),
        NestedField(8, "lon", DoubleType(), required=True),
        NestedField(9, "west", DoubleType(), required=True, doc="west > east crosses 180°."),
        NestedField(10, "south", DoubleType(), required=True),
        NestedField(11, "east", DoubleType(), required=True),
        NestedField(12, "north", DoubleType(), required=True),
        NestedField(13, "area_km2", DoubleType(), required=True, doc="Convex hull area."),
        NestedField(
            14,
            "hull",
            StringType(),
            required=True,
            doc="WKT polygon; longitudes stay continuous around the centroid.",
        ),
        NestedField(15, "sources", ListType(16, StringType(), element_required=True), True),
        NestedField(17, "params", StringType(), required=True),
        NestedField(
            18,
            "hour_flash_count",
            LongType(),
            required=False,
            doc="Flashes inside the window's own hour; sums over windows count each flash once.",
        ),
        NestedField(
            19,
            "minute_counts",
            ListType(
                20,
                StructType(
                    NestedField(21, "minute", TimestamptzType(), required=True),
                    NestedField(22, "source", StringType(), required=True),
                    NestedField(23, "flashes", LongType(), required=True),
                ),
                element_required=True,
            ),
            required=False,
            doc="Flashes inside the window's own hour per source and minute.",
        ),
    ),
    PartitionSpec(PartitionField(2, 1000, DayTransform(), "window_day")),
)


class StormCellsConfig(Config):
    """Tuned on GLM data of 2026-10-08 (docs/pipelines.md)."""

    eps_km: float = 10.0
    eps_minutes: float = 10.0
    min_pts: int = 10
    overlap_minutes: int = 30
    hotspot_min_flashes: int = 2000
    hotspot_min_hours: int = 12
    hotspot_pixel_days: int = 3
    hotspot_pixel_min_days: int = 2
    hotspot_pixel_min_flashes: int = 300
    hotspot_pixel_min_hours: int = 3
    hotspot_pixel_spread_km: float = 1.0
    hotspot_pixel_tight_km: float = 0.5
    hotspot_radius_km: float = 10.0

    @property
    def params(self) -> Params:
        return Params(self.eps_km, self.eps_minutes, self.min_pts)

    @property
    def rule(self) -> HotspotRule:
        return HotspotRule(
            min_flashes=self.hotspot_min_flashes,
            min_hours=self.hotspot_min_hours,
            pixel_days=self.hotspot_pixel_days,
            pixel_min_days=self.hotspot_pixel_min_days,
            pixel_min_flashes=self.hotspot_pixel_min_flashes,
            pixel_min_hours=self.hotspot_pixel_min_hours,
            pixel_spread_km=self.hotspot_pixel_spread_km,
            pixel_tight_km=self.hotspot_pixel_tight_km,
            radius_km=self.hotspot_radius_km,
        )


MINUTE_COUNT = pl.List(
    pl.Struct({"minute": pl.Datetime("us", "UTC"), "source": pl.String(), "flashes": pl.Int64()})
)


def minute_counts(flashes: pl.DataFrame, labels: pl.Series, cells: int) -> pl.Series:
    """Flashes per source and minute of each cell, from its counted flashes."""
    counts = (
        flashes.select(
            label=labels, minute=pl.col("event_time").dt.truncate("1m"), source=pl.col("source")
        )
        .group_by("label", "minute", "source")
        .agg(pl.len().cast(pl.Int64).alias("flashes"))
        .sort("label", "minute", "source")
        .group_by("label", maintain_order=True)
        .agg(pl.struct("minute", "source", "flashes").alias("minute_counts"))
    )
    out = pl.DataFrame({"label": pl.int_range(cells, eager=True)}).join(
        counts, on="label", how="left"
    )
    return out["minute_counts"].fill_null(pl.lit([], MINUTE_COUNT)).cast(MINUTE_COUNT)


def hour_cells(
    flashes: pl.DataFrame,
    hour: datetime,
    overlap: timedelta,
    params: Params,
    rule: HotspotRule | None = None,
    hotspots: pl.DataFrame | None = None,
) -> pl.DataFrame:
    """Cells of [hour - overlap, hour + 1 h) with at least one flash in the hour itself.

    Cells entirely inside the overlap belong to the previous window. With a `rule`, flashes
    of fixed hot spots seen up to the end of the hour are left out.
    """
    end = hour + timedelta(hours=1)
    window = flashes.filter(pl.col("event_time").is_between(hour - overlap, end, closed="left"))
    if rule is not None:
        spots = fixed_hotspots(flashes, end, rule) if hotspots is None else hotspots
        window = drop_hotspots(window, spots, rule.radius_km)
    t = window["event_time"].dt.epoch("us").to_numpy() / 1e6
    labels = st_dbscan(window["lat"].to_numpy(), window["lon"].to_numpy(), t, params)
    cells = summarize(window, labels, hour, end, params)
    counted = (labels >= 0) & (t >= hour.timestamp())
    own = np.bincount(labels[counted], minlength=cells.height)
    minutes = minute_counts(
        window.filter(pl.Series(counted)), pl.Series(labels[counted]), cells.height
    )
    return cells.with_columns(
        hour_flash_count=pl.Series(own, dtype=pl.Int64), minute_counts=minutes
    ).filter(pl.col("t_end") >= hour)


def range_cells(
    flashes: pl.DataFrame,
    start: datetime,
    end: datetime,
    overlap: timedelta,
    params: Params,
    rule: HotspotRule | None = None,
    hotspots: Callable[[datetime], pl.DataFrame] | None = None,
) -> pl.DataFrame:
    hours = [start + timedelta(hours=h) for h in range(int((end - start) / timedelta(hours=1)))]
    frames = [
        hour_cells(
            flashes,
            hour,
            overlap,
            params,
            rule,
            None if hotspots is None else hotspots(hour + timedelta(hours=1)),
        )
        for hour in hours
    ]
    return pl.concat(frames)


def scan_hotspots(table: Table, end: datetime, rule: HotspotRule) -> pl.DataFrame:
    """`fixed_hotspots` before `end`, reading one day of positions at a time."""
    days = []
    for day in range(rule.lookback.days):
        hi = end - timedelta(days=day)
        flashes = pl.from_arrow(
            table.scan(
                row_filter=_window(hi - timedelta(days=1), hi),
                selected_fields=("source", "event_time", "lat", "lon"),
            ).to_arrow()
        )
        assert isinstance(flashes, pl.DataFrame)
        days.append(pixel_days(flashes, end, rule))
    return hotspots_from_days(pl.concat(days), rule)


def _window(lo: datetime, hi: datetime) -> str:
    return f"event_time >= '{lo.isoformat()}' AND event_time < '{hi.isoformat()}'"


CHECK = AssetCheckSpec(
    "valid_cells",
    asset=AssetKey(["gold", "storm_cells"]),
    blocking=True,
    description="Unique ids, at least min_pts flashes, last flash inside the window.",
)


def check_cells(cells: pl.DataFrame, min_pts: int) -> AssetCheckResult:
    bad = cells.filter(
        (pl.col("flash_count") < min_pts)
        | (pl.col("t_start") > pl.col("t_end"))
        | (pl.col("t_end") < pl.col("window_start"))
        | (pl.col("t_end") >= pl.col("window_end"))
        | ~pl.col("lat").is_between(-90, 90)
    ).height
    duplicates = cells.height - cells["cell_id"].n_unique()
    return AssetCheckResult(
        check_name=CHECK.name,
        passed=bad == 0 and duplicates == 0,
        severity=AssetCheckSeverity.ERROR,
        metadata={"cells": cells.height, "invalid": bad, "duplicate_ids": duplicates},
    )


@asset(
    key=CHECK.asset_key,
    partitions_def=hourly,
    backfill_policy=BACKFILL,
    pool="storm-cells",
    group_name="gold",
    check_specs=[CHECK],
    description="Flashes clustered into storm cells (ST-DBSCAN), per hour with an overlap.",
)
def storm_cells(
    context: AssetExecutionContext, config: StormCellsConfig, lake: LakeResource
) -> MaterializeResult:  # type: ignore[type-arg]
    start, end = context.partition_time_window
    overlap = timedelta(minutes=config.overlap_minutes)
    rule = config.rule
    catalog = lake.catalog()
    sync_table(catalog, STORM_CELLS)
    source = catalog.load_table(FLASHES.identifier)
    frames = []
    hourly_spots: dict[datetime, pl.DataFrame] = {}

    def spots_at(hour_end: datetime) -> pl.DataFrame:
        # Hot spots need days of positions: read them day by day, never all at once.
        hourly_spots[hour_end] = scan_hotspots(source, hour_end, rule)
        return hourly_spots[hour_end]

    spots = []
    read = 0
    for chunk in range(math.ceil((end - start) / CHUNK)):
        lo = start + chunk * CHUNK
        hi = min(lo + CHUNK, end)
        flashes = pl.from_arrow(
            source.scan(
                row_filter=_window(lo - overlap, hi),
                selected_fields=("flash_id", "source", "event_time", "lat", "lon"),
            ).to_arrow()
        )
        assert isinstance(flashes, pl.DataFrame)
        read += flashes.height
        frames.append(range_cells(flashes, lo, hi, overlap, config.params, rule, spots_at))
        spots.append(hourly_spots[hi])
    cells = pl.concat(frames)
    hotspots = (
        pl.concat(spots)
        .select("source", pl.col("lat").round(2), pl.col("lon").round(2))
        .unique()
        .sort("source", "lat", "lon")
    )
    table = catalog.load_table(STORM_CELLS.identifier)
    table.overwrite(
        cells.to_arrow().cast(table.schema().as_arrow()),
        overwrite_filter=(
            f"window_start >= '{start.isoformat()}' AND window_start < '{end.isoformat()}'"
        ),
    )
    return MaterializeResult(
        metadata={
            "flashes": read,
            "hotspots": hotspots.height,
            "hotspot_positions": [
                f"{src} {lat:.2f} {lon:.2f}" for src, lat, lon in hotspots.iter_rows()
            ],
            "cells": cells.height,
            "clustered_flashes": int(cells["flash_count"].sum()),
        },
        check_results=[check_cells(cells, config.min_pts)],
    )
