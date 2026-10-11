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
| Asset | `gold/storm_cells` | Flashes clustered into storm cells, hourly partitions with an overlap ([below](#storm-cells)) |
| Asset check | `valid_cells` | Blocking: unique ids, at least `min_pts` flashes, last flash inside the window |
| Schedule | `daily_gold_schedule` | Yesterday's partition at 01:30 UTC |
| Asset check | `lake_file_sizes` | Daily, warn: closed day partitions of the last 7 days (ended at least 24 h ago) are one file or average 64 to 512 MB per file; reports file count and average size per table |
| Asset check | `lake_orphan_inventory` | Weekly (Sunday 03:00 UTC), warn: unreferenced files per table, never deleted ([lakehouse](lakehouse.md#maintenance)) |
| Asset check | `raw_lifecycle_active` | Weekly, warn: no object under `raw/` older than 30 days plus 2 days of R2 delay |
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

## Storm cells

`gold/storm_cells` runs ST-DBSCAN over `silver.flashes`, all sources together: two flashes are
neighbours when they are within `eps_km` on the sphere and `eps_minutes` in time, and a flash with at
least `min_pts` neighbours (itself included) is a core flash. Clusters below `min_pts` flashes are
dropped as noise.

- **Windows.** Partition `H` clusters the flashes of `[H - overlap, H + 1 h)` and keeps the cells with
  at least one flash in `[H, H + 1 h)`. A cell crossing the hour therefore appears in both windows,
  which is what storm tracking (#70) links. Counts summed over windows double count the overlap, and
  a storm still active at `H - overlap` starts at that edge: its `t_start` is not a birth.
- **Rows.** One row per cell and window: `cell_id` (window and earliest flash, by time then id),
  window, first and last flash, flash count, centroid, bbox (`west > east` crosses 180°), convex hull
  as WKT with its area, sources, and the parameters used. Bbox and time range are the query bounds
  of the cell's flashes.
- **Writes.** Each run overwrites its hours. A backfill is a single run over the whole range that
  reads one day at a time, and the `storm-cells` pool keeps one run at a time. No schedule
  or sensor yet; they come with storm tracking.
- **Parameters** (run config, defaults below), tuned on GLM data of 2026-10-08 (2.5 M flashes) in
  three contrasted regions: a subtropical mesoscale convective system over Argentina and Uruguay,
  scattered tropical cells over the Andes and the Amazon, and coastal cells off Mexico.

| Parameter | Default | Note |
|---|---|---|
| `eps_km` | 10 | About the size of a convective core |
| `eps_minutes` | 10 | Keeps a cell moving at 60 km/h connected |
| `min_pts` | 10 | 5 chained neighbouring cells into one; 15 left more flashes as noise |
| `overlap_minutes` | 30 | At least `eps_minutes`, so a cell crossing the hour stays whole in the next window |
| `hotspot_min_flashes`, `hotspot_min_hours` | 2000, 12 | Busy hot spots, over 24 h ([data quality](data-quality.md#fixed-hot-spots)) |
| `hotspot_pixel_days`, `hotspot_pixel_min_days`, `hotspot_pixel_min_flashes`, `hotspot_pixel_min_hours`, `hotspot_pixel_spread_km`, `hotspot_pixel_tight_km` | 3, 2, 300, 3, 1.0, 0.5 | Tight (last 24 h) and stuck (multi-day) pixels |
| `hotspot_radius_km` | 10 | Flashes dropped around each hot spot |

That day takes about 40 s end to end for 24 hourly windows in a single run.

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
