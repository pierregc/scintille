"""Copies checks, gold build time, storm counts and lake size to Postgres for metrics.json."""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from dagster import (
    AssetCheckEvaluation,
    AssetCheckKey,
    AssetCheckSeverity,
    AssetKey,
    DagsterInstance,
    DefaultSensorStatus,
    SensorEvaluationContext,
    SkipReason,
    sensor,
)
from dagster._core.storage.asset_check_execution_record import (
    COMPLETED_ASSET_CHECK_EXECUTION_RECORD_STATUSES,
    AssetCheckExecutionRecordStatus,
)
from pyiceberg.catalog import Catalog
from scintille_ingest.runtime.ops import (
    GOLD_STATUS,
    LAKE_STATUS,
    QUALITY_STATUS,
    STORMS_STATUS,
    PostgresOps,
)
from scintille_lake.tables import NAMESPACES

from .resources import LakeResource, PostgresResource

STORM_CATALOG = AssetKey(["feeds", "storm_catalog"])
STORM_FIELDS = {"detected": "detected", "published": "storms", "highlighted": "highlights"}
LAKE_EVERY = timedelta(hours=1)
SUMMARY_FIELDS = {
    "bytes": "total-files-size",
    "data_files": "total-data-files",
    "records": "total-records",
}


@dataclass(frozen=True)
class CheckResult:
    name: str
    passed: bool
    error: bool
    at: datetime


def latest_checks(instance: DagsterInstance, keys: Sequence[AssetCheckKey]) -> list[CheckResult]:
    """The latest completed evaluation per check; a pending rerun keeps the previous result."""
    storage = instance.event_log_storage
    results = []
    for key, latest in storage.get_latest_asset_check_execution_by_key(list(keys)).items():
        record = latest
        if record.status == AssetCheckExecutionRecordStatus.PLANNED:
            history = storage.get_asset_check_execution_history(
                key, limit=1, status=set(COMPLETED_ASSET_CHECK_EXECUTION_RECORD_STATUSES)
            )
            if not history:
                continue
            record = history[0]
        if record.event is None:
            continue
        event = record.event.dagster_event
        evaluation = event.event_specific_data if event else None
        if not isinstance(evaluation, AssetCheckEvaluation):
            continue
        results.append(
            CheckResult(
                key.name,
                evaluation.passed,
                evaluation.severity == AssetCheckSeverity.ERROR,
                datetime.fromtimestamp(record.event.timestamp, UTC),
            )
        )
    return results


def summarize(results: Sequence[CheckResult]) -> dict[str, Any]:
    if not results:
        return {"status": "unknown", "checked_at": None, "failed": []}
    failed = sorted(r.name for r in results if not r.passed)
    errors = any(not r.passed and r.error for r in results)
    return {
        "status": "fail" if errors else "warn" if failed else "pass",
        "checked_at": max(r.at for r in results).isoformat(),
        "failed": failed,
    }


def latest_gold_build(instance: DagsterInstance, keys: Sequence[AssetKey]) -> datetime | None:
    events = instance.get_latest_materialization_events(list(keys))
    times = [e.timestamp for e in events.values() if e is not None]
    return datetime.fromtimestamp(max(times), UTC) if times else None


def latest_storm_counts(instance: DagsterInstance) -> tuple[datetime, dict[str, int]] | None:
    """Counts recorded by the latest storm catalog publication."""
    event = instance.get_latest_materialization_event(STORM_CATALOG)
    materialization = event.asset_materialization if event else None
    if event is None or materialization is None:
        return None
    metadata = materialization.metadata
    counts = {k: int(str(metadata[m].value)) for k, m in STORM_FIELDS.items() if m in metadata}
    return datetime.fromtimestamp(event.timestamp, UTC), counts


def lake_size(catalog: Catalog) -> dict[str, int]:
    """Totals of each table's current snapshot, from its summary: no manifest is read."""
    totals = dict.fromkeys(["tables", *SUMMARY_FIELDS], 0)
    for namespace in NAMESPACES:
        for identifier in catalog.list_tables(namespace):
            totals["tables"] += 1
            snapshot = catalog.load_table(identifier).current_snapshot()
            if snapshot is None:
                continue
            for key, field in SUMMARY_FIELDS.items():
                value = snapshot.summary.get(field) if snapshot.summary else None
                if value is None:
                    raise ValueError(f"{'.'.join(identifier)}: snapshot summary without {field}")
                totals[key] += int(value)
    return totals


def lake_due(cursor: str | None, now: datetime) -> bool:
    return cursor is None or now - datetime.fromisoformat(cursor) >= LAKE_EVERY


@sensor(minimum_interval_seconds=60, default_status=DefaultSensorStatus.RUNNING)
def ops_status(
    context: SensorEvaluationContext, postgres: PostgresResource, lake: LakeResource
) -> SkipReason:
    """Every minute: check results, the latest gold build and storm counts; hourly: lake size."""
    repository = context.repository_def
    assert repository is not None
    check_keys = list(repository.asset_checks_defs_by_key)
    gold_keys = [k for k in repository.assets_defs_by_key if k.path[0] == "gold"]
    ops = PostgresOps(postgres.dsn)
    try:
        now = datetime.now(UTC)
        ops.put_status(QUALITY_STATUS, summarize(latest_checks(context.instance, check_keys)), now)
        built = latest_gold_build(context.instance, gold_keys)
        if built is not None:
            ops.put_status(GOLD_STATUS, {"keys": [k.to_user_string() for k in gold_keys]}, built)
        storms = latest_storm_counts(context.instance)
        if storms is not None:
            ops.put_status(STORMS_STATUS, storms[1], storms[0])
        if lake_due(context.cursor, now):
            # One attempt per hour, so a failing catalog is not retried every minute.
            context.update_cursor(now.isoformat())
            try:
                ops.put_status(LAKE_STATUS, lake_size(lake.catalog()), now)
            except Exception:
                context.log.exception("Lake size not measured; the previous one stays published")
    finally:
        ops.close()
    return SkipReason("status recorded")
