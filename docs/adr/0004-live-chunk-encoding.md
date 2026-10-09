# 0004 · Live feed as gzip binary chunks keyed by ingest time

- Status: accepted
- Date: 2026-10-08

## Context

The browser shows the last 60 minutes of lightning and then follows it live. The feed is static
files on R2 behind Cloudflare, with no server code. About 45 flashes per second fall within GOES GLM
and MTG LI coverage, and the budget is 500 KB transferred for 10 minutes of global activity.
Satellite data arrives 20 to 60 s after the flashes, sometimes later.

## Options

- **Chunking by event time**: natural for playback, but a chunk can only be published once all its
  late data has arrived, or it must be rewritten, which breaks long caching.
- **Chunking by ingest time**: a chunk is final when its window closes and is never rewritten; the
  client orders flashes by event time itself.
- **Columnar JSON**: readable, but 418 KB gzip (331 KB brotli) for 10 busy minutes, and 1.3 MB of
  text to parse.
- **Quantized binary columns, gzip**: 299 KB for the same sample, decoded with typed array views.
- **Same binary with brotli**: 247 KB, but browsers only decode brotli through `Content-Encoding`,
  which depends on how the CDN serves stored encodings.

## Decision

Publish immutable 30-second chunks keyed by ingest time (`live/chunks/<start>.bin.gz`), each a
gzip-compressed set of little-endian quantized columns described by `chunk.schema.json`, indexed by
a short-lived `live/manifest.json`. Details and numbers are in `docs/data-contract.md`.

## Consequences

- Chunks are cached for a year and clients only download what they lack.
- The client needs a small decoder and `DecompressionStream` (all current browsers).
- Changing a column's type, scale or order is a breaking change of the contract (major bump).
- Moving to brotli later is possible without changing the layout, if the CDN path proves reliable.
