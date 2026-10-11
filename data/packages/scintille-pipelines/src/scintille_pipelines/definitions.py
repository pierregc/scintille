"""Code location `scintille_pipelines`."""

from dagster import AssetSelection, Definitions, ScheduleDefinition, define_asset_job

from .alerts import alert_on_failure
from .automation import daily_gold, daily_gold_schedule, silver_changed
from .backfill import silver_flashes_backfill
from .checks import DAILY, HOURLY, SILVER
from .gold.assets import GOLD, daily_stats_feed
from .lineage import BRONZE, COUNTRIES, RAW
from .resources import resources

hourly_checks = define_asset_job("silver_hourly_checks", selection=AssetSelection.checks(*HOURLY))
daily_checks = define_asset_job("silver_daily_checks", selection=AssetSelection.checks(*DAILY))

defs = Definitions(
    assets=[RAW, BRONZE, COUNTRIES, SILVER, silver_flashes_backfill, *GOLD, daily_stats_feed],
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
