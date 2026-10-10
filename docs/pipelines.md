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
| External asset | `raw/glm_files`, `bronze/ingest_log`, `reference/countries` | Written outside Dagster, declared for lineage |
| Asset | `gold/flash_stats_hourly` | Flashes per hour, source and 1° cell |
| Asset | `gold/source_sla_daily` | Per source and day: files against expected, completeness, latency p50/p95 |
| Asset | `gold/region_daily` | Flashes per country, source and day (Natural Earth borders) |
| Asset | `feeds/daily_stats` | Publishes `stats/daily/<day>.json` to R2 from the gold tables |
| Asset checks | `unique`, `not_null`, `accepted_ranges`, `relationships` | On each gold asset, blocking: a failed check fails the run |
| Job | `daily_gold` | The gold assets and the feed, one daily partition rebuilt whole |
| Schedule | `daily_gold_schedule` | Yesterday's partition at 01:30 UTC |
| Sensor | `silver_changed` | Rebuilds the open UTC day when `silver.flashes` gets a new snapshot (`daily` has `end_offset=1`) |
| Sensor | `alert_on_failure` | Posts failed runs to `SCINTILLE_ALERT_WEBHOOK` |

## Gold models

Each model is one SQL file in `scintille_pipelines/gold/sql/`, run by one daily-partitioned asset:
DuckDB reads silver and bronze through the Iceberg catalog (`lake.silver.flashes`), and the day is
replaced in the gold table in one PyIceberg commit. Upstream tables are `{placeholders}` in the SQL
and dependencies are asset deps, so a later move to dbt is mechanical. Checks are SQL selecting the
failing rows, like dbt generic tests. Gold tables are merge-on-read (`gold_table()`).

On the pinned versions, DuckDB `INSERT` and `DELETE` work on a partitioned merge-on-read gold table
(`test_duckdb_write_path_on_a_partitioned_gold_table`, `-m lake`). Writes still go through one
PyIceberg overwrite per day: a single atomic commit, the same path as silver backfills, and testable
on the SQLite catalog. `region_daily` downloads Natural Earth admin-0 countries
once (pinned checksum, cached in `SCINTILLE_CACHE_DIR`, the `cache` volume in compose) and needs DuckDB's `spatial` extension.

## Resources

All configuration comes from the environment; a variable that is set is passed as a Dagster `EnvVar`,
so its value never shows in the UI or the logs. Unset variables fall back to the local stack.

| Resource | Variables |
|---|---|
| `lake` | `SCINTILLE_LAKE_URI`, `SCINTILLE_LAKE_WAREHOUSE`, `SCINTILLE_LAKE_TOKEN` ([lakehouse](lakehouse.md)) |
| `postgres` | `SCINTILLE_POSTGRES_DSN`; `partition_lock(key)` is the advisory lock shared with `lake-writer` and backfills |
| `r2` | `SCINTILLE_R2_ENDPOINT`, `SCINTILLE_R2_BUCKET`, `SCINTILLE_R2_ACCESS_KEY_ID`, `SCINTILLE_R2_SECRET_ACCESS_KEY` |

## Tests

`uv run pytest` materializes the gold assets and the feed in-process on a SQLite catalog and an
in-memory bucket. `uv run pytest -m lake` materializes them against the local Lakekeeper and S3
store, probes the DuckDB write path and tests the Postgres lock; the `lake` CI job runs both.
