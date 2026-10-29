# Data contract

The contract between the Python pipeline and the browser. It is defined once, as JSON Schema files
in [`data/contract/`](../data/contract/), and enforced by code:

| Artifact | Path | How it is made |
|---|---|---|
| Schemas (source of truth) | `data/contract/*.schema.json` | edited by hand |
| Python models (pydantic) | `data/packages/scintille-contract/src/scintille_contract/models.py` | generated |
| TypeScript types | `web/src/contract/types.ts` | generated |
| Field reference (end of this doc) | `docs/data-contract.md` | generated section |
| Ownership mask ([data quality](data-quality.md#overlap-between-satellites)) | `data/contract/ownership.geojson` | generated |
| Coverage map ([below](#coverage-map)) | `data/contract/coverage.geojson` | generated |

```sh
cd data
uv run scintille-contract generate             # after editing a schema
uv run scintille-contract check --base origin/main
```

`check` fails when a generated file is stale, and when the schemas differ from `--base` without the
matching bump of `SchemaVersion` (CI runs it on every pull request ready for review, see `.github/workflows/ci.yml`):

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
| `glm-west` | GOES-West GLM (137.0° W) | NOAA GLM L2 LCFA (flash variables) |
| `mtg-li` | MTG-I1 Lightning Imager (0°) | EUMETSAT LI L2 LFL (flashes) |

MTG LI flashes come from the EUMETSAT Data Store, collection `EO:EUM:DAT:0691`, read with `eumdac` and
the credentials listed in [secrets](secrets.md). The collection is Core data under the EUMETSAT Data
Policy (CC BY 4.0): free, redistribution allowed, with this attribution shown wherever flashes from it
are displayed:

> Contains modified EUMETSAT Meteosat data 2026

The year is the year of publication. GLM data is public domain (NOAA); we credit it as
"GLM data courtesy of NOAA".

The Data Store publishes LI L2 LFL as one `BODY` file per 10 minute repeat cycle (`--ARC-`
products, 3,722 flashes and 124 kB in the committed sample); ingestion treats every `BODY` chunk of a product as one
file (key `<product id>/<chunk file>`) and skips any `TRAIL` chunk. Radiance is kept in
`mW m-2 sr-1` and any L1b warning (missing, geolocation, radiometric) marks the flash `degraded`.
`flash_footprint` is a pixel count, so `area_km2` is approximate: pixels times the ground area of
one LI pixel, 4.5 km square at the sub-satellite point (0°, 0°), grown by slant range and viewing
obliquity (`scintille_ingest.mtg.parse.pixel_area_km2`).

**MTG LI latency** (#32), measured on 2026-10-12 with `scintille-ingest mtg --once`: the Data
Store published the 10 minute file 41 s after the end of its cycle. A flash therefore becomes
available between about 40 s (seen at the end of the cycle) and 10 min 40 s (seen at its start)
after it happened, around 5 min 40 s on average, plus up to 30 s of polling by `ingest-live`.
GLM files arrive about 30 s after the flash, so the globe shows Europe and Africa several minutes
behind the Americas. Lower latency needs another channel, such as EUMETCast (#204).

- **`flash_id` is deterministic**: the first 128 bits of `sha256("<source>|<product_file>|<native_flash_id>")`
  in hex (`scintille_contract.ids.flash_id`). Re-ingesting the same file yields the same ids, so
  re-runs and replays are idempotent. 128 bits keep collisions negligible over decades of flashes.
- **Two clocks**: `event_time` is when the satellite saw the flash; `ingest_time` is when our
  ingestion received the product file. They differ by the satellite latency (typically 20 to 60 s)
  and must never be mixed: the globe animates by `event_time`, the live feed is published by
  `ingest_time`.
- **Energy** is kept as reported (`energy_raw` + `energy_unit`), because GLM and LI do not measure
  the same quantity. `intensity` (0 to 1) is the normalized value the globe renders; its mapping is
  in the [methodology](methodology.md#flash-intensity).
- **Quality** lists caveats: `degraded` (flagged by the source product), `coverage-edge` (close to
  the edge of the field of view, where detection efficiency drops), `overlap` (seen where two
  instruments overlap, so it may be detected twice), `outside-owner-zone` (another instrument has
  the better view of this point and reports the same flash: kept in silver, in the live feed only
  while that instrument is not delivering, see [data quality](data-quality.md#overlap-between-satellites)).

## Live feed on R2

```
live/manifest.json                    Cache-Control: max-age=10
live/metrics.json                     Cache-Control: max-age=30
live/coverage.geojson                 Cache-Control: max-age=3600
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
- A source's **state** comes from the time since its last product file: `live` up to
  `delayed_after` (2 minutes by default), `delayed` up to `offline_after` (10 minutes), then
  `offline`. Both count from the next expected file, so MTG LI, which delivers every 10 minutes,
  turns `delayed` after 12 minutes. Both delays are configurable ([hot path](hot-path.md#live-feed)).
- Clients rely only on the manifest's chunk list: they never compute chunk names or durations, and
  never assume how often a new chunk appears. A client polls the manifest at a pace of its choosing
  and downloads only the chunks it does not have yet. A first visit downloads the whole hour.
- **`metrics.json`** (`OpsMetrics`) is rewritten every minute: freshness per layer, flashes per
  minute, latency, completeness and error budget per source, data quality status and catalog usage.
  Targets are in [SLOs](slo.md).

## Coverage map

`live/coverage.geojson` (`CoverageMap`, RFC 7946) says where flashes can come from. It is generated
from the satellite list of the ownership mask (`scintille_contract.ownership.SATELLITES`), so a new
source gets its footprint without other changes, and published by `ingest-live` when it changes:

- one `footprint` feature per satellite, in mask order: its usable field of view, the points within
  `coverage_deg` of the sub-satellite point;
- one `no-coverage` feature: the area no footprint covers (today the poles, Asia and Oceania).

Geometries are MultiPolygons split at the antimeridian, outer rings counterclockwise and holes
clockwise; together the features tile the globe. `mask_version` follows `ownership.geojson`. The
globe greys out the no coverage area only; source outages show in the HUD. A copy is committed
in `data/contract/coverage.geojson` and in the fixtures.

## Cloud frames on R2

```
live/clouds/manifest.json                     Cache-Control: max-age=60
live/clouds/2k/20261010T000000Z-1a2b3c4d.webp  Cache-Control: public, max-age=31536000, immutable
live/clouds/4k/20261010T000000Z-1a2b3c4d.webp
archive/clouds/2k/2026/10/10/20261010T000000Z-1a2b3c4d.webp
```

- A **frame** is one hourly observation turned into cloud opacity, from the GMGSI mosaic
  ([ADR 0007](adr/0007-cloud-source.md)) or the composite ([ADR 0023](adr/0023-composite-clouds.md)):
  an equirectangular grayscale WebP (west edge at 180° W, top row at 90° N; 0 clear, 255 opaque;
  0 beyond ±72.7°), one per tier: `2k` (2048 × 1024) and `4k` (4096 × 2048).
- The **manifest** lists the frames of the last 6 hours, oldest first. Paths are relative to the
  manifest and opaque; a revised upstream file gets a new path. Clients poll it (a new frame
  appears about once an hour) and show `time`, the observation time, next to the lightning time.

```json
{
  "generated_at": "2026-10-10T00:40:12Z",
  "window_seconds": 21600,
  "attribution": "Clouds: NOAA NESDIS GMGSI (contains EUMETSAT Meteosat and JMA Himawari data)",
  "frames": [
    {
      "time": "2026-10-10T00:00:00Z",
      "published_at": "2026-10-10T00:40:12Z",
      "product": "GLOBCOMPLIR_v3r0_blend_s202610100000000_e202610100009599_c202610100034153.nc",
      "reference": "gfs 2026100918 f006",
      "textures": {
        "2k": { "path": "2k/20261010T000000Z-1a2b3c4d.webp", "width": 2048, "height": 1024, "size_bytes": 316424 },
        "4k": { "path": "4k/20261010T000000Z-1a2b3c4d.webp", "width": 4096, "height": 2048, "size_bytes": 1031550 }
      }
    }
  ]
}
```

The model is `CloudManifest` in `scintille_ingest.clouds.publish`; it is not part of the versioned
flash contract yet.

### Cloud detail tiles

Composite frames add an optional `detail` block ([ADR 0023](adr/0023-composite-clouds.md)); clients
that ignore it keep the global textures:

```json
"detail": {
  "path": "../../archive/clouds/detail/2026/10/18/20261018T140000Z-f41ef6e0.tiles",
  "tile_size": 640,
  "border": 2,
  "levels": [3, 4, 5],
  "max_latitude": 72.7,
  "fine": "AAAA…",
  "size_bytes": 31612666,
  "index_bytes": 21504
}
```

- Tile `x`, `y` of level `z` covers `180 / 2^z` degrees square from 180° W and 90° N, with
  `2^(z+1)` columns and `2^z` rows: texels of about 3.9, 2.0 and 0.98 km. Each tile is a grayscale
  WebP of `tile_size + 2 × border` texels square; the border repeats the neighbouring texels so a
  cubic filter needs no other tile.
- Levels 3 and 4 have every tile that reaches ±`max_latitude`; level 5 only where a source of about
  1 km exists, listed in `fine`: base64 of one bit per tile, row-major from the north-west, least
  significant bit first. A pack that keeps only some tiles of levels 3 and 4 lists them in
  `coarse`: base64 of one bit per tile of those levels, in index order, least significant bit first.
- All tiles of a frame are one object (`.tiles`, immutable): an index of `index_bytes`, one pair of
  little-endian uint32 (offset from the start of the object, length) per possible tile, levels in
  order then rows then columns (length 0 where absent), followed by the tiles. Clients read the
  index, then each tile, with HTTP range requests.
- The object is written once, before the manifests, under `archive/clouds/detail/`; the live
  manifest and the daily archive index both point there, each with a path relative to itself
  (`detail_path_pattern` in `cloud_archive_rules.json` for the archive).
- Detail is kept one day. The publisher then writes the level 4 and 5 tiles under the ten strongest
  storms of each UTC day (flashes × peak rate, track positions within an hour of the frame) to a
  `-storms.tiles` object with `coarse`, points the archive index to it, and deletes the full
  object; frames without such a storm lose their `detail` block. Everything under
  `archive/clouds/` goes after 30 days.
- Cloud-top heights ([ADR 0028](adr/0028-cloud-relief.md)) travel in the same object, declared by
  an optional `height` block inside `detail`; clients that ignore it read the opacity index as
  before:

  ```json
  "height": {
    "levels": [3, 4],
    "max_km": 20,
    "index_offset": 21504,
    "index_bytes": 5120,
    "reference": "gfs 2026101812 f003 0p50"
  }
  ```

  A second index of the same form starts at `index_offset`, one pair per possible tile of
  `levels`, and points to grayscale WebP tiles on the opacity grid (same size and border): 0 to
  255 map onto 0 to `max_km` above sea level. Heights come from the infrared brightness
  temperature matched to the GFS temperature profile named in `reference` (`lapse from …` when
  the profile was missing). Clear texels carry the tops of the nearby clouds, so filtering never
  slopes a top down to the ground. A `-storms.tiles` object keeps the level 4 heights under its
  storms.

## Historical cloud discovery

`archive/clouds/manifests/YYYY-MM-DD.json` is the version 1 daily archive index
([ADR 0014](adr/0014-historical-cloud-discovery.md), #260). It is a separate document from the live
flash contract. The day is the **UTC observation day**. `ArchiveCloudManifest` in
`scintille_ingest.clouds.publish` validates the publication model.

```json
{
  "schema_version": 1,
  "day": "2026-10-10",
  "generated_at": "2026-10-10T00:40:12Z",
  "attribution": "Clouds: NOAA NESDIS GMGSI (contains EUMETSAT Meteosat and JMA Himawari data)",
  "frames": [{
    "time": "2026-10-10T00:00:00Z",
    "published_at": "2026-10-10T00:40:12Z",
    "expires_at": "2026-11-09T00:40:12Z",
    "product": "upstream-mosaic.nc",
    "reference": "gfs 2026100918 f006",
    "textures": {
      "2k": {"path": "../2k/2026/10/10/20261010T000000Z-1a2b3c4d.webp", "width": 2048, "height": 1024, "size_bytes": 316424}
    }
  }]
}
```

The publisher writes archive textures first, then the day index (`Cache-Control: public, max-age=60`).
At most 96 references are sorted by observation time; a revision replaces the same observation.
The current hourly source produces 24 daily frames. Unexpected excess retains the newest 96 and
logs the dropped coverage. A corrupt version-1 index recovers from the next publication; unsupported
versions are preserved rather than replaced. Rebuilding cannot recover earlier corrupt entries.
The canonical limits, tiers and texture-path rule are packaged in
`scintille_contract/cloud_archive_rules.json` and imported by both runtimes. Shared contract test
vectors exercise their accepted and rejected payloads without adding a generic runtime validator.
`expires_at` is archive publication plus 30 days. The existing archive lifecycle can still remove
referenced objects; indices do not promise permanent availability or exact cloud measurements at
every scene instant. `scintille-ingest clouds-reindex --first DAY --last DAY` indexes textures
archived before the indexes existed, without uploading them again ([ADR 0025](adr/0025-past-days-archive.md)).

Interactive replay fetches at most three daily indices and keeps at most three frame textures close
to the playhead, bounded by the existing 3-hour gap rule. Selection follows sub-hourly scrubs as well.
Each daily index, including failures, is cached for 60 seconds of wall time; changing the scene hour
alone does not fetch it again. Metadata refresh preserves still-selected texture loads; obsolete
requests are cancelled and stale textures disposed. Live and archive textures share the download
byte limit. One owner clears textures on each live/replay transition.
Switching to live clears the historical layer and resumes the live feed. Missing/expired images
show `No cloud data`; they never select current clouds. The HUD shows the observation time and
attribution of the selected source. The existing deterministic offline renderer remains unchanged.

For QA on a Preview, open `/?storm=2026-07-15-orlando&speed=30`. Historical cloud fixtures are copied
under `/_replay-fixtures/archive/clouds/` only in Preview builds. Their far-future publication/expiry
dates are synthetic so the real July imagery remains available for repeatable visual checks.
Scrub beyond the fixture coverage to verify the unavailable state, then return to live. Production
does not include these fixtures. Dev uses the existing fixture server at the configured data root.

## Flash archive

Travel in time reads flashes before the live window from `archive/flashes/`
([ADR 0025](adr/0025-past-days-archive.md)). The Dagster job `hourly_flash_archive` writes it from
silver at :02 and :32, reading the two newest archived hours again for late rows, and rereads the
previous day at 02:45. Limits and the chunk path rule are in `scintille_contract/flash_archive_rules.json`.

```
archive/flashes/index.json                     Cache-Control: public, max-age=60
archive/flashes/manifests/2026-10-15.json      Cache-Control: public, max-age=60
archive/flashes/chunks/<sha256>.bin.gz         Cache-Control: public, max-age=31536000, immutable
```

```json
{
  "schema_version": 1,
  "day": "2026-10-15",
  "generated_at": "2026-10-15T19:02:41Z",
  "hours": [{
    "start": "2026-10-15T18:00:00Z",
    "flash_count": 203114,
    "chunks": [{"path": "../chunks/3f1c...e9.bin.gz", "flash_count": 65536, "size_bytes": 604211,
                "event_min": "2026-10-15T18:00:00.012Z", "event_max": "2026-10-15T18:19:07.441Z"}]
  }]
}
```

- Chunks use the live encoding with the hour as origin, at most 65,536 flashes each, in event time
  order. An hour whose flashes changed gets new chunks; the replaced ones are deleted after the
  day index is written, so a reader holding an old index refetches it on a missing chunk.
- An hour without flashes in silver is absent: the reader shows missing data, never an empty sky.
- `index.json` gives `first_day`, `last_hour` and `retention_days` (silver's, 21). Days before
  `first_day` are deleted by the job; an R2 lifecycle rule removes anything older than 22 days.

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

`fixtures/live/` holds a synthetic hour (2026-07-15 18:00 to 19:00 UTC): a manifest, the coverage map and 120 chunks,
about 159,000 flashes (44 per second), 1.65 MB in total. Storm cells are placed in the regions that
are convectively active at that time of a July day (Central and West Africa, Amazon, Central
America, south-east and central US, Europe), grow and decay over 30 to 120 minutes and drift with
the wind. Each flash is assigned to the instrument that covers it; product files of 20 s (GLM) or
30 s (LI) arrive 12 to 35 s after they close. GOES-West stops 4 minutes before the end and is
marked `delayed`, so clients can exercise the degraded state.
`metrics.json` holds the matching `OpsMetrics` for the end of that hour (flash counts derived from
the chunks) and feeds `/status` in development.
`fixtures/live/clouds/` holds a cloud manifest with one real frame at 18:00 UTC.

```sh
python3 fixtures/serve.py        # http://localhost:8787/ shows the decoded hour
```

The server sends the same `Cache-Control` headers as R2 and allows any origin, so the site's dev
server can fetch `http://localhost:8787/live/manifest.json`. To regenerate:
`cd data && uv run scintille-contract fixtures`.

## Reference

<!-- BEGIN GENERATED REFERENCE -->

Contract version **2.8.0**. This section is generated from the schemas; edit the schemas, then run `uv run scintille-contract generate`.

### SchemaVersion

Defined in `data/contract/common.schema.json`.

Contract version (SemVer). Any change that breaks existing readers needs a major bump.

Value: `2.8.0`.

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
| 3 | `outside-owner-zone` |

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

### LayerFreshness

Defined in `data/contract/metrics.schema.json`.

Age of each layer, seconds; null when unknown.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `live_feed_age_seconds` | number or null | yes |  | Time since the live manifest was last written. |
| `silver_lag_seconds` | number or null | yes |  | Age of the oldest spooled batch not yet in silver; 0 when the spool is drained. |
| `gold_age_seconds` | number or null | yes |  | Time since the latest gold build; null before the first one. |

### SourceMetrics

Defined in `data/contract/metrics.schema.json`.

Throughput, latency and completeness of one source.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `source` | [Source](#source) | yes |  |  |
| `series_start` | [UtcTimestamp](#utctimestamp) | yes |  | Start of the first minute in flashes_per_minute, a whole minute. |
| `flashes_per_minute` | array of integer | yes | minimum `0` | Flashes published per minute of ingest_time, oldest first, at most 60; the last minute is in progress. Starts later than 60 minutes ago after a restart. |
| `latency_p50_seconds` | number or null | yes |  | Median time from event_time to publication in the live feed, last 60 minutes; null without flashes. |
| `latency_p95_seconds` | number or null | yes |  | 95th percentile of the same latency; null without flashes. |
| `completeness` | number or null | yes |  | Product files spooled in the last 60 minutes over the expected count, 0 to 1; null when the source has no file in 30 days. |
| `last_file_time` | [UtcTimestamp](#utctimestamp) or null | yes |  | When the latest product file of this source was spooled; null if never. |
| `error_budget_remaining` | number or null | yes |  | Share of the 30-day completeness error budget left: 1 untouched, 0 spent, negative when overspent; null when the source has no file in 30 days. |

### CheckStatus

Defined in `data/contract/metrics.schema.json`.

Overall check result: fail if an error check failed, warn if only warnings did.

| Index | Value |
|---|---|
| 0 | `pass` |
| 1 | `warn` |
| 2 | `fail` |
| 3 | `unknown` |

### QualityStatus

Defined in `data/contract/metrics.schema.json`.

Latest results of the data quality checks on silver.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `status` | [CheckStatus](#checkstatus) | yes |  |  |
| `checked_at` | [UtcTimestamp](#utctimestamp) or null | yes |  | When the most recent check ran; null if none has. |
| `failed` | array of string | yes |  | Names of the checks whose latest result failed. |

### CatalogUsage

Defined in `data/contract/metrics.schema.json`.

Iceberg catalog operations this month against the free tier.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `month` | string | yes | pattern `^[0-9]{4}-[0-9]{2}$` | Calendar month in UTC, YYYY-MM. |
| `operations` | integer | yes | minimum `0` | Catalog operations made by lake-writer this month. |
| `free_tier` | integer | yes | minimum `0` | Operations included each month by the catalog provider. |

### LakeSize

Defined in `data/contract/metrics.schema.json`.

Size of the Iceberg tables, from the summary of each table's current snapshot, measured about every hour. Files kept only for older snapshots, metadata and other objects in the bucket are not counted.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `measured_at` | [UtcTimestamp](#utctimestamp) or null | yes |  | When the snapshots were read; null before the first measurement. |
| `tables` | integer or null | yes |  | Tables in the bronze, silver and gold namespaces; null before the first measurement. |
| `bytes` | integer or null | yes |  | Data files of the current snapshots, bytes; null before the first measurement. |
| `data_files` | integer or null | yes |  | Data files of the current snapshots; null before the first measurement. |
| `records` | integer or null | yes |  | Rows of the current snapshots; null before the first measurement. |

### StormCounts

Defined in `data/contract/metrics.schema.json`.

Storms in the catalog after its latest hourly publication.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `measured_at` | [UtcTimestamp](#utctimestamp) or null | yes |  | When the storm catalog was last published; null before the first publication. |
| `detected` | integer or null | yes |  | Storms tracked and classified in the lake, every intensity level; null before the first publication. |
| `published` | integer or null | yes |  | Storms with a public page: intensity level 3 and above; null before the first publication. |
| `highlighted` | integer or null | yes |  | Storms featured in the highlights; null before the first publication. |

### OpsMetrics

Defined in `data/contract/metrics.schema.json`.

live/metrics.json: operational metrics and freshness per layer, written every minute.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `schema_version` | [SchemaVersion](#schemaversion) | yes |  |  |
| `generated_at` | [UtcTimestamp](#utctimestamp) | yes |  | When these metrics were computed. |
| `freshness` | [LayerFreshness](#layerfreshness) | yes |  |  |
| `sources` | array of [SourceMetrics](#sourcemetrics) | yes |  | One entry per source, in Source order. |
| `quality` | [QualityStatus](#qualitystatus) | yes |  |  |
| `catalog` | [CatalogUsage](#catalogusage) | yes |  |  |
| `lake` | [LakeSize](#lakesize) | yes |  |  |
| `storms` | [StormCounts](#stormcounts) | yes |  |  |

### CoverageKind

Defined in `data/contract/coverage.schema.json`.

What a coverage feature outlines.

| Index | Value |
|---|---|
| 0 | `footprint` |
| 1 | `no-coverage` |

### CoverageProperties

Defined in `data/contract/coverage.schema.json`.

Properties of a coverage feature; the source fields are null for the no coverage area.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `kind` | [CoverageKind](#coveragekind) | yes |  |  |
| `source` | [Source](#source) or null | yes |  | Source whose usable field of view this is. |
| `subpoint_lon` | number or null | yes |  | Longitude of the sub-satellite point, degrees east. |
| `coverage_deg` | number or null | yes |  | Great-circle radius of the field of view around the sub-satellite point, degrees. |

### MultiPolygon

Defined in `data/contract/coverage.schema.json`.

GeoJSON MultiPolygon: polygons of [lon, lat] rings, outer ring counterclockwise, holes clockwise, split at the antimeridian.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `type` | `"MultiPolygon"` | yes |  |  |
| `coordinates` | array of array of array of array of number | yes |  |  |

### CoverageFeature

Defined in `data/contract/coverage.schema.json`.

One area of the coverage map.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `type` | `"Feature"` | yes |  |  |
| `properties` | [CoverageProperties](#coverageproperties) | yes |  |  |
| `geometry` | [MultiPolygon](#multipolygon) | yes |  |  |

### CoverageMap

Defined in `data/contract/coverage.schema.json`.

live/coverage.geojson: the usable field of view of each source and the area no source sees (RFC 7946).

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `type` | `"FeatureCollection"` | yes |  |  |
| `schema_version` | [SchemaVersion](#schemaversion) | yes |  |  |
| `mask_version` | integer | yes | minimum `1` | Version of the satellite list the footprints come from, as in ownership.geojson. |
| `features` | array of [CoverageFeature](#coveragefeature) | yes |  | One footprint per source of the ownership mask, in mask order, then the no coverage area. |

### StormBounds

Defined in `data/contract/storm.schema.json`.

Bounds in degrees; west > east crosses the antimeridian.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `west` | number | yes | minimum `-180`, maximum `180` |  |
| `south` | number | yes | minimum `-90`, maximum `90` |  |
| `east` | number | yes | minimum `-180`, maximum `180` |  |
| `north` | number | yes | minimum `-90`, maximum `90` |  |

### StormTrackPoint

Defined in `data/contract/storm.schema.json`.

One centroid sample per tracking window.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `time` | [UtcTimestamp](#utctimestamp) | yes |  |  |
| `lat` | number | yes | minimum `-90`, maximum `90` |  |
| `lon` | number | yes | minimum `-180`, maximum `180` |  |
| `flash_count` | integer | yes | minimum `0` |  |
| `area_km2` | number | yes | minimum `0` |  |

### StormChunkRef

Defined in `data/contract/storm.schema.json`.

One replay chunk, partitioned by event time, using the live SCNT binary encoding.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `start` | [UtcTimestamp](#utctimestamp) | yes |  | Whole-second chunk origin; event offsets are relative to this time. |
| `end` | [UtcTimestamp](#utctimestamp) | yes |  | Exclusive end of this event-time window. |
| `path` | string | yes | pattern `^storms/chunks/[0-9A-Za-z_-]+\.bin\.gz$` | Opaque path relative to the public data root, never to the metadata URL. |
| `flash_count` | integer | yes | minimum `0` | Number of flashes in the chunk. |
| `size_bytes` | integer | yes | minimum `0` | Size of the chunk file as stored (gzip), bytes. |
| `event_min` | [UtcTimestamp](#utctimestamp) or null | yes |  | Earliest event_time in the chunk; null when empty. |
| `event_max` | [UtcTimestamp](#utctimestamp) or null | yes |  | Latest event_time in the chunk; null when empty. |

### StormReplay

Defined in `data/contract/storm.schema.json`.

Replay selection provenance. track-bounds can include nearby unrelated flashes; its count is separate from storm metrics.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `selection` | string | yes |  |  |
| `flash_count` | integer | yes | minimum `0` |  |
| `chunks` | array of [StormChunkRef](#stormchunkref) | yes |  |  |

### StormSummary

Defined in `data/contract/storm.schema.json`.

Storm metrics and persisted classification.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `storm_id` | string | yes | minLength `1`, maxLength `128` |  |
| `slug` | string | yes | pattern `^[a-z0-9][a-z0-9-]*$`, maxLength `200` |  |
| `name` | string | yes | minLength `1`, maxLength `256` |  |
| `label` | string | yes | minLength `1`, maxLength `512` |  |
| `country_code` | string or null | yes |  |  |
| `t_start` | [UtcTimestamp](#utctimestamp) | yes |  |  |
| `t_end` | [UtcTimestamp](#utctimestamp) | yes |  |  |
| `closed` | boolean | yes |  |  |
| `flashes` | integer | yes | minimum `0` |  |
| `peak_rate` | integer | yes | minimum `0` |  |
| `level` | integer | yes | minimum `1` |  |
| `level_name` | string | yes | minLength `1`, maxLength `80` |  |
| `level_rule` | string | yes | minLength `1`, maxLength `2048` |  |
| `sources` | array of [Source](#source) | yes |  |  |
| `distance_km` | number or null | no |  | Distance travelled by the storm centroid along its track; null in files older than 2.5.0. |

### StormIndexPage

Defined in `data/contract/storm.schema.json`.

storms/index/<page>.json: zero-based pages counted from the oldest storm, each listed recent first; storms/index/latest.json repeats the last page and holds the current totals.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `schema_version` | [SchemaVersion](#schemaversion) | yes |  |  |
| `published_at` | [UtcTimestamp](#utctimestamp) | yes |  |  |
| `last_observation_time` | [UtcTimestamp](#utctimestamp) or null | yes |  |  |
| `page` | integer | yes | minimum `0` |  |
| `page_size` | integer | yes | minimum `1` |  |
| `total_storms` | integer | yes | minimum `0` |  |
| `total_pages` | integer | yes | minimum `1` |  |
| `storms` | array of [StormSummary](#stormsummary) | yes |  |  |

### StormMetric

Defined in `data/contract/storm.schema.json`.

The one figure that makes a highlighted storm notable.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | yes |  | Total flashes, countries crossed by the centroid, distance travelled, duration, peak flashes per minute, or largest cell area. |
| `value` | number | yes | minimum `0` |  |
| `rank` | integer | yes | minimum `1` | Rank among the storms the highlight was chosen from, 1 for the most. |

### StormHighlight

Defined in `data/contract/storm.schema.json`.

One highlighted storm and the reason it was chosen.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `kind` | string | yes |  | Why it was picked: best of the last 24 h or 7 days, best of a broad area over 24 h, a 7 day record, or the most active storm that stayed over one spot for hours. |
| `area` | string or null | yes |  | Broad area from the storm centroid, set when kind is area. |
| `storm` | [StormSummary](#stormsummary) | yes |  |  |
| `metric` | [StormMetric](#stormmetric) or null | no |  | Null in files older than 2.8.0. |

### StormHighlights

Defined in `data/contract/storm.schema.json`.

storms/highlights.json: a few published storms worth replaying, best first.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `schema_version` | [SchemaVersion](#schemaversion) | yes |  |  |
| `published_at` | [UtcTimestamp](#utctimestamp) | yes |  |  |
| `last_observation_time` | [UtcTimestamp](#utctimestamp) or null | yes |  |  |
| `highlights` | array of [StormHighlight](#stormhighlight) | yes |  |  |

### StormDetail

Defined in `data/contract/storm.schema.json`.

storms/<slug>.json: bounded metadata and replay references.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `schema_version` | [SchemaVersion](#schemaversion) | yes |  |  |
| `published_at` | [UtcTimestamp](#utctimestamp) | yes |  |  |
| `last_observation_time` | [UtcTimestamp](#utctimestamp) | yes |  |  |
| `storm` | [StormSummary](#stormsummary) | yes |  |  |
| `bounds` | [StormBounds](#stormbounds) | yes |  |  |
| `track` | array of [StormTrackPoint](#stormtrackpoint) | yes |  |  |
| `replay` | [StormReplay](#stormreplay) | yes |  |  |

### SourceFrontier

Defined in `data/contract/active.schema.json`.

How far a source's data reaches.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `source` | [Source](#source) | yes |  |  |
| `observed_until` | [UtcTimestamp](#utctimestamp) or null | yes |  | End of the newest product file of this source included; null when none is. Its flashes after this time are not in the snapshot yet. |

### PathPoint

Defined in `data/contract/active.schema.json`.

Centroid of a storm's flashes over one 10 minute slice.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `time` | [UtcTimestamp](#utctimestamp) | yes |  | Mean event time of the slice's flashes, never later than the data. |
| `lat` | number | yes | minimum `-90`, maximum `90` |  |
| `lon` | number | yes | minimum `-180`, maximum `180` |  |
| `flash_count` | integer | yes | minimum `1` |  |

### ActiveCell

Defined in `data/contract/active.schema.json`.

One active storm and its current cell.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | string | yes | minLength `1`, maxLength `128` | Storm id: the catalog storm_id once provisional is false. |
| `provisional` | boolean | yes |  | True while the storm started in an hour the catalog has not tracked yet; its id may then be replaced. |
| `previous_ids` | array of string | yes | minLength `1`, maxLength `128` | Ids this storm had in earlier snapshots, newest first. |
| `slug` | string or null | yes |  | Catalog slug once the storm is published (storms/<slug>.json), else null. |
| `name` | string or null | yes |  | Short place name once the catalog has named the storm, else null. |
| `level` | integer | yes | minimum `1` | ADR 0009 level on the data so far; it only rises and is never below the catalog's. |
| `flashes` | integer | yes | minimum `0` | Flashes of the storm so far on the source its level is computed from. |
| `t_start` | [UtcTimestamp](#utctimestamp) | yes |  | First flash of the storm. |
| `t_end` | [UtcTimestamp](#utctimestamp) | yes |  | Last flash of the storm so far. |
| `lat` | number | yes | minimum `-90`, maximum `90` | Centroid of the current cell. |
| `lon` | number | yes | minimum `-180`, maximum `180` |  |
| `bounds` | [StormBounds](#stormbounds) | yes |  |  |
| `area_km2` | number | yes | minimum `0` | Area of the current cell's convex hull. |
| `hull` | array of array of number | yes | minItems `2`, maxItems `2` | Closed [lon, lat] ring of the current cell's convex hull, at most 33 points. Longitudes stay continuous around the centroid, so they may leave -180..180 near the antimeridian. |
| `sources` | array of [Source](#source) | yes |  |  |
| `split_from` | string or null | yes |  | Storm this one split off, when it started that way. |
| `merged` | array of string | yes | minLength `1`, maxLength `128` | Storms that merged into this one in the open hour. |
| `path` | array of [PathPoint](#pathpoint) | yes |  | Observed centroids, oldest first, over at most the last two hours. Older positions are in the catalog track. |

### EndReason

Defined in `data/contract/active.schema.json`.

Why a storm left the feed: expired 30 minutes after its last flash (measured on its sources' data), merged into another storm, replaced by another id while provisional, or no data from its sources for an hour. Only a storm ended by source-gap may come back under the same id.

| Index | Value |
|---|---|
| 0 | `expired` |
| 1 | `merged` |
| 2 | `replaced` |
| 3 | `source-gap` |

### EndedStorm

Defined in `data/contract/active.schema.json`.

A storm that left the feed, and where to follow it.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | string | yes | minLength `1`, maxLength `128` |  |
| `reason` | [EndReason](#endreason) | yes |  |  |
| `into` | string or null | yes |  | Storm that continues it, for merged and replaced; else null. |
| `t_end` | [UtcTimestamp](#utctimestamp) | yes |  | Last flash seen for it. |
| `ended_at` | [UtcTimestamp](#utctimestamp) | yes |  | published_at of the first snapshot without it. |

### ActiveStorms

Defined in `data/contract/active.schema.json`.

storms/active.json: storms active now and their current cells, rewritten after each update (ADR 0021).

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `schema_version` | [SchemaVersion](#schemaversion) | yes |  |  |
| `published_at` | [UtcTimestamp](#utctimestamp) | yes |  | When this snapshot was written. |
| `authoritative_until` | [UtcTimestamp](#utctimestamp) or null | yes |  | End of the last hour tracked by the storm catalog. A storm that started before it has its final id; null before the first tracked hour. |
| `update_seconds` | integer | yes | minimum `1` | Typical time between snapshots. Clients judge staleness from published_at, never by assuming this cadence. |
| `min_level` | integer | yes | minimum `1` | Storms below this intensity level (ADR 0009) are left out of cells and ended. |
| `sources` | array of [SourceFrontier](#sourcefrontier) | yes |  | Data frontier of each source in this snapshot. |
| `cells` | array of [ActiveCell](#activecell) | yes |  | Active storms, one current cell each, strongest first. |
| `ended` | array of [EndedStorm](#endedstorm) | yes |  | Storms that left cells during the last two hours, newest first. |

<!-- END GENERATED REFERENCE -->

## Storm catalog on R2

The versioned schema is `data/contract/storm.schema.json`. `storms/<slug>.json` contains the
persisted summary, bbox, centroid track, publication time, last observation time and replay
references. Slugs come from `gold/storm_names` and never change. Bounds with west greater than east
cross the antimeridian. All timestamps represent UTC instants. Intensity names and rules are read
from `gold/storm_levels`; publication forwards the accepted ADR 0009 classification unchanged.

Replay chunk paths are relative to the public data root, not the metadata URL. Each immutable
`storms/chunks/<sha256>.bin.gz` uses the existing live binary layout with an event-hour origin;
its schema version is in the binary header, and publication/observation timestamps are carried by
its enclosing detail document. This clarifies #74's singular extract filename and its requirement
for timestamps on every file without changing the live encoding. The replay selection provenance
is mandatory: `track-bounds` may include nearby unrelated flashes, so its count is separate from
the storm's classified count. No cloud archive discovery is implied by this contract. Chunks are
deleted 60 days after they are written, so a replay is kept at least 60 days after the storm starts;
the detail document stays and readers report an older replay as expired.

`storms/index/<page>.json` uses zero-based pages of 50 summaries counted from the oldest storm by
start, then storm id; each page lists its storms recent first. A new storm only changes the last
pages, so older pages are written once. `storms/index/latest.json` repeats the last page on every
run: read it first, then step back by page number. Its totals are authoritative; an older page keeps
the totals of its own publication. Page zero exists for an empty catalog. Old pages can remain after
a catalog shrinks and must not be exposed beyond the total page count. Sitemap
files include schema and freshness metadata in XML comments, preserve the sitemap protocol, and
stay below its 50,000 URL / 50 MiB limits. Region entries require an existing #75 detail file.

## Active storms on R2

`storms/active.json` (`ActiveStorms`, `Cache-Control: public, max-age=30`) lists the storms active
now, one current cell each, and is rewritten whole after each update
([ADR 0021](adr/0021-active-storm-cells.md)) every 5 minutes. Its cells are the hours the catalog
has not tracked yet, recomputed from silver with the catalog's own clustering and linking, so:

- A storm that started in an hour the catalog has tracked (`authoritative_until`) carries its
  catalog `storm_id`, which no longer changes. A storm that started later is `provisional`: late
  data or the catalog's run can give it another id. The new cell then lists the old id in
  `previous_ids` and `ended` says `replaced`, with the new id in `into`.
- `sources[].observed_until` is the end of the newest product file of each source in the
  snapshot. A storm is judged on the data of its own sources: it expires 30 minutes of data after
  its last flash, and when its sources stay silent it stays listed, unchanged, until they have
  been silent for an hour (`source-gap`). Only such a storm can come back under the same id.
- `ended` keeps every storm that left `cells` in the last two hours, with the reason (`expired`,
  `merged`, `replaced`, `source-gap`) and, for merges and replacements, the storm to follow.
  A split starts a new storm with `split_from`; the main branch keeps the id.
- `level` follows ADR 0009 on the data so far and only rises. A storm that a merged or replaced
  storm continues into takes at least its level. Storms under `min_level` are left out. `path`
  holds the centroid of each 10 minute slice of observed flashes, at the slice's mean event time,
  over at most the last two hours; earlier positions are in the catalog track.

Clients poll at their own pace and judge staleness from `published_at`. A storm is shown at the
earlier of the scene time and its sources' `observed_until`, never extrapolated beyond its last
path point. `scintille_contract.active` checks a snapshot and two successive snapshots against
these rules. `fixtures/storms/active/0.json` to `4.json` are five snapshots of one synthetic
evening (2026-07-15, 18:26 to 19:41 UTC): a late MTG LI file replacing a provisional id, a split,
a merge, an expiry, provisional ids becoming final, and an MTG LI outage ending two storms.

## Storm replay data

`GlobeApp.data.openStorm(baseUrl, slug, speed)` loads the published metadata and SCNT gzip
extract at `storms/<slug>.json` and switches the existing scene clock to replay. It returns
metadata on success and `null` when superseded or cancelled. Replay chunk paths resolve against
`baseUrl`, as specified in the storm publication contract. `data.open(source, speed)` accepts an
injected archive source for fixtures or future time-range queries.

Loading keeps the current observations until the new extract is complete. Replay stops live
polling, retains the immutable extract on the CPU and moves a bounded window through the same
ring used by lightning and thunder. Seeking updates that window on the next animation frame.
`data.live()` cancels pending loads, clears the replay window and starts a fresh live client;
it downloads the current manifest's chunks again. Disposal releases the archive and subscriptions.
CPU memory scales with the extract's flash count; the renderer ring and GPU capacity stay fixed.
Sliding the same extract preserves logical flash indices and pending thunder; dataset replacement
invalidates those consumers.
Camera entry, historical cloud restoration and replay controls are handled by the subsequent
replay tickets.

### Replay fixture verification

Dev and Preview builds accept `/?storm=2026-07-15-orlando` (optional positive `speed`, default 1).
The entry loads the synthetic fixture and places the camera over it for inspection; production
builds ignore this query. In dev, run `python3 fixtures/serve.py` alongside `pnpm -C web dev`.
Preview builds bundle the metadata and gzip chunk under `/_replay-fixtures/`, without requiring
a fixture upload to R2. These assets are omitted from production builds.

Open that URL, choose the 5 min afterglow, enable thunder from the HUD, and observe the three
fixture flashes. Click Live,
check that the old flashes and pending thunder disappear, then click Time travel to reload the
fixture in the same scene. Repeat these two controls without reloading the page.
Use the browser's graphics/audio tools to check stable
resources across repeated round trips. This fixture entry is for loader QA; it does not implement
production storm links or scene restoration.
