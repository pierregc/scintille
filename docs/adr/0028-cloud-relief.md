# 0028 · Clouds in relief: observed tops, assumed columns, drawn as a volume

- Status: proposed
- Date: 2026-10-29

## Context

The composite of [ADR 0023](0023-composite-clouds.md) gives cloud opacity at about 1 km, drawn on
one shell 10 km above the ground. From the 400 km floor an anvil is a flat white sheet: opacity
saturates, every top sits at the same height, nothing casts a shadow, and the `window` and horizon
views show no side to any cloud (#312).

Satellites see only the tops, but they measure where the tops are: the infrared brightness
temperature of an opaque top is the air temperature at its height. That height is already
estimated for the parallax correction (cooling below the surface at 6.5 K/km, smoothed over
16 km). Nothing observes the base or what lies under the top.

Constraints: no source is sharpened and no detail is invented ([ADR 0020](0020-immersive-storm-view.md)
point 2, visual rule 12 of [immersive view](../immersive-view.md#visual-rules)); the budgets of
ADR 0020 hold on the reference Mac and on phones; the infrastructure stays free (R2 free tier
goal, one object per frame); lightning channels stay inside the clouds.

Headroom today ([final validation](../immersive-view.md#final-validation)): frame cost p95 up to
9.6 ms desktop for 10; GPU memory 332 MB desktop for 384 and 244 MB on phones for 256; a real phone
is not measured yet.

## Options

**Top height**

- **Lapse rate from the skin temperature**, as the parallax does. Free, but biased where the ground
  is much hotter or colder than the air: 20 K of desert skin by day puts a low cloud 3 km too high.
  No tropopause, so the coldest tops are clipped.
- **GFS temperature profile.** The top is placed where the forecast air is as cold as the cloud,
  searching up from the ground. Fixes the skin bias and the tropopause; costs the temperature and
  height fields of 22 pressure levels per hour (44 GRIB messages, about 35 MB from the same bucket).
- **Operational height products.** GOES ABI `ACHA2KMF` (2 km, 30 MB per disk and hour), Himawari
  `AHI-CHGT` (750 MB per hour), FCI products not checked for content or licence. Better physics for
  thin cirrus, but three algorithms that disagree at the seams of the composite, and two heavy or
  unknown feeds.

**Drawing**

- **Lit flat layer.** Normals from the height, sun shading and ground shadows on today's shell.
  Cheap (one more texture fetch), but no side to any cloud: the grazing views stay flat.
- **Displaced mesh.** A surface lifted to the tops. Walls become stretched triangles, light does
  not go through the cloud, translucent edges sort badly, and it needs a dense mesh near the camera
  and a shadow map.
- **Height-field volume.** Each texel is a column of cloud from a base to the observed top, with
  the observed opacity as its optical depth, ray marched in a few steps per pixel. Real thickness,
  walls, light and shadow through the cloud, without inventing detail inside the column.
- **Procedural 3D volume** (game clouds: a weather map plus 3D noise). The most billowing look, but
  the billows are invented (rule 12, out of scope of #312) and it needs several times the steps and
  texture reads measured below.

**Base and thickness**

- **Columns down to the ground.** Every cirrus deck becomes a 10 km wall at grazing views.
- **Fixed thickness.** Anvils and convective cores look alike: storms lose their towers.
- **Thickness by top height and by depth inside the cloud system.** Thin layers for low and thin
  clouds, a shallow anvil at the edge of a storm, a deep core inside it. Still an assumption, but
  one that follows the observed fields.

**Visible reflectance.** #312 suggests publishing the visible detail as well. Since ADR 0023 it is
already in the opacity tiles, as a ratio that sharpens edges by day. A separate brightness plane
would show the sub-2 km texture of saturated anvils by day, at the cost of doubling the level 5
tiles (about 20 MB more per hour, 20 MB more GPU memory, where phones have 12 MB left).

## Decision

Draw the clouds as a **height-field volume**: observed tops, assumed columns, no procedural detail.

**Top height.** From the blended infrared brightness temperature of the composite, matched to the
GFS temperature profile (geopotential height of the 1000 to 70 hPa levels, linear in between),
searching up from the ground for the first level as cold as the cloud; colder than the tropopause,
above it at 7 K/km (overshooting tops). Heights are above sea level, as the Earth is drawn as a
smooth sphere. Without a profile (GFS late), the lapse rate of today is the fallback. The same
heights, smoothed, feed the parallax correction. Before the client is built, the heights are
compared with GOES `ACHA2KMF` over the GOES-East disk at the reference hours: the profile method is
kept if it beats the lapse rate there (median absolute difference on opaque clouds, low clouds
reported separately); otherwise the lapse rate stays and no profile is downloaded.

**Height tiles.** Levels 3 and 4 only (3.9 and 2 km, the infrared resolution; FCI's 1 km infrared
is not worth a level 5 plane once the conversion error is counted). Same grid and border as the
opacity tiles, 8 bits from 0 to 20 km (78 m steps), grayscale WebP. Clear texels take the height of
the nearest tops, so filtering never ramps a top down to the ground and the plane compresses well.
They go into the same `.tiles` object as extra index entries, so a frame stays one R2 write; the
manifest's `detail` block lists `height_levels`. Packs without heights (older frames, GMGSI
fallback) draw as today. The visible brightness plane is not published: decided again on captures.

**Columns.** For each texel: top `H` observed; base `B = H − thickness`, assumed:

| Cloud | Thickness |
|---|---|
| Top below 3 km | 0.6 to 1 km |
| Higher, thin (opacity under 0.6) | 1.5 km |
| Higher and opaque, at the edge of a system | 2.5 km (anvil) |
| Higher and opaque, inside a system (opacity at least 0.8 over about 40 km) | down to 1.5 km above sea level (core) |

The base never goes below 0.2 km. The vertical optical depth comes from the observed opacity,
`τ = −ln(1 − α)`, spread evenly over the column, so a column seen straight down hides the ground as
the flat layer does now and a wall seen from the side is as opaque as the path through it. Infrared
cannot measure how opaque a saturated top is: its optical depth is an assumption, tuned on captures.
The constants live in one table in the code and in the methodology.

**Rendering**, below the camera height where detail tiles are loaded, the flat layer above it and
beyond the region the volume covers, fading into each other:

1. **Bake**, from the detail tiles of the two blended frames: nested windows around the point
   looked at (1, 2, 4 and 8 km texels; 512² on desktop, 256² on phones) holding opacity, top, base
   and the sun's transmittance at four heights. Re-baked one window per frame, only when the view,
   the frames or the sun change.
2. **March** at half the CSS resolution, between the ground and 20 km: steps of about one texel
   horizontally, at most 48 (32 on phones), stopping at 98 % opacity. Each step reads the field and
   the sun map once and counts the exact length of the step inside its column.
3. **Light**: sun with a forward scattering phase and a multiple scattering term, sky light, the
   twilight colours of today's layer; at night, the flash light map as light emitted inside the
   column at channel heights.
4. **Composite** over the ground before the atmosphere and lightning, as today. The Earth shader
   darkens sunlight by the baked transmittance at the ground: cloud shadows.

**Lightning.** Channel heights are fitted into the local column: in-cloud leaders below `H − 0.5 km`
and above the base, ground channels from the base down. The veil reads the column on the line of
sight instead of the 10 km shell. Where no height exists, the assumed 12 km top and 10 km shell
remain.

**Tiers.** `high` and `medium` draw the volume; `low` keeps the flat layer. On phones the volume is
enabled only once a real phone holds the 33 ms frame interval with it; until then phones keep the
flat layer. The volume never pushes a pose over the ADR 0020 budgets: if it does, the march
resolution and step cap go down before it ships.

**Observed, procedural, assumed.** Top height: observed (infrared, converted with the GFS profile;
thin cirrus placed too low). Base, thickness, optical depth of saturated tops: assumed. Light and
shadows: procedural, a physical model applied to the assumed columns. Channel heights: assumed,
bounded by the observed top. A development toggle tints what lies below the observed tops.

## Measurements

**Prototype**: a WebGL2 page with the march, the sun bake and the composite described above, on real
opacity tiles (2026-10-29 17 UTC, 2,500 km of convection over Brazil, levels 5 and 3) and
synthetic tops derived from them (1.5 to 14 km). Chromium headed on Metal on the reference Mac, GPU
synchronized each frame, two runs; other GPU work on the machine adds noise. Poses as in
[immersive view](../immersive-view.md#poses) (`horizon` is the horizon view, tilt 72°).

| March, desktop 3840 × 2160 buffer | `iss` | `window` | `horizon` |
|---|---|---|---|
| Full resolution | 3.5 to 3.7 ms | 10.9 to 11.7 ms | 6.2 to 8.3 ms |
| Half the buffer (1920 × 1080) | 1.0 to 1.1 ms | 3.2 ms | 1.6 to 1.7 ms |
| Half the CSS size (960 × 540), chosen | 0.3 to 0.4 ms | 1.0 to 1.1 ms | 0.9 to 1.3 ms |
| Phone emulation, 590 × 1278 buffer, march 197 × 426 | 0.03 to 0.07 ms | 0.2 to 0.7 ms | 0.3 to 0.6 ms |
| Mean steps per pixel, desktop (cap 48) | 8 | 28 | 22 |

Sun bake, two windows: 0.1 to 0.3 ms at 256², 0.7 to 1.4 ms at 512². Upsampling and compositing at
full resolution: 0.2 to 0.4 ms.

**Height plane size**: synthetic tops encoded like the tiles weigh 40 to 67 % of the opacity tile
they come from. Levels 3 and 4 hold 14.8 MB of the 35 MB pack of that hour: heights add about
8 MB per hour (+25 %). Real heights carry more texture; measured on the reference hours before
the client work.

## Consequences

- Desktop cost: about 1.5 to 2.5 ms with the bake at its worst, minus the flat layer it replaces
  near the floor. With `window` at 9.6 ms today this is at the budget's edge: the bake runs one
  window per frame and the march stops early on opaque tops, and the budget is checked with
  `bench.mjs` before merge.
- Phones: a few tenths of a millisecond in emulation; a phone GPU is several times slower than the
  reference Mac, hence the real phone gate.
- GPU memory: heights in their own array (16 layers on desktop, 8 on phones), the baked windows
  and the march target: about +19 MB desktop (about 351 of 384) and +6 MB on phones (about 250 of
  256, tight).
- Transfer: first load unchanged; zooming to the floor adds a few height tiles, about 0.1 to
  0.3 MB.
- R2: pack about +25 %, detail storage about +0.2 GB at one day kept, writes and the number of
  objects unchanged. VPS: +35 MB of GFS per hour if the profile wins, and the height computation on
  level 4 (estimated +5 to 10 % of render time, measured).
- Walls and bases are assumptions, and at grazing views they fill much of the image: the
  methodology and the debug toggle say so. Thin cirrus sit too low; warm low clouds stay faint, as
  with today's opacity.
- No billowing detail: walls are as smooth as the 1 km opacity and 2 km heights that shape them.
  Adding procedural detail would amend visual rule 12, a separate decision.
- The reference storms' packs predate the heights and their detail has expired: before and after
  captures render the five reference hours again locally with the new pipeline, as #131 did.
- Offline rendering (`/render`) keeps the flat layer until it loads detail tiles.
- Delivery in two PRs under #312: ingestion first (heights, pack, validation against `ACHA2KMF`),
  so production carries heights before the client needs them; then the client, after #331, #332,
  #333, #341 and #346.
