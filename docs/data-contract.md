# Data contract

The contract between the Python pipeline and the browser. It is defined once, as JSON Schema files
in [`data/contract/`](../data/contract/), and enforced by code:

| Artifact | Path | How it is made |
|---|---|---|
| Schemas (source of truth) | `data/contract/*.schema.json` | edited by hand |
| Python models (pydantic) | `data/packages/scintille-contract/src/scintille_contract/models.py` | generated |
| TypeScript types | `web/src/contract/types.ts` | generated |
| Field reference (end of this doc) | `docs/data-contract.md` | generated section |

```sh
cd data
uv run scintille-contract generate             # after editing a schema
uv run scintille-contract check --base origin/main
```

`check` fails when a generated file is stale, and when the schemas differ from `--base` without the
matching bump of `SchemaVersion` (CI runs it on every pull request, see `.github/workflows/data.yml`):

| Change | Bump |
|---|---|
| Field, type or file removed; type, constraint, `const` or `x-binary` changed; enum value removed, renamed or reordered; field no longer required; binary column inserted before existing ones | major |
| Field, type or file added; enum value appended; field becomes required | minor |
| Description or title only | patch |

The rules protect readers: a reader built for `1.x` must keep working on any later `1.y` file. Readers
therefore ignore unknown fields and tolerate enum values they do not know (an unknown source is
drawn without a label, an unknown quality bit is ignored).

## Flash record

`FlashRecord` is the normalized flash written by ingestion and stored by the pipelines, whatever the
source:

| Source id | Instrument | Product |
|---|---|---|
| `glm-east` | GOES-East GLM (75.2° W) | NOAA GLM L2 LCFA (flash variables) |
| `glm-west` | GOES-West GLM (137.2° W) | NOAA GLM L2 LCFA (flash variables) |
| `mtg-li` | MTG-I1 Lightning Imager (0°) | EUMETSAT LI L2 LFL (flashes) |

- **`flash_id` is deterministic**: the first 128 bits of `sha256("<source>|<product_file>|<native_flash_id>")`
  in hex (`scintille_contract.ids.flash_id`). Re-ingesting the same file yields the same ids, so
  re-runs and replays are idempotent. 128 bits keep collisions negligible over decades of flashes.
- **Two clocks**: `event_time` is when the satellite saw the flash; `ingest_time` is when our
  ingestion received the product file. They differ by the satellite latency (typically 20 to 60 s)
  and must never be mixed: the globe animates by `event_time`, the live feed is published by
  `ingest_time`.
- **Energy** is kept as reported (`energy_raw` + `energy_unit`), because GLM and LI do not measure
  the same quantity. `intensity` (0 to 1) is the normalized value the globe renders; its mapping is
  defined in #33.
- **Quality** lists caveats: `degraded` (flagged by the source product), `coverage-edge` (close to
  the edge of the field of view, where detection efficiency drops), `overlap` (seen where two
  instruments overlap, so it may be detected twice).

## Live feed on R2

```
live/manifest.json                    Cache-Control: max-age=10
live/chunks/20260715T183000Z.bin.gz   Cache-Control: public, max-age=31536000, immutable
live/chunks/20260715T183030Z.bin.gz
...
```

- A **chunk** holds the flashes **ingested** during a window `[start, end)`, 30 s today.
  Chunks are keyed by ingest time, not event time, so a chunk is complete when its window ends and
  never changes afterwards: late data lands in a later chunk instead of rewriting an old one. Event
  times inside a chunk are therefore usually 20 to 60 s before its `start` (`event_offset_ms < 0`).
- Chunk durations may vary (for example one chunk per source file, to cut latency). `start` and
  `end` are whole seconds. `chunk_seconds` in the manifest is only the typical duration.
- Chunk names are opaque and unique under `chunks/`. Today they are the start in ISO 8601 basic
  format (`YYYYMMDDTHHMMSSZ`, no `:`, which is unsafe in URLs and on some file systems); a publisher
  may add a suffix.
