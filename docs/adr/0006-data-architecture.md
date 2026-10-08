# 0006 · Data architecture: hot path, Iceberg lakehouse on R2, Dagster batch

- Status: proposed
- Date: 2026-10-08

## Context

- **Volume.** About 45 flashes/s fall within GOES GLM and MTG LI coverage: 3.9 M flashes/day,
  1.4 G/year. The live feed (ADR 0004) is about 300 KB per 10 minutes. Full-precision silver rows
  (`FlashRecord`, 128-bit ids, Parquet zstd) measure 45 to 70 bytes per flash on synthetic data,
  so **150 to 250 MB/day, 50 to 100 GB/year**. This is more than the "few GB/year" first assumed,
  but still small for a single node.
- **Two latencies.** The globe needs flashes seconds after the product file lands. Storms,
  aggregates, replays, video and backfills can wait minutes to hours.
- **Infrastructure.** One Hetzner VPS (Docker) and Cloudflare R2. One maintainer: every moving part
  must earn its place.
- **History matters from M1.** A day not archived can never be replayed (#39). Raw archives stay
  with NOAA and EUMETSAT; we keep what we derive.

## Options

**Paths.** A single batch pipeline for everything cannot meet the live latency. A streaming
platform for everything (Kafka + Flink) meets it but is out of proportion at 45 events/s. Two
paths, a small always-on service and an orchestrated batch layer, split along the latency line.

**Table format and catalog.**
- *Plain Parquet files on R2*: simplest, but no atomic commits, no schema evolution, and every
  reader must know the layout.
- *Apache Iceberg on R2 Data Catalog* (now branded **Basin Catalog**): managed Iceberg REST catalog
  next to the data, with managed compaction and snapshot expiration. The issue flagged it as beta;
  **it became generally available on 2026-10-01** and is billed since 2026-08-03 ($9 per million
  catalog operations, $0.005/GB compacted, monthly free tier of 1 M operations and 10 GB
  compacted). Limits found in the docs: compaction target 64 to 512 MB, Parquet only; snapshot
  expiration defaults to 30 days / last 5 snapshots; **orphan files are not cleaned up**.
- *Self-hosted REST catalog (Lakekeeper, Postgres-backed) on the VPS*: same tables and code, one
  more service to run and back up, maintenance is ours.
- *Delta Lake or DuckLake*: fine formats, but no managed catalog on R2; Iceberg has the widest
  engine support.

**Engines.**
- *DuckDB Iceberg extension*: attaches a REST catalog and supports CREATE TABLE, INSERT, UPDATE,
  DELETE, MERGE INTO. Limits: UPDATE and DELETE only on **unsorted** tables, positional deletes
  only (merge-on-read), and Cloudflare's guide notes no DELETE on partitioned tables through its
  catalog. `silver.flashes` is partitioned and sorted (#23), so **DuckDB `MERGE` cannot be the
  silver write path** that #39 assumes.
- *PyIceberg*: Arrow-native writes, `upsert` keyed on an identifier field, partition overwrite,
  schema evolution, snapshot expiration; no compaction yet (the catalog does it).
- *Polars/Arrow*: parsing and normalization in the hot path, zero-copy to PyIceberg.

**Orchestration.** Dagster (software-defined assets, partitions, backfills, asset checks, lineage)
against Airflow (task-centric, weaker partition and lineage model) or cron (no backfills, no
checks, no UI).

**Transformations.** The issue asks for dbt-core with dbt-duckdb. Since then **dbt v2** (Rust
engine, GA 2026-09-14) ships a built-in DuckDB adapter, and **Iceberg REST catalogs in dbt
(`catalogs.yml`) are only supported in v2**, not in the Python `dbt-duckdb` adapter for dbt v1.
`dagster-dbt` supports the v2 engine (marked beta on the Dagster side). Plain Python assets for
gold would avoid dbt but lose its tests, docs and model lineage.

**Not used: Kafka, Spark, Flink.** 45 events/s, 4 M rows/day and under 100 GB/year fit one process
and one DuckDB on one machine. Distributed systems would add servers, cost and failure modes for
no gain. We reconsider when one of these holds:

| Tool | Reconsider when |
|---|---|
| Kafka (or a managed log) | sustained > 5,000 events/s, or more than one independent real-time consumer that needs replay, or ingestion split across hosts or regions |
| Spark | silver > 1 TB queried regularly, or a daily gold build on DuckDB no longer fits in 1 hour on a 32 GB node |
| Flink | stateful event-time processing (e.g. live storm tracking) needed in seconds at > 5,000 events/s, or state no longer fits in one process's memory |

Cloudflare Basin Pipelines (managed stream to Iceberg) was also set aside: append-only, no dedup,
and NetCDF parsing does not fit a Worker.

## Decision

**Hot path** (`scintille-ingest`, one asyncio process, #35): polls sources, keeps per-file state in
Postgres (exactly once per file), parses with Polars, publishes 30-second live chunks and the
manifest to R2 (ADR 0004), caches raw files in R2 for 30 days, and every 1 to 5 minutes commits
buffered flashes to `silver.flashes` and file rows to `bronze.ingest_log` **with PyIceberg**
(insert-only upsert on `flash_id`: ids are deterministic, so a known id is skipped, never
updated). The buffer is persisted locally until the commit succeeds.

**Lakehouse**: Apache Iceberg tables on R2 through **R2 Data Catalog (Basin Catalog)** with managed
compaction and snapshot expiration enabled. **Lakekeeper** is the fallback and the local
development catalog (#23), so the same code runs against both.

| Layer | Tables | Notes |
|---|---|---|
| Bronze | `bronze.ingest_log` (one row per source file: checksum, sizes, timings, counts); raw files under `raw/` with a 30-day R2 lifecycle rule | Postgres stays the operational state; the log is its analytical copy |
| Silver | `silver.flashes` (partitioned by `day(event_time)` and `source`, sorted by `event_time`), `silver.flashes_quarantine` | about 30 to 100 MB per partition and day: one or two files after compaction (target 64 MB and up) |
| Gold | storm cells, storms, tracks, aggregates, SLA metrics | small, rebuilt or incrementally appended by dbt |

**Batch** (`scintille-pipelines`): Dagster assets for gold, checks, backfills (#40, same parsing
code, PyIceberg partition overwrite for reprocessing), published JSON and Parquet exports.
**dbt v2 with its built-in DuckDB adapter** (Iceberg catalog via `catalogs.yml`), run through
`dagster-dbt`. **DuckDB** reads silver through the REST catalog and writes gold tables (no sort
order on gold, so DuckDB updates and deletes work). **PyIceberg** owns table definitions,
migrations and the silver writes.

## Consequences

- One always-on process and one Dagster deployment on one VPS; storage and catalog are managed.
- Live latency does not depend on the lakehouse: a catalog outage delays silver, never the globe.
- Two writers commit to silver (hot path and backfills), plus the catalog's compaction: commits
  must retry on optimistic-concurrency conflicts, and backfills should not target today's
  partitions.
- One commit per minute is about 45,000 commits/month: inside the free tier but worth tracking
  (catalog operations per day as a metric). Snapshot expiration must be set much shorter than
  the 30-day default (proposal: 3 days) or metadata grows with every micro-batch.
- Orphan files from failed commits are not cleaned by the catalog: a weekly Dagster check compares
  stored objects with referenced files and deletes the difference past a safety delay.
- Deviations from #22 that other tickets must absorb: #39 writes with PyIceberg, not DuckDB
  `MERGE`; #26 uses dbt v2, not dbt-core 1.x with `dbt-duckdb`; #27 sets snapshot expiration and
  adds orphan cleanup; volumes in docs are 50 to 100 GB/year. If `dagster-dbt` support for dbt v2
  proves unstable, the fallback is dbt-core 1.x with `dbt-duckdb` writing gold as Parquet, not
  Iceberg.
- Thresholds above are tracked as metrics (events/s, silver size, gold build time) so that
  outgrowing this design is visible before it hurts.

## Sources

- R2 Data Catalog (Basin Catalog) overview: https://developers.cloudflare.com/r2/data-catalog/
- Table maintenance: https://developers.cloudflare.com/r2/data-catalog/table-maintenance/
- DuckDB with R2 Data Catalog: https://developers.cloudflare.com/r2/data-catalog/config-examples/duckdb/
- Basin GA and billing changelog: https://developers.cloudflare.com/changelog/product/basin/
- Pricing: https://developers.cloudflare.com/changelog/post/2026-05-11-r2-data-catalog-pricing-announced/
- DuckDB Iceberg extension: https://duckdb.org/docs/current/core_extensions/iceberg/overview.html
- DuckDB writing to Iceberg: https://duckdb.org/docs/current/core_extensions/iceberg/writing_to_iceberg.html
- PyIceberg API: https://py.iceberg.apache.org/api/
- dbt Iceberg support for DuckDB: https://docs.getdbt.com/docs/build/iceberg/adapters/duckdb-iceberg-support
- dbt v2 DuckDB adapter: https://docs.getdbt.com/docs/local/connect-data-platform/duckdb-setup
- DuckDB in dbt v2: https://duckdb.org/2026/09/22/dbt-fusion
- dbt engine v2 in Dagster: https://dagster.io/blog/dbt-fusion-support-comes-to-dagster
- Lakekeeper: https://docs.lakekeeper.io/
