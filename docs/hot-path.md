# Hot path

Two processes from the `scintille-ingest` image ([ADR 0006](adr/0006-data-architecture.md)), so the
lakehouse can never slow down or stop the live feed.

## `ingest-live` (`scintille-ingest live`)

One asyncio task per source (GLM East, GLM West; MTG LI with #32). Each lists its bucket on its own
cadence and takes every file not spooled yet (a known key listed with a new ETag counts as not
spooled) through:

1. **download**: file identity = object key + SHA-256 (a revised product is a new file); original
   uploaded to R2 under `raw/<source>/<key dir>/<checksum>_<name>` (`SCINTILLE_R2_*`, deleted after
   30 days by the bucket rule; best effort, paused past 90 % spool disk); state `downloaded`;
2. **live feed**: parsed flashes go to the publisher (#36), which must be idempotent by `flash_id`;
   state `published_live`;
3. **spool**: per batch, its flashes and its `bronze.ingest_log` rows as Parquet, each written to a
   temporary name, fsynced, then renamed (flashes last, so they mark a complete batch); `batch_id` =
   hash of the batch's file identities (one file per batch today), so a re-run writes the same batch
   again; state `spooled`.

An unreadable file is not retried forever: it gets a `failed` log row, no flashes, and is spooled
like any other, so the failure shows in `bronze.ingest_log`.

States live in Postgres (`ingest_files`) and only move forward, so a step replayed after a crash
changes nothing. It never calls the catalog. A failing source backs off exponentially (5 s to 5 min)
without delaying the others. SIGTERM lets files in progress finish (30 s).

- `GET :8080/healthz`: 200 while every loop runs (container healthcheck, #20).
- `GET :8080/metrics`: Prometheus text (files, flashes, errors, lag per source, spool size, disk use).
- Logs: one JSON object per line.
- Disk: warnings at 50 % and 80 %; past 90 %, raw cache uploads pause first.

## `lake-writer` (`scintille-ingest lake-writer`)

Drains the spool every 5 minutes. The commit to `silver.flashes` and `bronze.ingest_log` arrives
with #39; until then it reports the backlog and leaves the spool untouched.

## Run locally

```sh
docker compose -f infra/compose/compose.local.yaml up -d --build --wait ingest lake-writer
curl -s localhost:8080/metrics   # from inside the stack: docker compose ... exec ingest ...
```
