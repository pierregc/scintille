# 0006 · Data architecture: hot path, Iceberg lakehouse on R2, Dagster batch

- Status: accepted
- Date: 2026-10-09

## Context

- **Volume (estimate, to be measured).** We assume about 45 flashes/s within GOES GLM and MTG LI
  coverage: 3.9 M flashes/day, 1.4 G/year. This is a planning figure, not a measurement: the often
  quoted ~44 flashes/s is a global estimate from older instruments, and our real rate depends on
  coverage and on what GLM and LI detect. Silver rows measured 45 to 70 bytes per flash on
  synthetic data (Parquet zstd), so about **65 to 100 GB/year**, plus the 30-day raw cache and
  Iceberg metadata. All figures are re-checked on real files during the first weeks of ingestion.
- **Two latencies.** The globe needs flashes seconds after the product file lands. Storms,
  aggregates, replays, video and backfills can wait minutes to hours.
- **Infrastructure.** One Hetzner VPS (Docker) and Cloudflare R2. One maintainer: every moving part
  must earn its place.
- **Replay.** NOAA keeps the GLM archive and EUMETSAT keeps an LI archive (depth and access to be
  confirmed), so a missed day can be re-ingested, at a cost. Archiving from M1 avoids depending on
  that.

## Options

**Paths.** A single batch pipeline cannot meet the live latency. A streaming platform for everything
(Kafka + Flink) meets it but is out of proportion at tens of events per second. Two paths, a small
always-on service and an orchestrated batch layer, split along the latency line.

**Table format and catalog.**
- *Plain Parquet on R2*: simplest; no atomic multi-file commits, and schema versions, compaction and
  publication rules would all be ours to define.
- *Apache Iceberg on R2 Data Catalog (Basin Catalog)*: managed Iceberg REST catalog next to the data,
  generally available since 2026-10-01, with managed compaction (target 64 to 512 MB) and snapshot
  expiration. Billed per catalog operation, per GB compacted and per object processed by compaction,
  each with a monthly free tier. Orphan files are not cleaned up.
- *Self-hosted REST catalog (Lakekeeper)*: used for local development. It is a portability option,
  not an automatic failover: moving would mean registering tables from their current metadata,
  switching every writer, and never letting two catalogs write the same tables.
- *DuckLake*: attractive in a DuckDB-centred stack, but it needs a catalog database we would run
  ourselves, and fewer engines read it. *Delta Lake*: no managed catalog on R2.

