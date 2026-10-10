"""Schedule and sensor for the gold assets."""

from datetime import UTC, datetime, timedelta

from dagster import (
    RunRequest,
    ScheduleEvaluationContext,
    SensorEvaluationContext,
    SkipReason,
    define_asset_job,
    schedule,
    sensor,
)
from scintille_lake.tables import FLASHES

from .assets import daily, daily_flash_counts
from .resources import LakeResource

daily_gold = define_asset_job("daily_gold", selection=[daily_flash_counts], partitions_def=daily)


def utc_now() -> datetime:
    return datetime.now(UTC)


def open_day(now: datetime) -> str:
    return now.astimezone(UTC).date().isoformat()


def closed_day(now: datetime) -> str:
    return (now.astimezone(UTC).date() - timedelta(days=1)).isoformat()


@schedule(job=daily_gold, cron_schedule="30 1 * * *", execution_timezone="UTC")
def daily_gold_schedule(context: ScheduleEvaluationContext) -> RunRequest:
    """Yesterday's partition, once late files have landed."""
    day = closed_day(context.scheduled_execution_time or utc_now())
    return RunRequest(run_key=day, partition_key=day)


@sensor(job=daily_gold, minimum_interval_seconds=600)
def silver_changed(context: SensorEvaluationContext, lake: LakeResource) -> RunRequest | SkipReason:
    """Example sensor: rebuilds today's counts when silver.flashes gets a new snapshot."""
    snapshot = lake.catalog().load_table(FLASHES.identifier).current_snapshot()
    if snapshot is None:
        return SkipReason("silver.flashes is empty")
    snapshot_id = str(snapshot.snapshot_id)
    if snapshot_id == context.cursor:
        return SkipReason("no new snapshot")
    context.update_cursor(snapshot_id)
    return RunRequest(run_key=snapshot_id, partition_key=open_day(utc_now()))
