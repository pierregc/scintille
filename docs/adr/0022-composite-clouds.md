# 0022 · Composite clouds of about 1 km, served as detail tiles

- Status: proposed
- Date: 2026-10-28

## Context

[ADR 0007](0007-cloud-source.md) started the cloud layer with NOAA GMGSI (8 km, hourly, about
40 minutes late) and kept a home-made infrared composite as the upgrade (#131).
[ADR 0020](0020-immersive-storm-view.md) set its target: clouds of about 1 km so that a cloud texel
covers at most 4 CSS px with bicubic filtering at the 400 km camera floor; 2 km infrared where
nothing finer exists, smoothed, never sharpened.

A 1 km equirectangular frame is 40,960 × 20,480 texels. No single texture holds it (16,384 is the
usual limit, and one channel would take 840 MB), so the decision covers the source, how the
visible channel is used, and how the client gets the detail.

## Options

Delivery:

- **2 km composite in the existing 4k texture.** No gain at the floor: the 4k frame has 9.8 km
  texels whatever feeds it.
- **One finer global texture.** At most 2.4 km (16k), about 134 MB of GPU memory per frame and
  tens of MB per download. Over every budget of ADR 0020.
- **Tile pyramid loaded around the camera.** Only the detail on screen is fetched and kept.

Visible channel, by day:

- **Reflectance as opacity.** Shows warm low clouds that the infrared misses, but deserts, snow
  and sun glint become clouds (on 2026-10-18 14:00 the Sahara came out at 0.16 opacity where GMGSI
  is clear), and the day and night halves stop matching at the terminator.
- **Reflectance as detail.** The infrared sets how much cloud there is; the ratio of the
  reflectance to its value smoothed at the infrared scale sharpens edges and gaps. Clear sky stays
  clear because a ratio cannot make opacity out of nothing.

## Decision

**Sources**, each hour, the full disk scan that starts on the hour:

| Satellite | Infrared | Visible | Where from | Listed after the hour |
|---|---|---|---|---|
| GOES-19 (East), GOES-18 (West) | ABI band 13, 10.3 µm, 2 km | ABI band 2, 0.64 µm, 0.5 km averaged to 1 km | NOAA, AWS | about 10 min |
| Himawari-9 | AHI band 13, 10.4 µm, 2 km | AHI band 3, 0.64 µm, 0.5 km averaged to 1 km | JMA via NOAA, AWS | about 11 min |
| MTG-I1 | FCI `ir_105`, 1 km | FCI `vis_06`, 0.5 km averaged to 1 km | EUMETSAT Data Store, high resolution collection, repeat cycle of the hour | about 15 min |
| fill | GMGSI mosaic, latest at most 2 h old | none | NOAA, AWS | |

**Composite**, for every output texel and disk: the cloud top is placed above the ground point it
belongs to (parallax corrected with a height from the cooling below the GFS skin temperature at
6.5 K/km, 0 to 15 km, smoothed over about 16 km), disks are weighted by cos⁴ of the view zenith
angle and fade out between 78° and 84°, and GMGSI fills where none sees better (the Indian Ocean
seam above about 50° latitude, western Siberia, a missing satellite). Opacity keeps the rule of
ADR 0007 on the blended brightness temperature; by day the visible ratio, bounded to 0.5 to 1.6,
multiplies it. The polar fade (68° to 72.7°) is unchanged.

**Tiles**: 640 texels plus a border of 2 repeated from the neighbours, levels 3, 4 and 5 (3.9,
2.0 and 0.98 km), grayscale WebP. Levels 3 and 4 cover ±72.7°; level 5 exists only where a source
of about 1 km does (the day side, and FCI by night). The `2k` and `4k` textures of the existing
contract are cut from level 3, so the switch from GMGSI needs no client change. Tiles are written
once under `archive/clouds/detail/` and both manifests point to them
([data contract](../data-contract.md#cloud-detail-tiles)).

**Client**: tiles go into a texture array of 48 layers (R8, 20 MB), with one page table per blended
frame. The level is the coarsest whose texel covers at most 2 CSS px where the view meets the
cloud shell; a tile fades in over its parent in 0.4 s and is filtered with the same cubic
B-spline. Global frames are uploaded as one channel (R8) instead of RGBA.

**Licence**: under the EUMETSAT data policy amended in November 2025 (Article 4), "All Level 1
Hourly SEVIRI, FCI and IRS data" are Core data, free and unrestricted under CC BY 4.0 whatever
their latency (Article 5.1); Hourly Data are "nominal full disk repeat cycles of data referenced
by EUMETSAT in time to each clock hour (UTC)". Only that cycle is used. Other cycles with less
than an hour of latency are Recommended data (licence, possible fees) and are not used, not even
to fill a gap. Attribution (Article 6.3): "Contains modified EUMETSAT Meteosat data 2026". GOES is
NOAA open data; Himawari is credited to JMA; GMGSI keeps its credit.

## Measurements

2026-10-18 at 12, 14, 19 and 23 UTC, rendered on the reference Mac:

| | Per hourly frame |
|---|---|
| Download | 1.9 to 2.3 GB (FCI 1.0 to 1.1 GB, GOES band 2 0.3 to 0.4 GB each, Himawari band 3 0.1 to 0.3 GB), 104 to 138 s over a home line |
| Decode | 30 s, peak resident memory 2.2 GB of which about 1.4 GB are the memory-mapped disks |
| Render | 123 s with 2 worker processes, 240 s of CPU (14 UTC) |
| Tiles | 1,286 to 1,810, 30 to 34 MB; `2k` 0.31 MB and `4k` 0.94 to 1.0 MB, as GMGSI |
| Ready | about 15 min after the hour, published 20 to 30 min after it (GMGSI: about 45 min) |

| | Per day | 30 day archive |
|---|---|---|
| Ingress | 45 to 55 GB | |
| R2 storage | about 0.8 GB | about 25 GB, about 0.4 USD a month |
| R2 writes (class A) | about 40,000 | about 1.2 million a month, about 5.4 USD before the free tier |

Client, five reference storms at the hour, four poses ([immersive view](../immersive-view.md)),
`bench.mjs` at afterglow 0, against the baseline:

| | Desktop | Mobile emulation (R2, R5) | Baseline desktop |
|---|---|---|---|
| Frame cost p95 | 5.4 to 10.0 ms, tier kept at `high` | 2.3 to 5.4 ms, `medium` | 7.3 to 8.3 ms |
| 3 s flights | p95 at most 10.2 ms, no interval over 50 ms | | p95 at most 9.2 ms |
| GPU textures | 210 to 221 MB | 178 MB | 268 MB |
| First load | 5.0 to 8.7 MB | 3.9 to 4.7 MB | 6.6 to 8.1 MB |
| `globe` to `iss` | 0 to 1.1 MB | 0 to 0.3 MB | about 1 kB |

Alternating the detail path on and off on the same page at `iss` and `window` (3840 × 2160)
changes the frame interval by 0.3 to 0.7 ms.

Side by side with GMGSI at the four poses: [`immersive/composite/`](../immersive/composite/).

## Consequences

- Clouds stay hourly but arrive about 20 minutes earlier; the lag to the lightning shrinks to
  20 to 80 minutes.
- At the floor a cloud texel is 0.98 km by day everywhere and by night over Europe and Africa:
  about 4.3 CSS px at `iss`, 3.4 at `window`. At night elsewhere level 4 (2 km) is the finest:
  smooth, about twice softer.
- Warm low clouds stay faint, as with GMGSI: the visible channel only refines what the infrared
  sees.
- The parallax height assumes a lapse rate: thin cirrus are placed too low and shifted less than
  they should be.
- The Indian Ocean seam keeps GMGSI's 8 km where neither MTG nor Himawari sees well; Meteosat-9
  over the Indian Ocean would close it.
- The VPS downloads about 2 GB and spends a few CPU minutes per hour; the work directory needs
  about 4 GB of disk while a frame is built.
- R2 class A operations grow by about 1.2 million a month. Packing a frame's tiles into one object
  read by range would cut them to a few thousand if the bill matters.
- The 30 day lifecycle on `archive/clouds/` also bounds the detail of replays.
- Offline rendering (`/render`) keeps the global frames; it does not load detail yet.
- The texture array with page tables is generic: the ground detail of #252 and #253 can reuse it.
