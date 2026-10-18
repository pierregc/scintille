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
`DAGSTER_POSTGRES_URL` (locally `postgresql+psycopg2://postgres:postgres@localhost:55432/scintille`).
Dagster's storage needs the `psycopg2` driver named in the URL: with psycopg 3, the SQLAlchemy 2.1
default for `postgresql://`, every event write fails on `NOTIFY` and runs never start (#271).

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
| Asset | `gold/storm_tracks` | Each cell linked to a storm, one hourly window after the other ([below](#storm-tracking)) |
| Asset check | `valid_tracks` | Blocking: every cell once, at most one cell per storm and window |
| Asset | `gold/storms` | One row per storm with its track, rebuilt for the storms active in the hours |
| Asset check | `valid_storms` | Blocking: unique ids, one track point per step, positive flash counts |
| Asset | `gold/storm_levels` | Intensity level of each storm, updated while it is active ([below](#storm-levels)) |
| Asset check | `valid_levels` | Blocking: one level per storm, within the rule, from positive counts |
| Asset | `gold/storm_names` | Place name and slug of each new storm, from embedded open data ([below](#storm-names)) |
| Asset check | `unique_slugs` | Blocking: one name per storm, no slug used twice |
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
  which is what [storm tracking](#storm-tracking) links. `flash_count` summed over windows double
  counts the overlap; `hour_flash_count` (flashes in the window's own hour) does not. A storm still
  active at `H - overlap` starts at that edge: its `t_start` is not a birth.
- **Rows.** One row per cell and window: `cell_id` (window and earliest flash, by time then id),
  window, first and last flash, flash count, centroid, bbox (`west > east` crosses 180°), convex hull
  as WKT with its area, sources, and the parameters used. Bbox and time range are the query bounds
  of the cell's flashes. `minute_counts` holds the in-hour flashes per source and minute, for
  [storm levels](#storm-levels).
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
  is in both windows, so it overlaps itself. A storm with no linked cell in a window ends there, so
  `max_gap_minutes` only bridges gaps inside the overlap, and a cell falling under `min_pts` for one
  window splits the storm in two.
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
  run at a time, since each hour needs the previous one. A run fails when the hour before it was
  never tracked; `new_chain` starts storms from scratch instead.

| Parameter | Default | Note |
|---|---|---|
| `max_speed_kmh` | 100 | Only matters across a gap; cells crossing the hour overlap in space |
| `max_gap_minutes` | 30 | The overlap of the cell windows |

On GLM data of 2026-10-08 (9,791 cells), tracking takes about 13 s for the day in a single run and
gives 5,524 storms, 903 of them over three hours or more; every clustered flash is counted once.

## Storm levels

`gold/storm_levels` gives each storm an intensity level for the public, as analysed in
[ADR 0009](adr/0009-storm-intensity-levels.md). The defaults are the accepted thresholds; its
variants remain a run config change, with no code change.

- **One satellite.** Where the GLM East and West views overlap, most flashes are in silver twice.
  Per storm, the flashes per source and minute are summed from the `minute_counts` of its cells;
  each source gets `flashes` (its total) and `peak_rate` (its busiest minute), and the source with
  the highest score is kept as `level_source`. With `count: all_sources`, sources are summed
  instead, for flashes already deduplicated upstream (for example by dropping silver rows flagged
  `outside-owner-zone` before counting the cells).
- **Score and level.** `flashes_x_peak` scores `sqrt(flashes × peak_rate)`, `flashes` scores the
  count alone. A storm is at level `k + 1` once its score reaches the `k`-th threshold; levels start
  at 1 and `level_name` comes from `names`. `level_rule` records the score, count and thresholds.
- **Live storms.** Both measures only grow with each hour, so a level rises and never drops. As a
  guard against re-run hours, a storm that was still active keeps its previous level when the new
  score is lower under the same `level_rule`. A rule change recomputes every storm it touches.
- **Writes.** Same range as `gold/storms` (every storm since the earliest start among the active
  ones), overwritten, so runs are idempotent. Cells written before `minute_counts` existed give no
  level until their hours are re-materialized; the run metadata counts them as `unclassified`.

| Option | `score` | `thresholds` | `names` |
|---|---|---|---|
| Accepted (default) | `flashes_x_peak` | 8, 25, 120, 450 | Light, Moderate, Strong, Intense, Exceptional |
| Variant A | `flashes_x_peak` | 10, 50, 450 | Light, Moderate, Strong, Exceptional |
| Variant B | `flashes` | 25, 100, 750, 4000 | Light, Moderate, Strong, Intense, Exceptional |

`count` defaults to `best_source`. Over the 29 days of the ADR (159,412 closed storms), the defaults
give 50.5 %, 29.7 %, 15.1 %, 3.8 % and 1.0 % from Light to Exceptional, within 30 storms per level
of the ADR table.

## Storm names

`gold/storm_names` names each storm once, the first time `gold/storms` has it, from its
flash-weighted centroid at that time. Rows are only appended, so a name and its slug never change,
and re-running an hour is a no-op. The name describes where the storm started, even if it drifts
later. If storms are rebuilt and a `storm_id` disappears, its name stays; the run metadata counts
these `orphans` among the storms starting in its hours. Lookups are offline, against reference data embedded in the
package (`scintille_pipelines/geodata/`, about 1.5 MB).

- **Land** (inside a Natural Earth country): the most notable GeoNames city of the same country
  within 50 km (a city 10 times larger wins when it is at most 20 km further), with its admin-1
  region: "Ajaccio, Corsica, France". Further than that, the region of the nearest city of the
  country within 200 km ("Amazonas, Brazil"), else the country.
- **Offshore**: the smallest Natural Earth marine area containing the point (the nearest one in the
  rare gaps), and a city of any country within 40 km: "Mediterranean Sea, off Nice, France". Further
  out, the sea alone: "Gulf of Mexico", "North Atlantic Ocean".
- **Columns.** `name` is the short name (city, region, country or sea), `label` the full one;
  `place`, `region`, `country_code` (ISO 3166-1 alpha-2, as in `gold.region_daily`, land only),
  `country_name`, `sea` and `offshore` are kept for pages and regional aggregates, with `geodata`, the
  reference data version.
- **Slugs.** `YYYY-MM-DD-<name>` (UTC day of the first flash, ASCII, at most 60 characters for the
  name), `YYYY-MM-DD-off-<city>` off a coast, then `-2`, `-3`… in order of first flash when taken.

On the storms of 2026-10-08 (4,774), naming takes 0.2 s: 1,406 near a city, 1,502 by region, 247 by
country, 103 off a coast and 1,516 by sea. Open oceans give long suffix series (555 storms in the
North Pacific Ocean that day), mostly small storms.

### Reference data

| File | Source | License |
|---|---|---|
| `countries.geojson.gz` | [Natural Earth](https://www.naturalearthdata.com/) v5.1.2, 1:50m admin-0 countries (same file and checksum as `gold.region_daily`) | Public domain |
| `marine.geojson.gz` | Natural Earth v5.1.2, 1:10m marine areas (oceans, seas, gulfs, bays, straits…) | Public domain |
| `places.tsv.gz` | [GeoNames](https://www.geonames.org/) `cities15000` and `admin1CodesASCII` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): credit GeoNames wherever the names are shown |

Coordinates are rounded to 0.001°. `manifest.json` records each source's URL and checksum; Natural
Earth checksums are pinned, GeoNames dumps change daily, so the snapshot date is the version.
Rebuild with `uv run python -m scintille_pipelines.geodata.build` from `data/`.

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
store, probes the DuckDB write path, tests the Postgres lock and runs a job on Dagster's Postgres storage; the `lake` job of the manual `images` workflow runs the second.

## Storm catalog publication

`feeds/storm_catalog` exports `storms/<slug>.json`, immutable replay chunks, zero-based index pages
of 50 summaries and XML sitemaps. `hourly_storm_catalog` materializes its upstream storm assets;
`storm_catalog_schedule` targets the previous hour at minute 20 UTC and is **stopped by default**.
A storm starting at the beginning of an hour therefore reaches publication after 80 minutes when
silver is available and the run succeeds, within the two-hour target.

Classification (#183/#72) is on main and ADR 0009 is accepted. Before activation, materialize
missing historical `minute_counts` and levels, and bootstrap tracking sequentially
through the hour before the schedule's first run. The publisher requires a name and persisted
classification for every indexed storm; it never supplies classification defaults. A missing
upstream partition stops the run rather than silently starting a new storm chain. Recovery runs
should cover skipped hours in order; an hourly schedule alone does not repair missing partitions.

Replay uses event-time hour chunks of at most 65,536 flashes, encoded with the live SCNT layout.
Metadata is at most 256 KiB. An oversized export is logged and skipped, retaining its previous
detail and summary when available.
The current extraction selects each track step's spatial bounds in its own hour and deduplicates
flash ids. `replay.selection = "track-bounds"` explicitly permits unrelated nearby flashes; its
count is distinct from classified `storm.flashes`. It is not an exact cell membership export.
No archive cloud manifest exists yet; historical cloud frame discovery remains #79's prerequisite.

All replay chunks are written before their metadata, then all detail files before index pages,
then sitemap parts before their sitemap index. A durable published-slug ledger avoids fetching every archived detail on each run. Old detail and
chunk files are retained, so an
interrupted update leaves old references readable. This job does not remove orphaned files.
Regional sitemaps discover detail objects already published under `regions/` by #75, including
covered countries with no storms. Indexes are rebuilt over the full catalog in the batch
pipeline; a web request only reads the requested page.

`SCINTILLE_PURGE_TOKEN` and `SCINTILLE_CF_ZONE_ID` enable batched cache tag purges. Changed closed
storms queue `storm:<slug>`, affected `region:<CC>` tags and `storms-index` before detail writes.
Pending tags are stored in `_pipeline/storms/purge.json` in the feed bucket. Failure or missing
credentials leaves the queue intact and does not fail publication. One batch of at most 100 tags
is attempted per hourly run; the remainder retries next run, below the Free request limit.

Historical bootstrap exports at most 100 previously unpublished storms per run, oldest first.
Storms touched in the current and previous hour always take priority and are not counted against
that cap. The public index includes only storms whose detail exists; history drains incrementally.
Invalid exports are logged and counted in run metadata. Oversized or invalid updates retain their
previous public detail and summary; invalid new storms stay out of the index and sitemap.
Region availability uses HEAD requests, and mixed storm/region sitemaps are named `pages-N.xml`.