**Engines.** Polars/Arrow for parsing and normalization; NetCDF decoding with `netCDF4` (#30).
PyIceberg for table definitions and silver writes (append with snapshot properties, partition
overwrite). DuckDB to read silver and write gold through the REST catalog; its Iceberg writes are
merge-on-read and restricted on sorted tables, and the Cloudflare guide and DuckDB docs disagree on
deletes for partitioned tables, so any DuckDB write path is tested on our pinned versions first.

**Orchestration.** Dagster: assets, partitions, backfills, asset checks and lineage are first-class.
Airflow 3 now has assets and partitions too; Dagster is preferred for its asset-first model and
checks, not because Airflow cannot do it. Cron alone has no backfills, checks or UI.

**Transformations.** dbt's native Iceberg catalog support for DuckDB exists only in dbt v2, and
Dagster's integration with it is a preview. Gold models start as versioned SQL files run by Dagster
assets on DuckDB, with asset checks as tests. dbt is reconsidered once that integration is stable,
after a prototype covering incremental models, tests, failures and backfills; the SQL files are
written so that the move is mechanical.

**Not used: Kafka, Spark, Flink.** One process and one DuckDB on one machine fit this volume.
These are triggers to re-evaluate, not hard limits:

| Tool | Re-evaluate when |
|---|---|
| Kafka (or a managed log) | sustained thousands of events/s, several independent real-time consumers needing replay, or ingestion split across hosts |
| Spark | silver near 1 TB queried regularly, or the daily gold build no longer fits in an hour on one large node |
| Flink | live stateful event-time processing (e.g. storm tracking in seconds) at a rate one process cannot hold |

Cloudflare Basin Pipelines was set aside: append-only, so producer-side idempotence would remain
ours, for one more moving part.

## Decision

**Hot path, two processes** (#35):
- `ingest-live` polls sources, parses, publishes 30-second live chunks and the manifest (ADR 0004),
  caches raw files in R2 for 30 days, and writes each normalized micro-batch to a **local durable
  spool** (one Parquet file per batch, fsynced, named by a deterministic `batch_id`). It never calls
  the catalog.
- `lake-writer` drains the spool every 5 minutes: it appends each batch to `silver.flashes` and
  `bronze.ingest_log` with PyIceberg, storing the `batch_id` in the snapshot properties, then
  deletes the spool file. Bounded memory and retries; it can be stopped without affecting the live
  feed.

**Delivery guarantee: at least once, with idempotent effects.**
- File identity is the full object key plus its checksum, so a revised product is a new file.
- Postgres tracks each file through `downloaded`, `published_live` and `spooled`; each step is
  idempotent and re-runnable.
- `batch_id` is derived from the batch's file identities. If a commit outcome is unknown,
  `lake-writer` looks for that `batch_id` in recent snapshot properties before retrying, so a batch
  is never appended twice.
- No upsert against history: deduplication by lookup on a hash id would scan ever more data as the
  table grows. A daily asset check verifies `flash_id` uniqueness on closed partitions only, and a
  violation triggers a rebuild of that partition.
- A daily reconciliation compares Postgres, `bronze.ingest_log` and silver counts per source and
  hour (#25).

**Reprocessing and corrections** (#40): backfills rebuild **whole partitions** (`day × source`) from
every source file of that day, check completeness against the expected file count, then overwrite.
Never a partial overwrite. One writer per partition at a time (Postgres advisory lock shared by
`lake-writer` and backfills). Rows carry `parser_version` and `calibration_version`, so a correction
is a traceable rebuild, not an in-place update.

**Lakehouse**: Iceberg on R2 Data Catalog with managed compaction. Snapshot expiration: 3 days
(about 860 snapshots per table at one commit every 5 minutes), a deliberate trade-off between
metadata size and rollback window; bad rewrites are caught by the daily checks well within it.
Orphan files: weekly **inventory only** (no deletion) until a proven procedure exists, tested with
concurrent compaction and old snapshots, with a safety delay longer than any write or retry.

| Layer | Tables | Notes |
|---|---|---|
| Bronze | `bronze.ingest_log`; raw files under `raw/` with a 30-day lifecycle rule | Postgres is the operational state; the log is its analytical copy |
| Silver | `silver.flashes` (partitioned by `day(event_time)` and `source`, sorted by `event_time`), `silver.flashes_quarantine` | append by `lake-writer`, rebuild by backfills |
| Gold | storm cells, storms, tracks, aggregates, SLA metrics | DuckDB SQL run by Dagster; tables set to merge-on-read |

**Batch** (`scintille-pipelines`): Dagster assets for gold, checks, backfills and published JSON.

## Consequences

- **Spool sizing.** About 1 MB per 5 minutes, 300 MB/day: days of catalog outage fit on the VPS
  disk. Alerts at 50% and 80% disk use; past 90%, the raw cache upload is paused before anything
  else. Losing the VPS loses the spool: recovery is a backfill from upstream archives.
- **Freshness is visible per layer.** `metrics.json` exposes the live feed age, silver lag and gold
  age separately, so storm pages can say how fresh they are while the globe stays live.
- **Live latency.** Publishing at chunk close adds up to 30 s to the ~30 s measured on GLM (#30);
  ADR 0004's chunk size is revisited if that matters.
- **Catalog operations.** One commit every 5 minutes on two tables is about 17,000 commits per
  month, each several catalog operations: tracked as a metric against the free tier.
- **Proofs live in the implementation tickets**, as acceptance criteria: crash after commit but
  before acknowledgement (#35, #39), replay without duplicates (#39), partial backfill without loss
  (#40), catalog outage without live impact (#35), orphan inventory preserving retained snapshots
  (#27), uniqueness check cost on a large partition (#25).
- Tickets to update after acceptance: #23, #24, #25, #26, #27, #35, #39, #40.

## Sources

- R2 Data Catalog: https://developers.cloudflare.com/r2/data-catalog/
- Table maintenance: https://developers.cloudflare.com/r2/data-catalog/table-maintenance/
- Pricing and GA: https://developers.cloudflare.com/changelog/product/basin/
- DuckDB with R2 Data Catalog: https://developers.cloudflare.com/r2/data-catalog/config-examples/duckdb/
- DuckDB Iceberg writes: https://duckdb.org/docs/current/core_extensions/iceberg/writing_to_iceberg.html
- Iceberg spec (row identity not enforced): https://iceberg.apache.org/spec/
- Iceberg maintenance (orphan files): https://iceberg.apache.org/docs/latest/maintenance/
- Iceberg write properties: https://iceberg.apache.org/docs/latest/configuration/
- PyIceberg API (append, snapshot properties, overwrite, upsert): https://py.iceberg.apache.org/api/
- dbt Iceberg support for DuckDB: https://docs.getdbt.com/docs/build/iceberg/adapters/duckdb-iceberg-support
- dbt v2 in Dagster (preview): https://dagster.io/blog/dbt-fusion-support-comes-to-dagster
- Airflow assets: https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/assets.html
- DuckLake: https://ducklake.select/docs/
- Lakekeeper: https://docs.lakekeeper.io/
- NOAA GLM archive: https://www.ncei.noaa.gov/
