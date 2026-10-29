# Lakehouse

Iceberg tables behind a REST catalog ([ADR 0006](adr/0006-data-architecture.md)): R2 Data Catalog in
production, Lakekeeper locally. Definitions live in code, in `data/packages/scintille-lake`.

## Tables

| Table | Partitioning | Notes |
|---|---|---|
| `bronze.ingest_log` | `day(product_start)` | One row per product file |
| `silver.flashes` | `day(event_time)`, `source`; sorted by `event_time` | Rows carry `parser_version` and `calibration_version` ([methodology](methodology.md#flash-intensity)); `intensity` null on rows ingested before #33 |
| `silver.flashes_quarantine` | `day(ingest_time)` | Rejected rows as JSON, with the reason |
| `gold.*` | per table | Created through `gold_table()`, which sets merge-on-read |

All tables are Iceberg format v2 with zstd Parquet.

## Migrate

```sh
cd data
uv run scintille-lake migrate
```

It creates missing namespaces and tables, adds new optional columns, makes required columns optional
when the code says so, and restores table properties.
A second run prints `up to date`. It refuses anything else.

## Schema evolution policy

Allowed without a new table version, applied by `migrate`:

- adding an **optional** top-level column (old rows read it as null);
- making a required top-level column optional (old rows keep their values);
- changing a table property declared in code.

Refused by `migrate`, and needing a new table (for example `silver.flashes_v2`) plus a backfill:

- removing, renaming or retyping a column, or making it required;
- adding a required column;
- changing the partitioning or the sort order.

Tests in `test_migrate.py` cover each case.

## Maintenance

Per [ADR 0006](adr/0006-data-architecture.md), R2 Data Catalog runs compaction and snapshot
expiration; we only configure and watch them. Values live in `MaintenancePolicy`
(`scintille_lake.maintenance`), each overridable by an environment variable:

| Setting | Default | Variable |
|---|---|---|
| Compaction target file size | 128 MB (R2 accepts 64 to 512) | `SCINTILLE_COMPACTION_TARGET_MB` |
| Snapshot expiration | 3 days | `SCINTILLE_SNAPSHOT_RETENTION_DAYS` |
| Snapshots always kept | 5 | `SCINTILLE_SNAPSHOTS_RETAINED_MIN` |
| Orphan inventory minimum file age | 7 days, must exceed snapshot expiration | `SCINTILLE_ORPHAN_MIN_AGE_DAYS` |
| Silver retention, whole days dropped by `silver_retention` at 03:40 UTC | 21 days, at least 7 | `SCINTILLE_SILVER_RETENTION_DAYS` |

The snapshot defaults are the ADR 0006 values; the retention decision (#41) may change
them. A read-only `scintille-lake retention-report` command and the
[retention measurement runbook](retention.md) collect evidence for the proposed policy. The catalog token in Terraform has no catalog permission, so the policy is applied by hand:

```sh
cd data
uv run scintille-lake maintenance     # prints the two wrangler commands below
npx wrangler basin catalog compaction enable scintille-lake --token $R2_CATALOG_TOKEN --target-size 128
npx wrangler basin catalog snapshot-expiration enable scintille-lake --token $R2_CATALOG_TOKEN --older-than-days 3 --retain-last 5
```

Runs show in the dashboard, under each table's Maintenance tab.

Orphan files are **inventoried, never deleted**: `orphan_inventory` lists objects under a table's
location that no metadata version, snapshot, manifest list or manifest entry (deleted entries
included) references, and that are older than the minimum age. Deletion waits for a procedure tested
with concurrent compaction and old snapshots. Dagster checks prove maintenance works
([pipelines](pipelines.md)).

## Connections

Both read the same environment:

| Variable | Local default | Production |
|---|---|---|
| `SCINTILLE_LAKE_URI` | `http://localhost:8181/catalog` | R2 Data Catalog URI |
| `SCINTILLE_LAKE_WAREHOUSE` | `scintille` | R2 warehouse name |
| `SCINTILLE_LAKE_TOKEN` | unset | Cloudflare API token with R2 Data Catalog access |

- PyIceberg: `scintille_lake.connect.pyiceberg_catalog()`.
- DuckDB: `scintille_lake.connect.duckdb_attach(con)`, then `SELECT … FROM lake.silver.flashes`. Only
  reads are tested so far; any DuckDB write path is tested on the pinned versions before use.

## Local lakehouse

`compose.yaml` at the repository root runs Lakekeeper on Postgres, with Silo as the S3-compatible
store. It is for development and tests only and never points at production.

```sh
docker compose up -d --wait lakekeeper && docker compose run --rm lake-init
cd data && uv run scintille-lake migrate && uv run pytest -m lake
```

The `lake` job of the manual `images` workflow does the same. `docker compose down -v` resets everything.
