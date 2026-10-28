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
   for 5 minutes (`owner_stale_after`; 15 for MTG LI, which delivers every 10, in
   `owner_stale_after_by_source`), they stay in the live feed so its zone does not go dark. A
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

- `GET :8080/healthz`: 200 while every loop runs (container healthcheck).
- Heartbeat: a Healthchecks.io ping every minute when `SCINTILLE_HEALTHCHECK_URL` is set
  ([operations](operations.md)).
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
`offline`; the delays are set in seconds by `SCINTILLE_SOURCE_DELAYED_AFTER` and
`SCINTILLE_SOURCE_OFFLINE_AFTER`. After its first chunk the process writes `live/coverage.geojson`
([coverage map](data-contract.md#coverage-map)) if the stored copy differs, retrying on the next
chunk after a failure. `live_latency_seconds` (event time → manifest) is logged and exported per source.
Intensity is computed at parse time by the current calibration
([methodology](methodology.md#flash-intensity)).

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
Rows carry the `intensity` and `calibration_version` of the calibration they were parsed with. Catalog operations are counted in
`catalog_operations_total`.

## `clouds` (`scintille-ingest clouds`)

Cloud textures from NOAA GMGSI longwave IR ([ADR 0007](adr/0007-cloud-source.md)), in its own
container so the CPU work never delays the live feed (compose profile `clouds`).

Every minute it lists the last 7 hour prefixes of `noaa-gmgsi-pds` (`GMGSI_LW/`; a new hourly
mosaic lands about 40 minutes after its nominal time) and, oldest first, takes every mosaic of the
last 6 hours that the manifest does not list yet, or lists under another file name (a revision):

1. **brightness temperature**: 8-bit counts to kelvin on the McIDAS IR scale
   (`330 - c/2` up to 176, then `418 - c`), on the source's Mercator grid (0.072°, ±72.7°);
2. **surface reference**: GFS skin temperature (`TMP:surface`, 0.25°) valid at the frame's hour,
   from the newest cycle that has it, read with one range request from `noaa-gfs-bdp-pds` through
   the `.idx` file and decoded with ecCodes. When GFS is late, the nearest field fetched in the
   last 24 hours is reused; the manifest names the field used (`reference`);
3. **opacity**: `smoothstep(4 K, 32 K, T_surface - BT)` on a 4096 × 2048 equirectangular grid
   (bilinear on both inputs), faded out between 68° and 72.7° and 0 without data;
4. **publish**: grayscale WebP (q70) per tier, `2k` and `4k`, then the manifest, then the live
   textures that left the window ([format](data-contract.md#cloud-frames-on-r2)). The same textures
   go to `archive/clouds/<tier>/<yyyy>/<mm>/<dd>/` (30 days, bucket lifecycle rule; #41).

The manifest is the only state: on restart the service continues it. A failing poll backs off
(1 to 10 minutes). One frame takes about 2 s of CPU and 1.4 MB of textures.

- `GET :8081/healthz`, `GET :8081/metrics`: `cloud_frames_total`, `cloud_errors_total`,
  `cloud_frame_age_seconds` (nominal time → published) and `cloud_publish_delay_seconds` (upstream
  object → published, which should stay under 2 minutes).

With `--source composite` (or `SCINTILLE_CLOUD_SOURCE=composite`), it builds the hourly composite of
[ADR 0023](adr/0023-composite-clouds.md) instead:

1. **wait** for the full disk scans starting at the hour: GOES-19 and GOES-18 ABI bands 2 and 13
   (`noaa-goes19`, `noaa-goes18`), Himawari-9 AHI bands 3 and 13 (`noaa-himawari9`, ten segments
   each) and the MTG FCI high resolution repeat cycle of the hour (EUMETSAT Data Store, 40 chunks,
   `SCINTILLE_EUMETSAT_*`). After 45 minutes it goes on with the satellites that arrived;
2. **decode** each disk into memory-mapped arrays under `SCINTILLE_CLOUD_WORK_DIR`: 1 km
   reflectance (0.5 km bands averaged), 2 km (1 km for FCI) brightness temperature;
3. **render** tiles of levels 3 to 5 in `SCINTILLE_CLOUD_WORKERS` processes: parallax-corrected,
   view-angle weighted blend, opacity against the GFS skin temperature, visible detail by day,
   GMGSI where no disk sees well;
4. **publish** the tiles under `archive/clouds/detail/`, then the `2k` and `4k` textures and the
   manifests as above. The work directory is emptied after each frame.

`cloud_render_seconds` reports the decode and render time of the last frame.

## Run locally

```sh
docker compose -f infra/compose/compose.local.yaml up -d --build --wait ingest lake-writer clouds
curl -s localhost:8080/metrics   # from inside the stack: docker compose ... exec ingest ...
```
