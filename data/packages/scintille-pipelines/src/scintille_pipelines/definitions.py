"""Code location `scintille_pipelines`."""

from dagster import AssetSelection, Definitions, ScheduleDefinition, define_asset_job

from .alerts import alert_on_failure
from .assets import daily_flash_counts
from .automation import daily_gold, daily_gold_schedule, silver_changed
from .backfill import silver_flashes_backfill
from .checks import DAILY, HOURLY, SILVER
from .maintenance import DAILY_MAINTENANCE, WEEKLY_MAINTENANCE
from .resources import resources

hourly_checks = define_asset_job("silver_hourly_checks", selection=AssetSelection.checks(*HOURLY))
daily_checks = define_asset_job(
    "silver_daily_checks", selection=AssetSelection.checks(*DAILY, *DAILY_MAINTENANCE)
)
weekly_maintenance = define_asset_job(
    "lake_weekly_maintenance", selection=AssetSelection.checks(*WEEKLY_MAINTENANCE)
)

defs = Definitions(
    assets=[daily_flash_counts, SILVER, silver_flashes_backfill],
    asset_checks=[*HOURLY, *DAILY, *DAILY_MAINTENANCE, *WEEKLY_MAINTENANCE],
    jobs=[daily_gold, hourly_checks, daily_checks, weekly_maintenance],
    schedules=[
        daily_gold_schedule,
        ScheduleDefinition(job=hourly_checks, cron_schedule="10 * * * *", execution_timezone="UTC"),
        ScheduleDefinition(job=daily_checks, cron_schedule="0 2 * * *", execution_timezone="UTC"),
        ScheduleDefinition(
            job=weekly_maintenance, cron_schedule="0 3 * * 0", execution_timezone="UTC"
        ),
    ],
    sensors=[silver_changed, alert_on_failure],
    resources=resources(),
)
