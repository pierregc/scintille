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
| Asset | `gold/storm_tracks` | Each cell linked to a storm, one hourly window after the other ([below](#storm-tracking)) |
| Asset check | `valid_tracks` | Blocking: every cell once, at most one cell per storm and window |
| Asset | `gold/storms` | One row per storm with its track, rebuilt for the storms active in the hours |
| Asset check | `valid_storms` | Blocking: unique ids, one track point per step, positive flash counts |
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
  which is what [storm tracking](#storm-tracking) links. `flash_count` summed over windows double
  counts the overlap; `hour_flash_count` (flashes in the window's own hour) does not. A storm still
  active at `H - overlap` starts at that edge: its `t_start` is not a birth.
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

## Storm tracking

`gold/storm_tracks` links the cells of hour `H` to the storms of hour `H - 1`, read back from its own
previous partition (a self-dependency), so storms carry over hours and days.

- **Link.** A cell continues a cell of the previous window when it starts at most `max_gap_minutes`
  after that one ends, and their convex hulls intersect or the discs with the hulls' areas overlap
  once the earlier cell may have moved at `max_speed_kmh` during the gap. A cell crossing the hour
  is in both windows, so it overlaps itself.
- **Splits and merges.** Candidate pairs are taken by decreasing combined flash count, each storm
  and each cell at most once: the main branch keeps the storm. A cell split off starts a new storm
  with `split_from`; storms merged into a cell end there and are listed in its `merged`.
- **Ids.** A storm takes the `cell_id` of its first cell, so ids are stable while the cells are.
  Re-running an hour can change the storms of the later hours, which Dagster then shows as stale.
- **Rows.** `gold/storm_tracks` has one row per cell (step): storm id and start, the cell's time
  range, counts, centroid, bbox and hull (query bounds of its flashes). `gold/storms` has one row
  per storm: time range, steps, flash count (sum of `hour_flash_count`, each flash once), largest
  cell, flash-weighted centroid, bbox, sources, and the track (centroid per step at the middle of the
  cell's time range). `closed` is set once a later hour has been tracked without the storm.
- **Writes.** Tracks overwrite their hours. Storms are rebuilt from the tracks for every storm that
  started at or after the earliest start among the storms active in the run's hours or the hour
  before, so the run is idempotent. Backfills are single runs and the `storm-tracks` pool keeps one
  run at a time, since each hour needs the previous one.

| Parameter | Default | Note |
|---|---|---|
| `max_speed_kmh` | 100 | Only matters across a gap; cells crossing the hour overlap in space |
| `max_gap_minutes` | 30 | The overlap of the cell windows |

On GLM data of 2026-10-08 (9,791 cells), tracking takes about 13 s for the day in a single run and
gives 5,524 storms, 903 of them over three hours or more; every clustered flash is counted once.

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
