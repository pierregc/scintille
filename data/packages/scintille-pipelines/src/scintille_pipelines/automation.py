"""Schedule and sensor for the gold assets."""

from dagster import (
    RunRequest,
    SensorEvaluationContext,
    SkipReason,
    build_schedule_from_partitioned_job,
    define_asset_job,
    sensor,
)
from scintille_lake.tables import FLASHES

from .assets import daily, daily_flash_counts
from .resources import LakeResource

daily_gold = define_asset_job("daily_gold", selection=[daily_flash_counts], partitions_def=daily)

# Yesterday's partition, once late files have landed.
daily_gold_schedule = build_schedule_from_partitioned_job(
    daily_gold, hour_of_day=1, minute_of_hour=30
)


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
    today = daily.get_last_partition_key()
    if today is None:
        return SkipReason("no partition yet")
    return RunRequest(run_key=snapshot_id, partition_key=today)