- The **manifest** lists the chunks of the last 60 minutes (oldest first, with window, flash count,
  size and event time span) and, per source, its state (`live`, `delayed`, `offline`) and last event
  and ingest times. It is small and short-lived; chunks are immutable and cached for a year.
- Clients rely only on the manifest's chunk list: they never compute chunk names or durations, and
  never assume how often a new chunk appears. A client polls the manifest at a pace of its choosing
  and downloads only the chunks it does not have yet. A first visit downloads the whole hour.

## Chunk encoding

`LiveChunk` (in `chunk.schema.json`) describes what a chunk contains once decoded: the display fields
of its flashes, as columns sorted by event time. Fields the globe does not need (`flash_id`,
`energy_raw`, product file, ingest time) stay in the pipeline. On the wire a chunk is a gzip file of:

| Bytes | Content |
|---|---|
| 0-3 | magic `SCNT` |
| 4 | contract major version (uint8) |
| 5 | contract minor version (uint8) |
| 6-7 | reserved, 0 |
| 8-11 | `start`, Unix seconds (uint32, little-endian) |
| 12-15 | flash count `n` (uint32, little-endian) |
| 16- | one little-endian array of `n` values per column, in the order of `CHUNK_COLUMNS_BINARY_LAYOUT` |

A value is stored as `round(value / scale)` in the column `dtype` and read back as
`stored * scale`. Columns are ordered by decreasing size so that every array is aligned and can be
read as a typed array view without copying. `source` stores the index in `Source`, `quality` a
bitmask where bit `i` is `QualityFlag` number `i`.

Decoding in the browser needs no library:

```ts
const response = await fetch(url);
const buffer = await new Response(
  response.body!.pipeThrough(new DecompressionStream("gzip")),
).arrayBuffer();
const count = new DataView(buffer).getUint32(12, true);
const lat = new Int16Array(buffer, 16 + 4 * count, count); // multiply by the column scale
```

`fixtures/index.html` is a complete reference decoder (about 30 lines).

### Benchmark

Measured with `uv run scintille-contract bench` on 10 minutes of the synthetic feed (18:30 to 18:40,
28,767 flashes, 47.9 flashes/s, the busiest part of the fixture hour). Columnar JSON rounds
coordinates and intensity to 3 decimals, which is about the precision of the binary form.

| Encoding | Compression | 10 minutes | Bytes per flash |
|---|---|---:|---:|
| Columnar JSON | none | 1343 KB | 46.7 |
| Columnar JSON | gzip -9 | 418 KB | 14.5 |
| Columnar JSON | brotli -11 | 331 KB | 11.5 |
| Binary, quantized | none | 432 KB | 15.0 |
| **Binary, quantized** | **gzip -9** | **299 KB** | **10.4** |
| Binary, quantized | brotli -11 | 247 KB | 8.6 |

**Choice: quantized binary columns, gzip-compressed** (299 KB for 10 minutes, budget 500 KB).
It is 28% smaller than gzipped JSON, and decoding is a handful of typed array views instead of
parsing about 1.3 MB of JSON text per 10 minutes. Brotli would save another 17%, but browsers only
decompress it through `Content-Encoding`, which ties correctness to how the CDN handles stored
encodings; gzip through `DecompressionStream` works the same everywhere, including the local
fixture server. Quantization stays well below the instruments' resolution (GLM about 8 km, LI about
4.5 km): about 300 m in latitude, 600 m in longitude, 1/255 in intensity.

See [ADR 0004](adr/0004-live-chunk-encoding.md).

## Fixtures

`fixtures/live/` holds a synthetic hour (2026-07-15 18:00 to 19:00 UTC): a manifest and 120 chunks,
about 159,000 flashes (44 per second), 1.65 MB in total. Storm cells are placed in the regions that
are convectively active at that time of a July day (Central and West Africa, Amazon, Central
America, south-east and central US, Europe), grow and decay over 30 to 120 minutes and drift with
the wind. Each flash is assigned to the instrument that covers it; product files of 20 s (GLM) or
30 s (LI) arrive 12 to 35 s after they close. GOES-West stops 4 minutes before the end and is
marked `delayed`, so clients can exercise the degraded state.

