# 0025 · Past days in Travel in time: an hourly flash archive

- Status: accepted (21 days, 29 October)
- Date: 2026-10-29

## Context

Travel in time only moves the scene clock. Outside a storm replay, flashes come from the live
manifest, whose chunks are deleted after one hour, so any earlier time shows clouds and no
lightning (#344). Clouds come from the daily indexes of [ADR 0014](0014-historical-cloud-discovery.md),
which start on 17 October; older textures are in `archive/clouds/` but nothing points to them, so
15 October shows nothing (#345). The calendar offers any date.

Measured on 29 October:

| Data | Kept since | Retention |
| --- | --- | --- |
| Silver flashes | 12 October, every day | 21 days from 2 November (#325) |
| Cloud textures (`archive/clouds/`) | 12 October | 30 days |
| Cloud daily indexes | 17 October | 30 days |
| Live flash chunks | last hour | 1 hour |

15, 19 and 22 October are inside every retention: the data exists, nothing serves it. The live
hour at 18:00 UTC held 196,000 flashes; re-encoded as one hourly set it weighs 1.8 MB (9.3 bytes per
flash), so 40 to 50 MB per day. Storm replay chunks add about 35 MB and 7,000 writes per day; a replay
downloads 3 to 160 KB.

R2 holds 8.3 GB of the 10 GB free tier (29 October, 17:45 UTC), 1.6 GB of it the GLM cache that
expires by 30 October.

## Options

- **Keep live chunks longer.** No new job, but 2,880 objects per day grouped by ingest time, late
  MTG LI flashes spread over later chunks, no overlap removal, and no rebuild after an outage.
- **Read silver from the browser** (DuckDB-Wasm on Iceberg). No copy, but it exposes the lake,
  costs R2 reads per viewer and weighs on phones.
- **Hourly archive built from silver.** One more Dagster asset and a second copy of the flashes;
  deduplicated, complete, rebuilt from silver after any outage.
- **One tiled archive for travel and storm replays.** Storm replays would point to archive tiles
  instead of their own chunks, saving their 35 MB and 7,000 writes per day. Measured on the same
  hour, the busiest tile weighs 420 KB per hour in 30° tiles and 230 KB in 10° tiles: a long storm
  replay would download 2 to 4 MB instead of 160 KB.

## Decision

The third option. Storm replays keep their chunks, which stay small.

**Archive.** A `flash_archive` asset, partitioned by UTC hour, encodes silver flashes like storm
replay chunks: SCNT gzip, at most 65,536 flashes per chunk, immutable content-addressed paths
`archive/flashes/chunks/<sha256>.bin.gz`. A daily index `archive/flashes/manifests/YYYY-MM-DD.json`
lists each hour's chunks, flash counts and event bounds; an hour without flashes is absent. Its job
runs at :02 and :32, catches up from the last archived hour and reads the two newest hours again;
a run at 02:45 rereads the previous day. An hour that changed gets new chunks and its old ones are
deleted, so late rows cost no storage.

**Calendar.** `archive/flashes/index.json` (short cache) gives the first day, the last archived hour
and the retention. The date picker only offers those days. An hour with no archive shows that
lightning data is missing, never an empty sky.

**Client.** Free replay before the live window reads the flash index of the playhead day and its
neighbours, like clouds, and streams its chunks into the renderer ring in event order, as the live
feed does: the ring keeps the display window and the next chunk, so memory does not grow. Inside
the live window, free replay keeps the live feed. An hour is archived two minutes after it ends and
complete thirty minutes later, well before it leaves the 60-minute live window: the two meet with at
most a two-minute hole, two minutes per hour, and the live contract does not change.

**Backfill.** Without history the job starts where silver is kept, so it catches up from 12 October
by itself, a day per run. A one-off command writes the cloud
indexes of 12 to 16 October from the textures already there: product found in NOAA's listing by the
digest in the texture name, reference recomputed from the upload time; no texture is uploaded again.

**Retention.** 21 days, like silver: the archive stays rebuildable for its whole life. The job
deletes the days that leave it; an R2 lifecycle rule at 22 days is the backstop.

## Consequences

| Cost | Value |
| --- | --- |
| Storage | about 0.95 GB at 21 days (0.65 GB at 14, 1.4 GB at 30) |
| Writes | about 500 per day (chunks, day indexes, index), 15,000 per month of 1 M free |
| Reads | tens of silver reads per hourly run; browsers read immutable chunks through the CDN |
| VPS | two short runs per hour, one longer run per day |

R2 at steady state, end of December, with this archive at 21 days:

| Prefix | GB |
| --- | --- |
| Silver, 21 days | 3.4 |
| Storm replay chunks, 60 days | 2.1 |
| Flash archive, 21 days | 0.95 |
| Cloud archive, 30 days, and detail, 1 day | 1.2 |
| Storm pages and index, growing 8 MB per day | 0.6 |
| Lake metadata, old snapshots and gold, once snapshots expire | 0.5 |
| Surface textures and live files | 0.3 |
| **Total** | **9.0** |

This leaves about 1 GB. It holds only if old lake snapshots expire: lake metadata and gold take
2.1 GB today, each table keeping 100 metadata files of 3 MB that grow with every snapshot. Without
that expiry the total passes 10 GB before the end of the year, with or without this archive.

- Clouds keep 30 days for storm replays; the calendar offers 21.
- At 3600×, a day plays in 24 s and needs about 50 MB: a slow connection waits on the next hour, and
  the HUD says so.
- Rows that land in silver more than an hour late appear after the next daily reread.
