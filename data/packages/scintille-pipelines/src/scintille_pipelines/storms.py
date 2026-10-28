"""`gold/storm_tracks` and `gold/storms`: storm cells linked across hourly windows."""

from datetime import datetime

import polars as pl
from dagster import (
    AssetCheckResult,
    AssetCheckSeverity,
    AssetCheckSpec,
    AssetDep,
    AssetExecutionContext,
    AssetKey,
    Config,
    Failure,
    MaterializeResult,
    TimeWindowPartitionMapping,
    asset,
)
from pyiceberg.expressions import BooleanExpression
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.table import Table
from pyiceberg.transforms import DayTransform
from pyiceberg.types import (
    BooleanType,
    DoubleType,
    ListType,
    LongType,
    NestedField,
    StringType,
    StructType,
    TimestamptzType,
)
from scintille_lake.migrate import sync_table
from scintille_lake.tables import gold_table

from .resources import LakeResource
from .storm_cells import BACKFILL, STORM_CELLS, hourly
from .tracking import HOUR, TRACK_SCHEMA, TrackParams, summarize_storms, track_range


def _strings(field_id: int, element_id: int, name: str, doc: str | None = None) -> NestedField:
    return NestedField(
        field_id, name, ListType(element_id, StringType(), element_required=True), True, doc=doc
    )


STORM_TRACKS = gold_table(
    "storm_tracks",
    Schema(
        NestedField(1, "storm_id", StringType(), required=True, doc="Id of the first cell."),
        NestedField(2, "storm_start", TimestamptzType(), required=True, doc="First window."),
        NestedField(3, "window_start", TimestamptzType(), required=True),
        NestedField(4, "window_end", TimestamptzType(), required=True),
        NestedField(5, "cell_id", StringType(), required=True),
        NestedField(6, "previous_cell_id", StringType(), required=False),
        NestedField(7, "split_from", StringType(), required=False, doc="Storm split off."),
        _strings(8, 23, "merged", "Storms that end merged into this cell."),
        NestedField(9, "t_start", TimestamptzType(), required=True),
        NestedField(10, "t_end", TimestamptzType(), required=True),
        NestedField(11, "flash_count", LongType(), required=True),
        NestedField(12, "hour_flash_count", LongType(), required=False),
        NestedField(13, "lat", DoubleType(), required=True),
        NestedField(14, "lon", DoubleType(), required=True),
        NestedField(15, "west", DoubleType(), required=True, doc="west > east crosses 180°."),
        NestedField(16, "south", DoubleType(), required=True),
        NestedField(17, "east", DoubleType(), required=True),
        NestedField(18, "north", DoubleType(), required=True),
        NestedField(19, "area_km2", DoubleType(), required=True),
        NestedField(20, "hull", StringType(), required=True, doc="WKT polygon."),
        _strings(21, 24, "sources"),
        NestedField(22, "params", StringType(), required=True),
    ),
    PartitionSpec(PartitionField(3, 1000, DayTransform(), "window_day")),
)