```sh
python3 fixtures/serve.py        # http://localhost:8787/ shows the decoded hour
```

The server sends the same `Cache-Control` headers as R2 and allows any origin, so the site's dev
server can fetch `http://localhost:8787/live/manifest.json`. To regenerate:
`cd data && uv run scintille-contract fixtures`.

## Reference

<!-- BEGIN GENERATED REFERENCE -->

Contract version **2.0.0**. This section is generated from the schemas; edit the schemas, then run `uv run scintille-contract generate`.

### SchemaVersion

Defined in `data/contract/common.schema.json`.

Contract version (SemVer). Any change that breaks existing readers needs a major bump.

Value: `2.0.0`.

### UtcTimestamp

Defined in `data/contract/common.schema.json`.

UTC instant, RFC 3339 with a Z suffix, up to microsecond precision.

Type: string (date-time).

### Source

Defined in `data/contract/common.schema.json`.

Instrument that observed the flash. The order is the index used in binary chunks.

| Index | Value |
|---|---|
| 0 | `glm-east` |
| 1 | `glm-west` |
| 2 | `mtg-li` |

### QualityFlag

Defined in `data/contract/common.schema.json`.

Quality caveat on a flash. The order is the bit index used in binary chunks.

| Index | Value |
|---|---|
| 0 | `degraded` |
| 1 | `coverage-edge` |
| 2 | `overlap` |

### EnergyUnit

Defined in `data/contract/common.schema.json`.

Unit of energy_raw: J for GLM flash_energy, mW m-2 sr-1 for MTG LI flash radiance.

| Index | Value |
|---|---|
| 0 | `J` |
| 1 | `mW m-2 sr-1` |

### SourceState

Defined in `data/contract/common.schema.json`.

Health of a source in the live feed.

| Index | Value |
|---|---|
| 0 | `live` |
| 1 | `delayed` |
| 2 | `offline` |

### FlashRecord

Defined in `data/contract/flash.schema.json`.

