"""Code location `scintille_pipelines`."""

from dagster import (
    AssetSelection,
    DefaultScheduleStatus,
    Definitions,
    ScheduleDefinition,
    define_asset_job,
)

from .alerts import alert_on_failure
from .automation import daily_gold, daily_gold_schedule, silver_changed
from .backfill import silver_flashes_backfill
from .checks import DAILY, HOURLY, SILVER
from .gold.assets import GOLD, daily_stats_feed
from .lineage import BRONZE, COUNTRIES, RAW
from .maintenance import DAILY_MAINTENANCE, WEEKLY_MAINTENANCE
from .ops_status import ops_status
from .resources import resources
from .storm_cells import storm_cells
from .storm_levels import storm_levels
from .storm_names import storm_names
from .storms import storm_tracks, storms

RUNNING = DefaultScheduleStatus.RUNNING

hourly_checks = define_asset_job("silver_hourly_checks", selection=AssetSelection.checks(*HOURLY))
daily_checks = define_asset_job(
    "silver_daily_checks", selection=AssetSelection.checks(*DAILY, *DAILY_MAINTENANCE)
)
weekly_maintenance = define_asset_job(
    "lake_weekly_maintenance", selection=AssetSelection.checks(*WEEKLY_MAINTENANCE)
)

defs = Definitions(
    assets=[
        RAW,
        BRONZE,
        COUNTRIES,
        storm_cells,
        storm_tracks,
        storms,
        storm_levels,
        storm_names,
        SILVER,
        silver_flashes_backfill,
        *GOLD,
        daily_stats_feed,
    ],
    asset_checks=[*HOURLY, *DAILY, *DAILY_MAINTENANCE, *WEEKLY_MAINTENANCE],
    jobs=[daily_gold, hourly_checks, daily_checks, weekly_maintenance],
    schedules=[
        daily_gold_schedule,
        ScheduleDefinition(
            job=hourly_checks,
            cron_schedule="10 * * * *",
            execution_timezone="UTC",
            default_status=RUNNING,
        ),
        ScheduleDefinition(
            job=daily_checks,
            cron_schedule="0 2 * * *",
            execution_timezone="UTC",
            default_status=RUNNING,
        ),
        ScheduleDefinition(
            job=weekly_maintenance,
            cron_schedule="0 3 * * 0",
            execution_timezone="UTC",
            default_status=RUNNING,
        ),
    ],
    sensors=[silver_changed, alert_on_failure, ops_status],
    resources=resources(),
)