STORMS = gold_table(
    "storms",
    Schema(
        NestedField(1, "storm_id", StringType(), required=True),
        NestedField(2, "storm_start", TimestamptzType(), required=True, doc="First window."),
        NestedField(3, "last_window", TimestamptzType(), required=True),
        NestedField(4, "t_start", TimestamptzType(), required=True, doc="First flash."),
        NestedField(5, "t_end", TimestamptzType(), required=True, doc="Last flash."),
        NestedField(
            6, "closed", BooleanType(), required=True, doc="A later window has been tracked."
        ),
        NestedField(7, "steps", LongType(), required=True, doc="Windows with a cell."),
        NestedField(8, "flash_count", LongType(), required=True),
        NestedField(9, "max_cell_flashes", LongType(), required=True),
        NestedField(10, "max_area_km2", DoubleType(), required=True),
        NestedField(11, "lat", DoubleType(), required=True, doc="Flash-weighted centroid."),
        NestedField(12, "lon", DoubleType(), required=True),
        NestedField(13, "west", DoubleType(), required=True, doc="west > east crosses 180°."),
        NestedField(14, "south", DoubleType(), required=True),
        NestedField(15, "east", DoubleType(), required=True),
        NestedField(16, "north", DoubleType(), required=True),
        _strings(17, 21, "sources"),
        NestedField(18, "split_from", StringType(), required=False),
        NestedField(
            19,
            "track",
            ListType(
                22,
                StructType(
                    NestedField(23, "time", TimestamptzType(), required=True),
                    NestedField(24, "lat", DoubleType(), required=True),
                    NestedField(25, "lon", DoubleType(), required=True),
                    NestedField(26, "flash_count", LongType(), required=True),
                    NestedField(27, "area_km2", DoubleType(), required=True),
                ),
                element_required=True,
            ),
            required=True,
            doc="Centroid per window, at the middle of the cell's time range.",
        ),
        NestedField(20, "params", StringType(), required=True),
    ),
    PartitionSpec(PartitionField(2, 1000, DayTransform(), "start_day")),
)


class StormTracksConfig(Config):
    max_speed_kmh: float = 100.0
    max_gap_minutes: float = 30.0
    new_chain: bool = False
    """Start storms from scratch when the previous hour was never tracked."""

    @property
    def params(self) -> TrackParams:
        return TrackParams(self.max_speed_kmh, self.max_gap_minutes)


def _scan(table: Table, row_filter: str | BooleanExpression) -> pl.DataFrame:
    df = pl.from_arrow(table.scan(row_filter=row_filter).to_arrow())
    assert isinstance(df, pl.DataFrame)
    return df


def _between(column: str, start: datetime, end: datetime) -> str:
    return f"{column} >= '{start.isoformat()}' AND {column} < '{end.isoformat()}'"


def _write(table: Table, df: pl.DataFrame, overwrite_filter: str) -> None:
    table.overwrite(
        df.to_arrow().cast(table.schema().as_arrow()), overwrite_filter=overwrite_filter
    )


TRACKS_CHECK = AssetCheckSpec(
    "valid_tracks",
    asset=AssetKey(["gold", "storm_tracks"]),
    blocking=True,
    description="Every cell once, at most one cell per storm and window, storms start earlier.",
)


def check_tracks(tracks: pl.DataFrame, cells: int) -> AssetCheckResult:
    duplicate_cells = tracks.height - tracks.select("window_start", "cell_id").n_unique()
    split_storms = tracks.height - tracks.select("window_start", "storm_id").n_unique()
    bad = tracks.filter(pl.col("storm_start") > pl.col("window_start")).height
    return AssetCheckResult(
        check_name=TRACKS_CHECK.name,
        passed=duplicate_cells == split_storms == bad == 0 and tracks.height == cells,
        severity=AssetCheckSeverity.ERROR,
        metadata={
            "rows": tracks.height,
            "cells": cells,
            "duplicate_cells": duplicate_cells,
            "storms_with_two_cells": split_storms,
            "starts_after_window": bad,
        },
    )


