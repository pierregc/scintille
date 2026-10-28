# 0022 · Surface imagery: a 500 m raster pyramid, no vector overlays

- Status: accepted
- Date: 2026-10-28

## Context

[ADR 0020](0020-immersive-storm-view.md) puts the camera floor at 400 km and asks for ground
texels of at most 2 CSS px there: 500 m for day, night lights and water mask. Today the globe draws
one 4k texture per layer (9.8 km texels), 42 px wide at the `iss` pose. #125 compares two ways to
get detail: (a) a raster pyramid loaded by visible level, (b) the current textures plus vector
overlays (coastlines, borders, lakes, cities) that stay sharp at any zoom. #251 to #253 build the
choice.

Method. Both prototypes run on the merged renderer behind `?surface=base|tiles|vectors` (Shift+S
cycles), in development and PR previews only. Measurements use `web/scripts/bench.mjs` on the five
reference storms and four poses of [immersive view](../immersive-view.md), afterglow 0, clouds on,
against a local production build that proxies the live data
([`web/spike/surface`](../../web/spike/surface/README.md)). Same Mac as the baseline, headless
Chromium on Metal: frame costs run about 1 ms above the headed baseline, so modes are compared with
each other, not with the baseline.

## Source audit

| Layer | Source | Grid | Real detail | Today | Licence |
|---|---|---|---|---|---|
| Day | Blue Marble Next Generation, August 2004, topography without bathymetry, 8 tiles of 21600 × 21600 (`world.topo.200408.3x21600x21600.A1…D2.jpg`, 372 MB) | 15″, 463 m at the equator | MODIS 500 m composite: real 500 m | 21600 × 10800 release (1.85 km) resized to 4k | Public domain, credit NASA Earth Observatory |
| Night | Black Marble 2016 colour, 8 tiles of 21600 × 21600 (`BlackMarble_2016_A1…D2.jpg`, 216 MB) | 15″ | VIIRS day/night band, 742 m pixels: the 15″ grid is NASA's resampling, lights are about 0.75 km sharp | 3 km release resized to 4k | Public domain, credit NASA Earth Observatory |
| Water mask | Natural Earth 10m ocean and lakes, rasterized at 15″ | 15″ | 1:10 M generalisation: coasts within one or two texels of the imagery, larger lakes only | Same polygons at 4k | Public domain |

All files exist at the URLs pinned in `web/scripts/textures/tiles.mjs` (size and SHA-256 checked on
2026-10-28). NASA GIBS serves the same releases re-tiled at 500 m (`BlueMarble_NextGeneration`,
`VIIRS_Black_Marble`) plus a 250 m MODIS water mask (`MODIS_Water_Mask`); building from the original
files keeps today's colours, pinned checksums and our own tile borders, and needs no hotlinking.
Against the imagery, the MODIS mask follows the same coasts as Natural Earth and adds small lakes
(Florida, Balearic Islands checks); the mask only drives sun glint, so Natural Earth stays.

So 500 m is real for the day layer. The night layer reaches 0.75 km, between 2 and 3 CSS px at
the floor: lights are smooth, not blocky, and no finer source exists.

## Options and measurements

