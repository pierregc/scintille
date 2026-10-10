"""Code location `scintille_pipelines`."""

from dagster import Definitions

from .alerts import alert_on_failure
from .assets import daily_flash_counts
from .automation import daily_gold, daily_gold_schedule, silver_changed
from .resources import resources

defs = Definitions(
    assets=[daily_flash_counts],
    jobs=[daily_gold],
    schedules=[daily_gold_schedule],
    sensors=[silver_changed, alert_on_failure],
    resources=resources(),
)