One lightning flash, normalized across sources. Written by ingestion, stored by the pipelines.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `flash_id` | string | yes | pattern `^[0-9a-f]{32}$` | Deterministic id: first 128 bits of sha256("source|product_file|native_flash_id"), hex. |
| `source` | [Source](#source) | yes |  |  |
| `product_file` | string | yes | minLength `1` | Base name of the L2 product file the flash was read from. |
| `native_flash_id` | integer | yes | minimum `0` | Flash id as written in the product file. |
| `event_time` | [UtcTimestamp](#utctimestamp) | yes |  | Flash start time as measured by the satellite (UTC, microseconds). |
| `ingest_time` | [UtcTimestamp](#utctimestamp) | yes |  | When ingestion received the product file (UTC, microseconds). |
| `lat` | number | yes | minimum `-90`, maximum `90` | Latitude of the flash centroid, degrees north. |
| `lon` | number | yes | minimum `-180`, maximum `180` | Longitude of the flash centroid, degrees east. |
| `energy_raw` | number | yes | minimum `0` | Optical energy as reported by the source, in energy_unit. |
| `energy_unit` | [EnergyUnit](#energyunit) | yes |  |  |
| `intensity` | number | yes | minimum `0`, maximum `1` | Normalized optical intensity derived from energy_raw (mapping defined in #33). |
| `area_km2` | number | yes | minimum `0` | Area covered by the flash, square kilometres. |
| `duration_ms` | number | yes | minimum `0` | Flash duration, milliseconds. |
| `quality` | array of [QualityFlag](#qualityflag) | yes | unique items | Quality caveats; empty when the flash is nominal. |

### ChunkRef

Defined in `data/contract/manifest.schema.json`.

One immutable chunk: the flashes ingested during [start, end).

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `start` | [UtcTimestamp](#utctimestamp) | yes |  | Start of the ingest window, whole seconds; equals the previous chunk's end when no window is missing. |
| `end` | [UtcTimestamp](#utctimestamp) | yes |  | End of the ingest window (exclusive), whole seconds, after start. |
| `path` | string | yes | pattern `^chunks/[0-9A-Za-z_-]+\.bin\.gz$` | Path relative to the manifest, unique and opaque: never derive it from start. |
| `flash_count` | integer | yes | minimum `0` | Number of flashes in the chunk. |
| `size_bytes` | integer | yes | minimum `0` | Size of the chunk file as stored (gzip), bytes. |
| `event_min` | [UtcTimestamp](#utctimestamp) or null | yes |  | Earliest event_time in the chunk; null when empty. |
| `event_max` | [UtcTimestamp](#utctimestamp) or null | yes |  | Latest event_time in the chunk; null when empty. |

### SourceStatus

Defined in `data/contract/manifest.schema.json`.

Freshness of one source.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `source` | [Source](#source) | yes |  |  |
| `state` | [SourceState](#sourcestate) | yes |  |  |
| `last_event_time` | [UtcTimestamp](#utctimestamp) or null | yes |  | Latest event_time received from this source; null if never seen. |
| `last_ingest_time` | [UtcTimestamp](#utctimestamp) or null | yes |  | When the latest product file of this source was ingested; null if never seen. |

### LiveManifest

Defined in `data/contract/manifest.schema.json`.

live/manifest.json: the chunks of the last 60 minutes and the state of each source.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `schema_version` | [SchemaVersion](#schemaversion) | yes |  |  |
| `generated_at` | [UtcTimestamp](#utctimestamp) | yes |  | When this manifest was written. |
| `chunk_seconds` | integer | yes | minimum `1` | Typical length of a chunk's ingest window, seconds. A hint only: chunk durations may vary, the chunk list is authoritative. |
| `window_seconds` | `3600` | yes |  | How far back the manifest lists chunks, seconds. |
| `chunks` | array of [ChunkRef](#chunkref) | yes |  | Published chunks, oldest first. |
| `sources` | array of [SourceStatus](#sourcestatus) | yes |  | One entry per source, in Source order. |

### ChunkColumns

Defined in `data/contract/chunk.schema.json`.

Arrays of equal length, sorted by event time. Binary column order is the property order.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `event_offset_ms` | array of integer | yes | minimum `-2147483647`, maximum `2147483647` | event_time minus start, milliseconds; usually negative (satellite latency). |
| `lat` | array of number | yes | minimum `-90`, maximum `90` | Latitude, degrees north (resolution about 300 m). |
| `lon` | array of number | yes | minimum `-180`, maximum `180` | Longitude, degrees east (resolution about 600 m). |
| `area_km2` | array of number | yes | minimum `0`, maximum `65535` | Flash area, square kilometres, clamped to 65535. |
| `duration_ms` | array of number | yes | minimum `0`, maximum `65535` | Flash duration, milliseconds, clamped to 65535. |
| `intensity` | array of number | yes | minimum `0`, maximum `1` | Normalized intensity 0-1 (resolution 1/255). |
| `source` | array of [Source](#source) | yes |  | Source; in binary, its index in Source. |
| `quality` | array of integer | yes | minimum `0`, maximum `255` | Quality bitmask: bit i is set when QualityFlag i applies. |

Binary layout, in order:

| Column | dtype | scale |
|---|---|---|
| `event_offset_ms` | int32 | 1 |
| `lat` | int16 | 0.0027466658528397473 |
| `lon` | int16 | 0.005493331705679495 |
| `area_km2` | uint16 | 1 |
| `duration_ms` | uint16 | 1 |
| `intensity` | uint8 | 0.00392156862745098 |
| `source` | uint8 | 1 |
| `quality` | uint8 | 1 |

### LiveChunk

Defined in `data/contract/chunk.schema.json`.

Decoded content of one live chunk: the display fields of its flashes, as columns.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `schema_version` | [SchemaVersion](#schemaversion) | yes |  |  |
| `start` | [UtcTimestamp](#utctimestamp) | yes |  | Start of the ingest window; event offsets are relative to it. |
| `columns` | [ChunkColumns](#chunkcolumns) | yes |  |  |

<!-- END GENERATED REFERENCE -->
