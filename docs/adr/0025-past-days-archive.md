# 0025 · Past days in Travel in time: an hourly flash archive

- Status: proposed
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

Proposed: the third option. Storm replays keep their chunks, which stay small.

**Archive.** A `flash_archive` asset, partitioned by UTC hour, encodes silver flashes like storm
replay chunks: SCNT gzip, at most 65,536 flashes per chunk, immutable content-addressed paths
`archive/flashes/chunks/<sha256>.bin.gz`. A daily index `archive/flashes/manifests/YYYY-MM-DD.json`
lists each hour's chunks, flash counts and event bounds; republishing an hour replaces its entry.
Its own job runs at :20 for the previous hour, like the storm catalog, and catches up from the last
published hour. An R2 lifecycle rule deletes `archive/flashes/` after the retention.

**Calendar.** `archive/index.json` (short cache) gives the first and last day with flashes and with
clouds and the last archived hour. The date picker only offers those days. An hour with no archive
inside them shows that lightning data is missing, never an empty sky.

**Client.** Free replay reads the flash index of the playhead day and its neighbours, like clouds,
and loads the hours that overlap the display window and the next hour: at most 3 hours, about
20 MB of memory at the peak hour. `SceneData` moves them into the renderer ring as for storms
([ADR 0013](0013-replay-feed-lifecycle.md)). After the last archived hour, flashes come from the live
feed; its window grows from 60 to 90 minutes to cover the publication delay, and live flashes older
than the archive end are skipped so none is drawn twice.

**Backfill.** A catch up from silver over 12 October to now. A one-off command writes the cloud
indexes of 12 to 16 October from the textures already there: product found in NOAA's listing by the
digest in the texture name, reference recomputed from the upload time; no texture is uploaded again.

**Retention.** 21 days, like silver: the archive stays rebuildable for its whole life.

## Consequences

| Cost | Value |
| --- | --- |
| Storage | about 0.95 GB at 21 days (0.65 GB at 14, 1.4 GB at 30) |
| Writes | about 150 per day (chunks, index, day list), 4,500 per month of 1 M free |
| Reads | tens of silver reads per hourly run; browsers read immutable chunks through the CDN |
| VPS | one run of about a minute per hour |

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
- Rows that land in silver after their hour was published are missing until it is republished; an
  hourly check compares counts per hour between silver and the archive.
