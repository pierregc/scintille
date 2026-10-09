# Pipelines

Batch work runs in Dagster, in the `scintille_pipelines` code location
(`data/packages/scintille-pipelines`), per [ADR 0006](adr/0006-data-architecture.md).

## Run locally

```sh
docker compose up -d --wait lakekeeper && docker compose run --rm lake-init
cd data
uv run scintille-lake migrate
uv run dagster dev -m scintille_pipelines.definitions
```

Without `DAGSTER_HOME`, `dagster dev` keeps its state in a temporary folder. To use Postgres as in
production, point `DAGSTER_HOME` at `data/packages/scintille-pipelines/dagster_home` and set
`SCINTILLE_POSTGRES_DSN` (locally `postgresql://postgres:postgres@localhost:55432/scintille`).

## Contents

| Kind | Name | What it does |
|---|---|---|
| Asset | `gold/daily_flash_counts` | Placeholder gold table: flashes per source and UTC day, one daily partition rebuilt whole |
| Asset check | `one_row_per_source` | Blocking: a failed check fails the run |
| Schedule | `daily_gold_schedule` | Yesterday's partition at 01:30 UTC |
| Sensor | `silver_changed` | Example: rebuilds today when `silver.flashes` gets a new snapshot |
| Sensor | `alert_on_failure` | Posts failed runs to `SCINTILLE_ALERT_WEBHOOK` |

## Resources

All configuration comes from the environment; a variable that is set is passed as a Dagster `EnvVar`,
so its value never shows in the UI or the logs. Unset variables fall back to the local stack.

| Resource | Variables |
|---|---|
| `lake` | `SCINTILLE_LAKE_URI`, `SCINTILLE_LAKE_WAREHOUSE`, `SCINTILLE_LAKE_TOKEN` ([lakehouse](lakehouse.md)) |
| `postgres` | `SCINTILLE_POSTGRES_DSN`; `partition_lock(key)` is the advisory lock shared with `lake-writer` and backfills |
| `r2` | `SCINTILLE_R2_ENDPOINT`, `SCINTILLE_R2_BUCKET`, `SCINTILLE_R2_ACCESS_KEY_ID`, `SCINTILLE_R2_SECRET_ACCESS_KEY` |

## Tests

`uv run pytest` materializes the asset in-process on a SQLite catalog. `uv run pytest -m lake`
materializes it against the local Lakekeeper and tests the Postgres lock; the `lake` CI job runs both.
