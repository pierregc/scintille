"""Placeholder gold asset: flash counts per day and source, with its check."""

from collections import Counter
from datetime import date, datetime, timedelta

import pyarrow as pa
from dagster import (
    AssetCheckResult,
    AssetCheckSeverity,
    AssetCheckSpec,
    AssetExecutionContext,
    AssetKey,
    DailyPartitionsDefinition,
    MaterializeResult,
    asset,
)
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import IdentityTransform
from pyiceberg.types import DateType, LongType, NestedField, StringType
from scintille_lake.migrate import sync_table
from scintille_lake.tables import FLASHES, gold_table

from .resources import LakeResource

# end_offset=1 keeps the open UTC day available to the live sensor.
daily = DailyPartitionsDefinition(start_date="2026-07-01", timezone="UTC", end_offset=1)

DAILY_FLASH_COUNTS = gold_table(
    "daily_flash_counts",
    Schema(
        NestedField(1, "day", DateType(), required=True),
        NestedField(2, "source", StringType(), required=True),
        NestedField(3, "flash_count", LongType(), required=True),
    ),
    PartitionSpec(PartitionField(1, 1000, IdentityTransform(), "day")),
)


def day_bounds(partition_key: str) -> tuple[date, str, str]:
    day = date.fromisoformat(partition_key)
    start = datetime(day.year, day.month, day.day).isoformat() + "+00:00"
    end = (datetime(day.year, day.month, day.day) + timedelta(days=1)).isoformat() + "+00:00"
    return day, start, end


def count_by_source(flashes: pa.Table, day: date, schema: pa.Schema) -> pa.Table:
    counts = Counter(flashes["source"].to_pylist())
    rows = [{"day": day, "source": s, "flash_count": n} for s, n in sorted(counts.items())]
    return pa.Table.from_pylist(rows, schema=schema)


CHECK = AssetCheckSpec(
    "one_row_per_source",
    asset=AssetKey(["gold", "daily_flash_counts"]),
    blocking=True,
    description="One row per source and no negative count.",
)


def check_counts(counts: pa.Table) -> AssetCheckResult:
    sources = counts["source"].to_pylist()
    negative = len([n for n in counts["flash_count"].to_pylist() if n is not None and n < 0])
    return AssetCheckResult(
        check_name=CHECK.name,
        passed=len(sources) == len(set(sources)) and negative == 0,
        severity=AssetCheckSeverity.ERROR,
        metadata={"rows": len(sources), "negative": negative},
    )


@asset(
    key=CHECK.asset_key,
    partitions_def=daily,
    group_name="gold",
    check_specs=[CHECK],
    description="Flashes per source and UTC day, rebuilt whole for each partition.",
)
def daily_flash_counts(context: AssetExecutionContext, lake: LakeResource) -> MaterializeResult:  # type: ignore[type-arg]
    day, start, end = day_bounds(context.partition_key)
    catalog = lake.catalog()
    sync_table(catalog, DAILY_FLASH_COUNTS)
    flashes = (
        catalog.load_table(FLASHES.identifier)
        .scan(
            row_filter=f"event_time >= '{start}' AND event_time < '{end}'",
            selected_fields=("source",),
        )
        .to_arrow()
    )
    table = catalog.load_table(DAILY_FLASH_COUNTS.identifier)
    counts = count_by_source(flashes, day, table.schema().as_arrow())
    table.overwrite(counts, overwrite_filter=f"day == '{day.isoformat()}'")
    return MaterializeResult(
        metadata={"flashes": flashes.num_rows, "sources": counts.num_rows},
        check_results=[check_counts(counts)],
    )
