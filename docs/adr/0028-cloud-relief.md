# 0028 · Clouds in relief: observed tops, a translucent volume with styled detail

- Status: accepted
- Date: 2026-10-29

## Context

The composite of [ADR 0023](0023-composite-clouds.md) gives cloud opacity at about 1 km, drawn on
one shell 10 km above the ground. From the 400 km floor an anvil is a flat white sheet: opacity
saturates, every top sits at the same height, nothing casts a shadow, the `window` and horizon
views show no side to any cloud, and a flash under an anvil is barely visible (#312).

Satellites see only the tops, but they measure where the tops are: the infrared brightness
temperature of an opaque top is the air temperature at its height. That height is already
estimated for the parallax correction (cooling below the surface at 6.5 K/km, smoothed over
16 km). Nothing observes the base or what lies under the top.

The maintainer wants clouds with real thickness and texture, translucent enough to see lightning
inside them, photographic and never cartoon. [ADR 0030](0030-bounded-aesthetic-license.md) allows
styled detail within stated bounds; this record uses it.

Constraints: the budgets of [ADR 0020](0020-immersive-storm-view.md) hold on the reference Mac and
on phones; the infrastructure stays free (R2 free tier goal, one object per frame); lightning
channels stay inside the clouds. Headroom today ([final validation](../immersive-view.md#final-validation)):
frame cost p95 up to 9.6 ms desktop for 10; GPU memory 332 MB desktop for 384 and 244 MB on phones
for 256; a real phone is not measured yet.

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
  Cheap, but no side to any cloud: the grazing views stay flat.
- **Displaced mesh.** A surface lifted to the tops. Walls become stretched triangles, light does
  not go through the cloud, translucent edges sort badly, and it needs a dense mesh near the camera
  and a shadow map.
- **Height-field volume.** Each texel is a column of cloud from a base to the observed top, ray
  marched in a few steps per pixel: thickness, walls, light and shadow through the cloud. Alone,
  its walls are as smooth as the 1 km opacity and 2 km heights (first capture below).
- **Height-field volume with styled detail.** The same columns, eroded and textured by tiling 3D
  noise below the observations' scale, translucent enough to show the flashes inside.
- **Procedural volume from a weather map** (game clouds). The cloud mass itself would be invented:
  where clouds are must stay observed (ADR 0030, rule 2).

**Base and thickness**

- **Columns down to the ground.** Every cirrus deck becomes a 10 km wall at grazing views.
- **Fixed thickness.** Anvils and convective cores look alike: storms lose their towers.
- **Thickness by top height and by depth inside the cloud system.** Thin layers for low and thin
  clouds, a shallow anvil at the edge of a storm, a deep core inside it.

**Visible reflectance.** #312 suggests publishing the visible detail as well. Since ADR 0023 it is
already in the opacity tiles, as a ratio that sharpens edges by day. A separate brightness plane
would double the level 5 tiles (about 20 MB more per hour, 20 MB more GPU memory, where phones have
12 MB left) for sub-2 km texture on saturated anvils by day, which the styled detail now covers.

## Decision

Draw the clouds as a **translucent height-field volume with styled detail**: observed tops and
cloud cover, assumed columns, styled texture and transparency.

**Top height.** From the blended infrared brightness temperature of the composite, matched to the
GFS temperature profile (geopotential height of the 1000 to 70 hPa levels, linear in between),
searching up from the ground for the first level as cold as the cloud; colder than the tropopause,
above it at 7 K/km (overshooting tops). Heights are above sea level, as the Earth is drawn as a
smooth sphere. Without a profile (GFS late), today's lapse rate is the fallback. The same heights,
smoothed, feed the parallax correction. Before the client is built, the heights are compared with
GOES `ACHA2KMF` over the GOES-East disk at the reference hours: the profile method is kept if it
beats the lapse rate there (median absolute difference on opaque clouds, low clouds reported
separately); otherwise the lapse rate stays and no profile is downloaded.

**Height tiles.** Levels 3 and 4 only (3.9 and 2 km, the infrared resolution; FCI's 1 km infrared
is not worth a level 5 plane once the conversion error is counted). Same grid and border as the
opacity tiles, 8 bits from 0 to 20 km (78 m steps), grayscale WebP. Clear texels take the height of
the nearest tops, so filtering never ramps a top down to the ground and the plane compresses well.
They go into the same `.tiles` object as extra index entries, so a frame stays one R2 write; the
manifest's `detail` block lists `height_levels`. Packs without heights (older frames, GMGSI
fallback) draw as today. No visible brightness plane.

**Columns** (assumed). For each texel: top `H` observed; base `B = H − thickness`:

| Cloud | Thickness |
|---|---|
| Top below 3 km | 0.7 to 1 km |
| Higher, thin (opacity under 0.6) | 1.5 km |
| Higher and opaque, at the edge of a system | 2.5 km (anvil) |
| Higher and opaque, inside a system (opacity at least 0.8 over about 40 km) | down to 1.5 km above sea level (core) |

The base never goes below 0.3 km. The vertical optical depth comes from the observed opacity,
`τ = −ln(1 − α)`, spread over the column, so a column seen straight down hides the ground as the
observation says and a wall seen from the side is as opaque as the path through it.

**Styled detail** (ADR 0030). A tiling 3D noise (Perlin-Worley, 64³ RGBA8, 1 MB) erodes each
column: thin clouds break into cells, edges fray into wisps, tops rise or sink by up to 0.7 km, and
a finer octave textures the surfaces at about 1 km. The noise is fixed to the Earth and drifts
slowly with scene time, so a paused clock gives the same picture. Bounds, checked by a test on the
nadir view: cloud opacity averaged over 4 km blocks within 0.05 of the observed on average and 0.1
per block (prototype: −0.04 and 0.09); tops within 1 km of the observed.

**Translucency and lightning inside** (styled). Opacity is capped at 0.95 straight down (0.92 on
today's layer), so a column of 1.5 to 12 km keeps about half the light of a channel 2.5 km under
its top. Each flash lights the cloud around it: light scattered by the volume over about the
observed footprint, dimmed by the cloud between the flash and each point, so the glow follows the
cloud's texture. The channel itself is veiled by the volume on the line of sight instead of the
10 km shell. Channel heights are fitted into the local column: in-cloud leaders below `H − 0.5 km`
and above the base, ground channels from the base down; where no height exists, the assumed 12 km
top and 10 km shell remain.

**Rendering**, below the camera height where detail tiles are loaded, the flat layer above it and
beyond the region the volume covers, fading into each other:

1. **Bake**, from the detail tiles of the two blended frames: nested windows around the point
   looked at (1, 2, 4 and 8 km texels; 512² on desktop, 256² on phones) holding opacity, top, base
   and the sun's transmittance at four heights. Re-baked one window per frame, only when the view,
   the frames or the sun change.
2. **March** at half the CSS resolution, between the ground and 20 km: steps of about one texel
   horizontally, finer inside cloud for the detail, at most 64 samples, stopping at 98 % opacity.
   **Temporal accumulation**: each frame marches a quarter of the pixels and reprojects the rest,
   so a still or slow view converges and a fast flight is softer for a moment. The pass adapts its
   resolution to stay within 2 ms on the reference Mac.
3. **Light**: sun with a forward scattering phase, multiple scattering, two short self-shadow
   samples through the detail, sky light, warm low sun and the twilight colours of today's layer;
   at night, the flash light above.
4. **Composite** over the ground before the atmosphere and lightning, as today. The Earth shader
   darkens sunlight by the baked transmittance at the ground: cloud shadows.

**Tiers.** `high` and `medium` draw the volume; `low` keeps the flat layer. On phones the volume is
enabled only once a real phone holds the 33 ms frame interval with it; until then phones keep the
flat layer. The volume never pushes a pose over the ADR 0020 budgets.

**Observed, procedural, assumed, styled.** Top height and cloud cover: observed (infrared,
converted with the GFS profile; thin cirrus placed too low). Base and thickness: assumed. Detail,
translucency and the flash glow: styled, with the bounds above. Sun light and shadows: procedural.
Channel heights: assumed, bounded by the observed top. A development toggle shows the volume
without detail and tints what lies below the observed tops.

## Measurements

**Prototype**: a WebGL2 page with the bake, the march, the detail, the light and the composite
described above (no temporal accumulation yet), on real data of 2026-10-29 17 UTC over Brazil:
opacity tiles of levels 5 and 3, and tops from GOES-19 `ACHA2KMF` projected with the parallax
correction (median 10 km on opaque texels, standing in for the profile heights). Ground from the
4k Earth texture. Chromium headed on Metal on the reference Mac, GPU synchronized each frame, two
runs; other GPU work on the machine adds noise. Poses as in
[immersive view](../immersive-view.md#poses) (`horizon` is the horizon view).

| March, desktop 3840 × 2160 buffer, at 960 × 540 | `iss` | `window` | `horizon` |
|---|---|---|---|
| Columns only | 0.5 ms | 1.3 to 1.6 ms | 1.4 to 1.7 ms |
| With detail | 1.4 to 1.6 ms | 3.4 to 3.5 ms | 2.4 to 2.5 ms |
| With detail and self-shadow | 1.8 to 1.9 ms | 5.0 to 5.1 ms | 3.2 ms |
| Same, phone emulation, march 197 × 426 | 0.4 ms | 1.3 to 1.4 ms | 1.1 to 1.2 ms |
| Samples per pixel, desktop | 17 | 47 | 38 |

At night with four flashes, `window`: 3.9 ms. Sun bake, two windows of 512²: 0.5 to 0.9 ms (256²:
0.1 to 0.3 ms). Upsampling and compositing: 0.3 to 0.5 ms. Marching at full resolution costs 3 to
4 times more than at half the CSS size and is excluded. With a quarter of the pixels per frame,
the worst pose comes to about 1.3 ms of march, about 2 ms with the bake and the composite: the
estimate the implementation must confirm with `bench.mjs`.

**Bounds**: at `iss`, opacity averaged over 3.8 km blocks moves by 0.09 on average with the detail,
−0.04 overall (0.12 and −0.08 at the phone's coarser sampling).

**Height plane size**: tops derived from the opacity tiles weigh 40 to 67 % of the tile they come
from. Levels 3 and 4 hold 14.8 MB of the 35 MB pack of that hour: heights add about 8 MB per hour
(+25 %). Measured on real heights before the client work.

Captures (prototype, ground blurred by the 4k texture, grain from the missing temporal
accumulation): [`immersive/relief/prototype.jpg`](../immersive/relief/prototype.jpg), with the
columns alone, with the detail, a low sun at the horizon and four flashes at night.

## Consequences

- Desktop cost: about 2 ms with temporal accumulation, against `window` at 9.6 ms today: the pass
  holds its share by lowering its resolution, and the budget is checked before merge.
- Phones: up to 1.4 ms of march in emulation before accumulation; a phone GPU is several times
  slower than the reference Mac, hence the real phone gate.
- GPU memory: heights in their own array (16 layers on desktop, 8 on phones), the noise (1 MB),
  the baked windows, the march and history targets: about +24 MB desktop (about 356 of 384) and
  +8 MB on phones (about 252 of 256, tight).
- Transfer: first load unchanged; zooming to the floor adds a few height tiles, about 0.1 to
  0.3 MB.
- R2: pack about +25 %, detail storage about +0.2 GB at one day kept, writes and the number of
  objects unchanged. VPS: +35 MB of GFS per hour if the profile wins, and the height computation on
  level 4 (estimated +5 to 10 % of render time, measured).
- Near the floor, much of the image is assumed (walls, bases) or styled (texture, transparency,
  glow): the methodology says so, with the bounds. Thin cirrus sit too low; warm low clouds stay
  faint, as with today's opacity.
- Translucent storms show their flashes but also let city lights through anvils at night: the cap
  is tuned on captures, within the opacity bound.
- The reference storms' packs predate the heights and their detail has expired: before and after
  captures render the five reference hours again locally with the new pipeline, as #131 did.
- Offline rendering (`/render`) keeps the flat layer until it loads detail tiles.
- Delivery in two PRs under #312: ingestion first (heights, pack, validation against `ACHA2KMF`),
  so production carries heights before the client needs them; then the client, after #331, #332,
  #333, #341 and #346.