@asset(
    key=TRACKS_CHECK.asset_key,
    partitions_def=hourly,
    deps=[
        AssetDep(AssetKey(["gold", "storm_cells"])),
        AssetDep(
            TRACKS_CHECK.asset_key,
            partition_mapping=TimeWindowPartitionMapping(start_offset=-1, end_offset=-1),
        ),
    ],
    backfill_policy=BACKFILL,
    pool="storm-tracks",
    group_name="gold",
    check_specs=[TRACKS_CHECK],
    description="Storm cells linked to the storms of the previous hour.",
)
def storm_tracks(
    context: AssetExecutionContext, config: StormTracksConfig, lake: LakeResource
) -> MaterializeResult:  # type: ignore[type-arg]
    start, end = context.partition_time_window
    previous = hourly.get_partition_key_for_timestamp((start - HOUR).timestamp())
    if (
        not config.new_chain
        and start - HOUR >= hourly.start
        and previous not in context.instance.get_materialized_partitions(context.asset_key)
    ):
        raise Failure(f"Hour {previous} is not tracked; run it first or set new_chain.")
    catalog = lake.catalog()
    sync_table(catalog, STORM_TRACKS)
    table = catalog.load_table(STORM_TRACKS.identifier)
    cells = _scan(catalog.load_table(STORM_CELLS.identifier), _between("window_start", start, end))
    prev = _scan(table, _between("window_start", start - HOUR, start))
    prev = prev.select(TRACK_SCHEMA.names()).cast(TRACK_SCHEMA)
    tracks = track_range(prev, cells, start, end, config.params).with_columns(
        params=pl.lit(str(config.params))
    )
    _write(table, tracks, _between("window_start", start, end))
    new = tracks.filter(pl.col("previous_cell_id").is_null())
    return MaterializeResult(
        metadata={
            "cells": cells.height,
            "new_storms": new.height,
            "splits": int(new["split_from"].is_not_null().sum()),
            "merges": int(tracks["merged"].list.len().sum()),
        },
        check_results=[check_tracks(tracks, cells.height)],
    )


STORMS_CHECK = AssetCheckSpec(
    "valid_storms",
    asset=AssetKey(["gold", "storms"]),
    blocking=True,
    description="Unique ids, one track point per step, positive flash counts.",
)


def check_storms(storms: pl.DataFrame) -> AssetCheckResult:
    bad = (
        0
        if storms.is_empty()
        else storms.filter(
            (pl.col("track").list.len() != pl.col("steps"))
            | (pl.col("flash_count") <= 0)
            | (pl.col("t_start") > pl.col("t_end"))
        ).height
    )
    duplicates = storms.height - storms["storm_id"].n_unique()
    return AssetCheckResult(
        check_name=STORMS_CHECK.name,
        passed=bad == duplicates == 0,
        severity=AssetCheckSeverity.ERROR,
        metadata={"storms": storms.height, "invalid": bad, "duplicate_ids": duplicates},
    )


@asset(
    key=STORMS_CHECK.asset_key,
    partitions_def=hourly,
    deps=[TRACKS_CHECK.asset_key],
    backfill_policy=BACKFILL,
    pool="storm-tracks",
    group_name="gold",
    check_specs=[STORMS_CHECK],
    description="One row per storm with its track, rebuilt for the storms active in the hours.",
)
def storms(context: AssetExecutionContext, lake: LakeResource) -> MaterializeResult:  # type: ignore[type-arg]
    start, end = context.partition_time_window
    catalog = lake.catalog()
    sync_table(catalog, STORMS)
    tracks_table = catalog.load_table(STORM_TRACKS.identifier)
    # Storms ending in the previous hour are touched too, so they get closed.
    active = _scan(tracks_table, _between("window_start", start - HOUR, end))
    table = catalog.load_table(STORMS.identifier)
    if active.is_empty():
        empty = pl.DataFrame(schema={"storm_id": pl.String(), "steps": pl.Int64()})
        return MaterializeResult(metadata={"storms": 0}, check_results=[check_storms(empty)])
    since = active["storm_start"].min()
    assert isinstance(since, datetime)
    tracks = _scan(tracks_table, f"storm_start >= '{since.isoformat()}'")
    latest = tracks["window_start"].max()
    assert isinstance(latest, datetime)
    rows = summarize_storms(tracks, max(latest, end - HOUR)).join(
        tracks.group_by("storm_id").agg(pl.col("params").first()), on="storm_id"
    )
    _write(table, rows, f"storm_start >= '{since.isoformat()}'")
    return MaterializeResult(
        metadata={
            "storms": rows.height,
            "active": active["storm_id"].n_unique(),
            "since": since.isoformat(),
        },
        check_results=[check_storms(rows)],
    )
