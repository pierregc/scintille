"""Code location `scintille_pipelines`."""

from dagster import AssetSelection, Definitions, ScheduleDefinition, define_asset_job

from .alerts import alert_on_failure
from .assets import daily_flash_counts
from .automation import daily_gold, daily_gold_schedule, silver_changed
from .backfill import silver_flashes_backfill
from .checks import DAILY, HOURLY, SILVER
from .resources import resources
from .storm_cells import storm_cells
from .storms import storm_tracks, storms

hourly_checks = define_asset_job("silver_hourly_checks", selection=AssetSelection.checks(*HOURLY))
daily_checks = define_asset_job("silver_daily_checks", selection=AssetSelection.checks(*DAILY))

defs = Definitions(
    assets=[daily_flash_counts, storm_cells, storm_tracks, storms, SILVER, silver_flashes_backfill],
    asset_checks=[*HOURLY, *DAILY],
    jobs=[daily_gold, hourly_checks, daily_checks],
    schedules=[
        daily_gold_schedule,
        ScheduleDefinition(job=hourly_checks, cron_schedule="10 * * * *", execution_timezone="UTC"),
        ScheduleDefinition(job=daily_checks, cron_schedule="0 2 * * *", execution_timezone="UTC"),
    ],
    sensors=[silver_changed, alert_on_failure],
    resources=resources(),
)
