# 0011 · Storm publication and replay references

- Status: proposed
- Date: 2026-10-12

## Context

#74 publishes bounded storm pages and replay data for #76 and #88. Classification in #183 is
configurable and uses the accepted ADR 0009 thresholds and public names. The live
binary format has no publication timestamp and event offsets are signed 32-bit milliseconds.
The lake stores cell bounds and track identifiers, but not the flash membership of each cell.

## Options

One binary per storm is simple, but arbitrarily long storms overflow its offsets and large storms
require large downloads. Persisting exact cell membership would make replay precise but changes
upstream storm detection. A bounds extract can be published now if its provenance is explicit.

## Decision

Propose bounded `storms/<slug>.json` metadata referencing immutable, content-addressed SCNT gzip
chunks under `storms/chunks/`, partitioned by event hour and at most 65,536 flashes each. Paths
are relative to the public data root. The metadata carries publication and observation times.
`replay.selection` initially states `track-bounds`; its flash count is separate from the classified
storm count. It may include unrelated nearby flashes and must not be presented as exact membership.
Forward persisted level values without selecting thresholds. No production schedule activation is
part of this change. Use zero-based `storms/index/<page>.json` pages of 50 summaries, recent first.

## Consequences

Metadata is capped at 256 KiB. Oversized exports are logged and excluded; existing details and
summaries remain available. Replay chunks
are published before metadata, then index pages, then sitemaps; published objects are never removed
by this job. Re-running preserves stable slugs and unchanged detail bytes. Sitemaps include regions
only after their detail file exists. XML comments carry schema and freshness metadata without
changing the sitemap protocol. Pending cache tags survive failed purges in a pipeline outbox.
Historical cloud frame discovery is now implemented by #260 (ADR 0014). Missing/expired cloud
observations remain missing in replay; current imagery is never a historical fallback.
Synthetic fixtures label their intensity rule explicitly and adopt no public classification choice.
