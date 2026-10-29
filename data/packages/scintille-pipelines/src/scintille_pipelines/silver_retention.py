"""Daily silver expiry: whole days older than the retention leave the current snapshot."""

from dagster import (
    Backoff,
    DefaultScheduleStatus,
    OpExecutionContext,
    RetryPolicy,
    ScheduleDefinition,
    job,
    op,
)
from scintille_lake.maintenance import MaintenancePolicy, expire_silver
from scintille_lake.tables import FLASHES

from . import checks
from .resources import LakeResource


# A concurrent lake-writer commit makes the delete fail; it is retried on fresh metadata.
@op(retry_policy=RetryPolicy(max_retries=3, delay=30, backoff=Backoff.EXPONENTIAL))
def expire_silver_days(context: OpExecutionContext, lake: LakeResource) -> None:
    days = MaintenancePolicy.from_env().silver_retention_days
    table = lake.catalog().load_table(FLASHES.identifier)
    before = table.current_snapshot()
    cutoff = expire_silver(table, checks.clock().date(), days)
    after = table.current_snapshot()
    summary = after.summary if after and after != before else None
    removed = summary.get("deleted-data-files", "0") if summary else "0"
    context.add_output_metadata({"cutoff": cutoff.isoformat(), "deleted_data_files": removed})


@job(description="Drops silver days older than SCINTILLE_SILVER_RETENTION_DAYS (21).")
def silver_retention() -> None:
    expire_silver_days()


silver_retention_schedule = ScheduleDefinition(
    job=silver_retention,
    cron_schedule="40 3 * * *",
    execution_timezone="UTC",
    default_status=DefaultScheduleStatus.RUNNING,
)
