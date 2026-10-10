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
| Asset | `gold/storm_cells` | Flashes clustered into storm cells, hourly partitions with an overlap ([below](#storm-cells)) |
| Asset check | `valid_cells` | Blocking: unique ids, at least `min_pts` flashes, last flash inside the window |
| Schedule | `daily_gold_schedule` | Yesterday's partition at 01:30 UTC |
| Sensor | `silver_changed` | Example: rebuilds the open UTC day when `silver.flashes` gets a new snapshot (`daily` has `end_offset=1`) |
| Sensor | `alert_on_failure` | Posts failed runs to `SCINTILLE_ALERT_WEBHOOK` |

## Storm cells

`gold/storm_cells` runs ST-DBSCAN over `silver.flashes`, all sources together: two flashes are
neighbours when they are within `eps_km` on the sphere and `eps_minutes` in time, and a flash with at
least `min_pts` neighbours (itself included) is a core flash. Clusters below `min_pts` flashes are
dropped as noise.

- **Windows.** Partition `H` clusters the flashes of `[H - overlap, H + 1 h)` and keeps the cells with
  at least one flash in `[H, H + 1 h)`. A cell crossing the hour therefore appears in both windows,
  which is what storm tracking (#70) links. Counts summed over windows double count the overlap.
- **Rows.** One row per cell and window: `cell_id` (stable for the same input and parameters),
  window, first and last flash, flash count, centroid, bbox (`west > east` crosses 180°), convex hull
  as WKT with its area, sources, and the parameters used. Bbox and time range are the query bounds
  of the cell's flashes.
- **Writes.** Each run overwrites its hours. A backfill is a single run over the whole range, and the
  `storm-cells` pool keeps one run at a time.
- **Parameters** (run config, defaults below), tuned on GLM data of 2026-10-08 (2.5 M flashes) in
  three contrasted regions: a subtropical mesoscale convective system over Argentina and Uruguay,
  scattered tropical cells over the Andes and the Amazon, and coastal cells off Mexico.

| Parameter | Default | Note |
|---|---|---|
| `eps_km` | 10 | About the size of a convective core |
| `eps_minutes` | 10 | Keeps a cell moving at 60 km/h connected |
| `min_pts` | 10 | 5 chained neighbouring cells into one; 15 left more flashes as noise |
| `overlap_minutes` | 30 | At least `eps_minutes`, so a cell crossing the hour stays whole in the next window |

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

`uv run pytest` materializes the asset in-process on a SQLite catalog. `uv run pytest -m lake`
materializes it against the local Lakekeeper and tests the Postgres lock; the `lake` CI job runs both.
