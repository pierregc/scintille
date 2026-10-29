"""Checks that table maintenance works: file sizes and orphan inventory."""

from collections.abc import Iterator
from datetime import date, datetime, timedelta

import obstore
import polars as pl
from dagster import AssetCheckResult, AssetCheckSeverity, MetadataValue, asset_check
from obstore.store import ObjectStore
from pyiceberg.table import Table
from scintille_lake.maintenance import (
    TARGET_RANGE_MB,
    MaintenancePolicy,
    StoredObject,
    object_key,
    orphan_inventory,
    referenced_keys,
)
from scintille_lake.tables import TABLES

from . import checks
from .resources import LakeResource, R2Resource

MB = 1024 * 1024
# A day partition is closed, and compacted, once it ended this long ago.
SETTLE = timedelta(days=1)
WINDOW_DAYS = 7
# R2 applies lifecycle rules within about a day.
SAMPLE = 20


def partition_file_stats(table: Table) -> pl.DataFrame:
    """Data file count, total and average size per partition of the current snapshot."""
    schema = {"partition": pl.String, "day": pl.Date, "bytes": pl.Int64}
    files = (
        table.inspect.data_files().select(["partition", "file_size_in_bytes"]).to_pylist()
        if table.current_snapshot()
        else []
    )
    rows = [
        {
            "partition": ",".join(f"{k}={v}" for k, v in f["partition"].items()),
            "day": next((v for v in f["partition"].values() if isinstance(v, date)), None),
            "bytes": f["file_size_in_bytes"],
        }
        for f in files
    ]
    return (
        pl.DataFrame(rows, schema=schema)
        .group_by("partition", "day")
        .agg(pl.len().cast(pl.Int64).alias("files"), pl.col("bytes").sum())
        .with_columns((pl.col("bytes") / pl.col("files") / MB).alias("avg_mb"))
        .sort("partition")
    )


def closed_partitions(stats: pl.DataFrame, now: datetime, window_days: int) -> pl.DataFrame:
    """Day partitions that ended at least `SETTLE` ago, within the last `window_days`."""
    last = (now - SETTLE).date() - timedelta(days=1)
    return stats.filter(pl.col("day").is_between(last - timedelta(days=window_days - 1), last))


def uncompacted(stats: pl.DataFrame) -> pl.DataFrame:
    """Partitions with several files whose average size is outside the target range."""
    return stats.filter((pl.col("files") > 1) & ~pl.col("avg_mb").is_between(*TARGET_RANGE_MB))


def file_size_report(tables: dict[str, Table], now: datetime) -> tuple[bool, dict[str, object]]:
    report: dict[str, object] = {}
    failing: list[str] = []
    for name, table in tables.items():
        closed = closed_partitions(partition_file_stats(table), now, WINDOW_DAYS)
        bad = uncompacted(closed)
        failing += [f"{name}/{p}" for p in bad["partition"]]
        report[name] = {
            "partitions": closed.height,
            "files": int(closed["files"].sum()),
            "avg_mb": round(
                float(closed["bytes"].sum()) / max(int(closed["files"].sum()), 1) / MB, 1
            ),
            "max_files": max(closed["files"].to_list(), default=0),
        }
    return not failing, {"tables": report, "uncompacted": failing[:SAMPLE], "count": len(failing)}


def list_objects(store: ObjectStore, prefix: str) -> Iterator[StoredObject]:
    for batch in obstore.list(store, prefix=prefix, chunk_size=1000):
        for meta in batch:
            yield StoredObject(meta["path"], meta["size"], meta["last_modified"])


def _metadata(values: dict[str, object]) -> dict[str, MetadataValue]:
    return {
        k: MetadataValue.json(v) if isinstance(v, dict | list) else MetadataValue.text(str(v))
        for k, v in values.items()
    }


def _tables(lake: LakeResource) -> dict[str, Table]:
    catalog = lake.catalog()
    return {".".join(t.identifier): catalog.load_table(t.identifier) for t in TABLES}


@asset_check(
    asset=checks.SILVER.key,
    description="Closed day partitions of the last 7 days are compacted (64 to 512 MB per file).",
)
def lake_file_sizes(lake: LakeResource) -> AssetCheckResult:
    passed, report = file_size_report(_tables(lake), checks.clock())
    return AssetCheckResult(
        passed=passed, severity=AssetCheckSeverity.WARN, metadata=_metadata(report)
    )


@asset_check(
    asset=checks.SILVER.key,
    description="Weekly inventory of unreferenced files under each table; nothing is deleted.",
)
def lake_orphan_inventory(lake: LakeResource, r2: R2Resource) -> AssetCheckResult:
    policy = MaintenancePolicy.from_env()
    store = r2.store()
    now = checks.clock()
    orphans: dict[str, list[StoredObject]] = {}
    for name, table in _tables(lake).items():
        listed = list_objects(store, object_key(table.location()) + "/")
        orphans[name] = orphan_inventory(
            listed, referenced_keys(table), now, timedelta(days=policy.orphan_min_age_days)
        )
    found = [o for objects in orphans.values() for o in objects]
    return AssetCheckResult(
        passed=not found,
        severity=AssetCheckSeverity.WARN,
        metadata=_metadata(
            {
                "count": {n: len(o) for n, o in orphans.items()},
                "bytes": sum(o.size for o in found),
                "sample": [o.key for o in found[:SAMPLE]],
            }
        ),
    )


DAILY_MAINTENANCE = [lake_file_sizes]
WEEKLY_MAINTENANCE = [lake_orphan_inventory]
