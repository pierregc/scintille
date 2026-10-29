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

15, 19 and 22 October are inside every retention: the data exists, nothing serves it. The live feed
carries about 210,000 flashes and 2.0 MB per hour at 17:30 UTC (9.5 bytes per flash), so about
40 to 50 MB per day in the same encoding. The R2 plan lands near 8 GB of the 10 GB free tier.

## Options

- **Keep live chunks longer.** No new job, but 2,880 objects per day grouped by ingest time, late
  MTG LI flashes spread over later chunks, no overlap removal, and no rebuild after an outage.
- **Read silver from the browser** (DuckDB-Wasm on Iceberg). No copy, but it exposes the lake,
  costs R2 reads per viewer and weighs on phones.
- **Hourly archive built from silver.** One more Dagster asset and a second copy of the flashes;
  deduplicated, complete, rebuilt from silver after any outage.

## Decision

Proposed: the third option.

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
| Storage | about 1 GB at 21 days (1.4 GB at 30), so about 9 GB of the 10 GB free tier |
| Writes | about 150 per day (chunks, index, day list), 4,500 per month of 1 M free |
| Reads | tens of silver reads per hourly run; browsers read immutable chunks through the CDN |
| VPS | one run of about a minute per hour |

- Clouds keep 30 days for storm replays; the calendar offers 21.
- At 3600×, a day plays in 24 s and needs about 50 MB: a slow connection waits on the next hour, and
  the HUD says so.
- Rows that land in silver after their hour was published are missing until it is republished; an
  hourly check compares counts per hour between silver and the archive.
