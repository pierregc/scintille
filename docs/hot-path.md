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
2. **live feed**: parsed flashes go to the publisher (#36), which must be idempotent by `flash_id`,
   except those flagged `outside-owner-zone`: another satellite has the better view of their point
   and publishes the same flash ([overlap](data-quality.md#overlap-between-satellites)); they are
   counted in `ingest_live_excluded_total` and still spooled. While the owner has spooled no file
   for 5 minutes (`owner_stale_after`), they stay in the live feed so its zone does not go dark. A
   file with nothing left to publish still refreshes the source's `last_ingest_time`; state
   `published_live`;
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

## Live feed

When `SCINTILLE_LIVE_BUCKET` is set, `ingest-live` publishes the live feed of the
[data contract](data-contract.md#live-feed-on-r2): every 30 s (on whole multiples of 30 s) the flashes
received since the previous chunk become one gzip chunk under `live/chunks/`, then
`live/manifest.json` is rewritten, then chunks older than 60 minutes are deleted. A chunk that fails
to upload keeps its flashes for the next one, and the manifest only lists chunks already stored.
Flashes are deduplicated by `flash_id` over the hour, so a file published again after a crash adds
nothing. Source state: `live` if a file arrived in the last 2 minutes, `delayed` up to 10, then
`offline`. `live_latency_seconds` (event time → manifest) is logged and exported per source.
Intensity uses a provisional log-energy mapping until #33.

`publish()` returns only once the flashes are in the outbox (`<spool>/live-outbox/`, fsynced), so
the file state can advance safely. A chunk's flashes leave the outbox only after a manifest lists
that chunk; their ids stay for an hour for deduplication. On restart, the chunk list of the
published manifest is continued and every flash not listed yet goes into the next chunk.

## `lake-writer` (`scintille-ingest lake-writer`)

Drains the spool every 5 minutes, up to 200 batches per commit:

1. takes the Postgres advisory lock of every partition it writes (`silver.flashes/<day>/<source>`,
   shared with backfills, #40), in sorted order;
2. writes to `silver.flashes`, then `bronze.ingest_log`, only the batches each table does not hold
   yet; the batch ids go into the snapshot property `scintille.batch_ids`. Each write is one Iceberg
   overwrite filtered on the batches' product files, so an upstream revision of a file (same key,
   new ETag) replaces the rows of the previous one instead of adding to them;
3. deletes the spool files.

A crash anywhere replays the drain: batches found in a table's snapshots are skipped, so nothing is
appended twice, and a batch committed to silver but not bronze completes bronze only. If the catalog
is down, the batches stay in the spool and the next drain retries; `ingest-live` never notices.
`intensity` stays null until the cross-source calibration (#33). Catalog operations are counted in
`catalog_operations_total`.

## Run locally

```sh
docker compose -f infra/compose/compose.local.yaml up -d --build --wait ingest lake-writer
curl -s localhost:8080/metrics   # from inside the stack: docker compose ... exec ingest ...
```
