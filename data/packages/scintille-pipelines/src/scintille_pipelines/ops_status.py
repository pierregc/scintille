"""Copies the latest check results and gold build time to Postgres for `live/metrics.json`."""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
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
from scintille_ingest.runtime.ops import GOLD_STATUS, QUALITY_STATUS, PostgresOps

from .resources import PostgresResource


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


@sensor(minimum_interval_seconds=60, default_status=DefaultSensorStatus.RUNNING)
def ops_status(context: SensorEvaluationContext, postgres: PostgresResource) -> SkipReason:
    """Every minute: silver check results and the latest `gold/*` materialization."""
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
    finally:
        ops.close()
    return SkipReason("status recorded")
