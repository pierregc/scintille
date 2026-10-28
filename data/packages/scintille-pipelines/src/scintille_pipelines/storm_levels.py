"""`gold/storm_levels`: intensity level of each storm, updated while it is active."""

from datetime import datetime

import polars as pl
from dagster import (
    AssetCheckResult,
    AssetCheckSeverity,
    AssetCheckSpec,
    AssetExecutionContext,
    AssetKey,
    Config,
    MaterializeResult,
    asset,
)
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import DayTransform
from pyiceberg.types import (
    BooleanType,
    DoubleType,
    LongType,
    NestedField,
    StringType,
    TimestamptzType,
)
from scintille_lake.migrate import sync_table
from scintille_lake.tables import gold_table

from .levels import LevelRule, classify, keep_live_maximum
from .resources import LakeResource
from .storm_cells import BACKFILL, STORM_CELLS, hourly
from .storms import STORM_TRACKS, STORMS, STORMS_CHECK, _between, _scan, _write
from .tracking import HOUR

STORM_LEVELS = gold_table(
    "storm_levels",
    Schema(
        NestedField(1, "storm_id", StringType(), required=True),
        NestedField(2, "storm_start", TimestamptzType(), required=True),
        NestedField(3, "closed", BooleanType(), required=True, doc="As in `gold/storms`."),
        NestedField(4, "level_source", StringType(), required=True, doc="Satellite counted."),
        NestedField(5, "flashes", LongType(), required=True, doc="On `level_source`."),
        NestedField(6, "peak_rate", LongType(), required=True, doc="Most flashes in a minute."),
        NestedField(7, "score", DoubleType(), required=True),
        NestedField(8, "level", LongType(), required=True, doc="From 1, the lowest."),
        NestedField(9, "level_name", StringType(), required=True),
        NestedField(10, "level_rule", StringType(), required=True),
    ),
    PartitionSpec(PartitionField(2, 1000, DayTransform(), "start_day")),
)


class StormLevelsConfig(Config):
    """Defaults are the proposal of ADR 0009, pending its decision (#71)."""

    score: str = "flashes_x_peak"
    thresholds: list[float] = [8, 25, 120, 450]  # noqa: RUF012
    names: list[str] = ["Light", "Moderate", "Strong", "Intense", "Exceptional"]  # noqa: RUF012
    count: str = "best_source"

    @property
    def rule(self) -> LevelRule:
        return LevelRule(
            self.score,  # type: ignore[arg-type]
            tuple(self.thresholds),
            tuple(self.names),
            self.count,  # type: ignore[arg-type]
        )


def storm_minutes(tracks: pl.DataFrame, cells: pl.DataFrame) -> pl.DataFrame:
    """Flashes per storm, source and minute, from the per-minute counts of its cells."""
    return (
        tracks.select("storm_id", "window_start", "cell_id")
        .join(
            cells.select("window_start", "cell_id", "minute_counts"),
            on=["window_start", "cell_id"],
        )
        .explode("minute_counts")
        .drop_nulls("minute_counts")
        .unnest("minute_counts")
        .group_by("storm_id", "source", "minute")
        .agg(pl.col("flashes").sum())
    )


LEVELS_CHECK = AssetCheckSpec(
    "valid_levels",
    asset=AssetKey(["gold", "storm_levels"]),
    blocking=True,
    description="One level per storm, within the rule, from positive counts.",
)


def check_levels(levels: pl.DataFrame, rule: LevelRule) -> AssetCheckResult:
    bad = levels.filter(
        ~pl.col("level").is_between(1, len(rule.names))
        | (pl.col("peak_rate") <= 0)
        | (pl.col("peak_rate") > pl.col("flashes"))
    ).height
    duplicates = levels.height - levels["storm_id"].n_unique()
    return AssetCheckResult(
        check_name=LEVELS_CHECK.name,
        passed=bad == duplicates == 0,
        severity=AssetCheckSeverity.ERROR,
        metadata={"storms": levels.height, "invalid": bad, "duplicate_ids": duplicates},
    )


@asset(
    key=LEVELS_CHECK.asset_key,
    partitions_def=hourly,
    deps=[STORMS_CHECK.asset_key],
    backfill_policy=BACKFILL,
    pool="storm-tracks",
    group_name="gold",
    check_specs=[LEVELS_CHECK],
    description="Intensity level of the storms active in the hours (ADR 0009).",
)
def storm_levels(
    context: AssetExecutionContext, config: StormLevelsConfig, lake: LakeResource
) -> MaterializeResult:  # type: ignore[type-arg]
    start, end = context.partition_time_window
    rule = config.rule
    catalog = lake.catalog()
    sync_table(catalog, STORM_LEVELS)
    table = catalog.load_table(STORM_LEVELS.identifier)
    tracks_table = catalog.load_table(STORM_TRACKS.identifier)
    active = _scan(tracks_table, _between("window_start", start - HOUR, end))
    if active.is_empty():
        empty = pl.DataFrame(schema=dict.fromkeys(("storm_id", "level_name"), pl.String))
        empty = empty.with_columns(pl.lit(0).alias(c) for c in ("level", "flashes", "peak_rate"))
        return MaterializeResult(metadata={"storms": 0}, check_results=[check_levels(empty, rule)])
    since = active["storm_start"].min()
    assert isinstance(since, datetime)
    after = f"storm_start >= '{since.isoformat()}'"
    tracks = _scan(tracks_table, after)
    cells = _scan(
        catalog.load_table(STORM_CELLS.identifier), f"window_start >= '{since.isoformat()}'"
    )
    storms = _scan(catalog.load_table(STORMS.identifier), after)
    levels = storms.select("storm_id", "storm_start", "closed").join(
        classify(storm_minutes(tracks, cells), rule), on="storm_id"
    )
    levels = keep_live_maximum(levels, _scan(table, after))
    _write(table, levels.select(STORM_LEVELS.schema.column_names), after)
    counts = levels["level"].value_counts()
    return MaterializeResult(
        metadata={
            "storms": levels.height,
            "unclassified": storms.height - levels.height,
            "rule": str(rule),
            **{
                f"level_{k}": int(counts.filter(pl.col("level") == k)["count"].sum())
                for k in range(1, len(rule.names) + 1)
            },
        },
        check_results=[check_levels(levels, rule)],
    )