| | Base (today) | (a) Raster pyramid | (b) Vector overlays |
|---|---|---|---|
| What it adds at `iss` | nothing: 9.8 km texels, 42 px blocks | the imagery itself: rivers, fields, clearings, coasts, at 2 px per texel | lines on coasts, borders and lakes; the ground between them stays 42 px blocks |
| ISS look | soft blur | photographic, as seen from orbit | a map drawn over a blur: an island is a sharp outline around a blob |
| Night | 3 km lights resized to 4k | lights at their sensor resolution, soft points | unchanged lights, outlines dimmed |
| First load, Earth (desktop) | 1.02 MB | 1.33 to 2.20 MB | 1.02 MB + 2.0 MB gzip (5.1 MB raw) as soon as the view is below 9,000 km |
| Cold dive `globe` to `iss` | 0 | 0.27 to 0.92 MB desktop, 0.01 to 0.32 MB mobile | 0 |
| `iss` to `window` | 0 | 0.02 to 1.00 MB desktop, 0.02 to 0.36 MB mobile | 0 |
| Back to `globe` | 0 | 0.09 to 0.68 MB desktop, under 0.1 MB mobile | 0 |
| GPU textures and buffers | 277 MB desktop, 244 MB mobile | 314 to 382 MB desktop (33 to 96 tiles of 1.09 MB), 252 to 281 MB mobile | 277 MB + 35 MB of line buffers |
| Frame cost p95, desktop, median of 20 poses (range) | 9.5 ms (8.0 to 12.3) | 10.1 ms (7.9 to 13.8), up to 69 draw calls instead of 28 | 9.5 ms (7.8 to 11.4) |
| 3 s flights | no interval over 50 ms | same | same |
| Storage, build | 2 MB | 226 MB, 18,619 WebP files, built in 3 min from 588 MB of sources | 5 MB |
| Licence | NASA, Natural Earth | same | Natural Earth, public domain |
| Effort | | L: build (#251), loader (#252), seamless rendering (#253) | M, and still no ground detail |

Captures, left to right base, tiles, vectors, 100 % centre crop at DPR 2 (`regional` whole frame):
[`immersive/surface/`](../immersive/surface/), clouds off unless the name ends in `-clouds`.
`R2-regional.jpg` and `R5-window.jpg` show the gap best: the Amazon and the Balearic Islands go from
blur to imagery. `R2-iss-clouds.jpg` is the other half of the story: under GMGSI overcast the ground
does not show at all, so clouds (#131) decide what the floor views look like over storms.

Frame costs are noisy: other jobs shared the GPU during part of the session, and a second run
gave 13 to 24 ms for both base and tiles. The figures above come from the quiet run, measured back
to back. #253 measures again on a quiet machine.

Tile format, on 72 tiles around the reference storms:

| Format | Day tile (452 × 452) | Night tile | GPU per tile, mipmaps | Look at 2 px per texel |
|---|---|---|---|---|
| WebP q85, mask in alpha (lossless) | 19 kB | 7 kB | 1.09 MB (RGBA8) | source quality |
| KTX2 ETC1S q90 | 47 kB | 17 kB | 0.27 MB | 4 × 4 blocks and colour steps visible on forest |
| KTX2 UASTC, RDO, Zstandard | 142 kB | 68 kB | 0.27 MB | close to source |

Night lights at 15″ show as squares: Black Marble 2016 spreads each 742 m VIIRS pixel over 2 × 2
texels. Drawn from the 0.93 km level with a cubic B-spline they become soft points, which is the
real resolution, at a quarter of the memory and transfer. They look dimmer and less orange than the
squares: brightness is tuned in #253.

## Decision

Adopt (a); do not adopt (b).

1. **Sources.** Day from the Blue Marble Next Generation 500 m tiles, night from the Black Marble 2016
   500 m tiles, water from Natural Earth 10m polygons; original NASA files pinned by size and SHA-256,
   not GIBS tiles. Attribution is unchanged (NASA Earth Observatory).
2. **Layout.** Equirectangular tiles of 450 texels plus one border texel copied from the neighbours
   (452 × 452), longitudes wrapping, poles repeating their last row. Levels 2 to 5 cover 15°, 7.5°,
   3.75° and 1.875°; level 5 is the native 15″ grid, never upsampled. The 4k global textures stay the
   fallback underneath. Night stops at level 4 (0.93 km), sampled with a cubic B-spline.
3. **Format.** WebP: day RGB at q85 with the water mask as lossless alpha (colour kept under it),
   night RGB at q85. Tiles with nothing their ancestors lack (open water by day, unlit dark by night)
   are left out; a versioned manifest lists the levels and a presence bitset per layer. KTX2 is not
   used: ETC1S shows its blocks at 2 px per texel and UASTC costs 7 times the transfer.
4. **Hosting.** One immutable file per tile under a new versioned prefix next to today's textures
   (`textures/v3/`), published before its manifest. No PMTiles or other archive: single files cache
   at the edge as they are, need no index request and cost one upload of about 19,000 objects.
5. **Loading.** A tile is wanted while a texel of its parent would cover more than 2 CSS px at its
   nearest point; it is requested once wanted for 300 ms, so flights do not load what they pass
   through. Day tiles load only where the sun is above −21°, night tiles where it is below 3°. While
   a tile loads, its nearest loaded ancestor or the global texture shows.
6. **No vector overlays** in M5: they do not add the missing detail, read as a map rather than a
   view from orbit, and cost 2 MB. Coastlines or borders may come back later as an information layer
   of their own, not as a substitute for imagery.

## Consequences

- #251 builds the published pyramid from `web/scripts/textures/tiles.mjs` (same sources, layout,
  presence rule; night up to level 4) and publishes it to R2. Levels 2 to 5 of day and 2 to 4 of
  night: about 226 MB on R2.
- #252 replaces the prototype loader (`web/src/globe/detail/tiles.ts`) with a tested one: the 2 px
  rule, the 300 ms dwell, cancellation, sun-side layers and a bounded cache. The prototype keeps 96
  textures; a dive and return on desktop filled it (96), mobile peaked at 34. Requests should also stop
  while the camera climbs: going back to `globe` cost up to 0.68 MB, over the 0.5 MB budget.
- #253 draws the detail in the Earth shader in one pass. The prototype draws each tile as a patch
  over the globe with the same shader, so covered ground is shaded twice and level changes pop; it
  showed no seam at tile or level edges in the captures. Night brightness and colour at the 0.93 km
  level are tuned there.
- GPU memory is the tight budget: 382 MB on desktop (384 allowed) and up to 281 MB in mobile
  emulation (256 allowed, 244 MB today). Moving the
  global Earth textures to KTX2 and the cloud frames to one channel ([ADR 0020](0020-immersive-storm-view.md))
  frees about 150 MB and is needed before #253 ships on mobile; until then mobile keeps a smaller
  cache.
- Transfer is far under budget: a cold dive costs at most 0.92 MB on desktop and 0.32 MB on mobile
  (12 and 5 MB allowed), and the first load grows by at most 1.2 MB.
- Ground detail changes nothing under thick cloud: over the reference storms the floor views are
  mostly GMGSI clouds, so #131 matters as much as this decision for what the storm view looks like.
- The methodology states that night lights are about 0.75 km sharp and the day imagery a 2004
  composite.
- The `?surface=` switch, `bench.mjs --surface` and `web/spike/surface/` stay for #251 to #253 to
  compare against; the prototype only runs in development and PR previews.
