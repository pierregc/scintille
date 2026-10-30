# 0031 · Cloud look: observed relief, sparse styling, exact light

- Status: proposed
- Date: 2026-10-29

This record replaces the styled detail, the transparency cap and the rendering of
[ADR 0028](0028-cloud-relief.md). Its top heights, height tiles, columns and tiers stay. ADR 0028
itself is not edited ([ADR 0017](0017-preserve-adr-history.md)).

## Context

The volume of ADR 0028 shipped on 2026-10-29. The maintainer found it "catastrophic": a cotton
grain over every cloud, repeating like a broken grid, diagonal hatching and grey anvils. They want
something lighter and cleaner, "a few stylised strokes here and there", no repeating motif, visible
thickness, clouds that read like the genera of a written brief of clouds seen from space, and
lightning visible inside them.

| Defect | Cause |
|---|---|
| Grid | One 64³ Perlin-Worley tile in Earth-frame km, period 22 km: a 49 × 22 km lattice on the ground at Kampene, matched by the capture's autocorrelation |
| Cotton grain | Cells of 0.25 to 5.5 km under 1 km march pixels, no mipmaps or fade by footprint, the same cells on every cloud, a 3× density boost breaking overcast decks into cells |
| Hatching, even with the noise off | The march started at `t0 + jitter · ds` with steps up to 16 km near the vertical, so the top was skipped at random; interleaved gradient noise on a stride-2 grid; a history averaging about two samples |
| Grey anvils ("frozen lakes") | Sunlight baked at 0, 4, 8 and 12 km only: tops at 13 to 16 km read the 12 km value, inside the cloud |
| Relief where nothing was measured | Frames without heights drawn as a 1 km slab at 10.5 km, shaped by the noise alone |

A first version of this record looked right at dawn and dusk but flat at noon, and softer than the
flat layer: sunlit tops came out brighter than white and clipped, a 0.8 cap let the sea show through
the densest decks, a slope barely changes the light of a high sun, and the 1 km window sat on the
screen centre rather than on the magnified foreground.

What the data gives the client:

- **Opacity and top height are one measurement.** Both come from the 10.4 µm brightness temperature
  at levels 3 and 4 (`smoothstep(4 K, 32 K, T_skin − BT)`, [ADR 0023](0023-composite-clouds.md)). A
  cirrus of emissivity 0.5 reads 0.99 and sits too low; warm low clouds read 0.03 to 0.2; every
  anvil reads 1. By day the 1 km level multiplies opacity by a visible ratio (0.5 to 1.6): texture,
  not cover. Cloud types can only be told from the neighbourhood, never per texel.
- **Heights** exist since 2026-10-29 19 UTC: every frame for 24 hours, then the ten strongest
  storms of each day for 30 days. Other frames have none.

Constraints: no new R2 object or byte (storage is near the free tier), the budgets of
[ADR 0020](0020-immersive-storm-view.md), mid-range laptops at the `medium` tier.

## Options

**Renderer**

- **Fix the volume in place**: rotated, mipmapped noise, blue-noise jitter, longer history. Keeps a
  3D noise eroding the observations at their own scale, and per-sample fetches.
- **Height-field march with closed-form columns** (chosen): each column crossing integrated in one
  piece, detail baked once per window in 2D from the observed neighbourhood.
- **Lit 2.5D shell** (relief mapping on the cloud sphere): cheapest, full resolution, but no walls
  at the `window` and horizon poses.

**Transparency**: a uniform scale (thin clouds lose too, breaks the ADR 0028 bound); a hard cap
(ADR 0028's 0.95, flashes stay hidden); one knee to 0.8 (grey, see-through decks under a high sun);
**a knee with a lighter veil over flashes** (chosen): as observed up to 0.5, eased to 0.95 for the
clouds and to 0.8 for the flashes under them.

**Relief under a high sun**: slopes drawn 4× steeper in that light, a larger swell, billows on every
sheet (all tried: crack lines, grey marbling and dimpled decks, the look the brief rejects);
**light that shows the shape where there is one** (chosen): towers, overshooting tops, walls and
creases, while broad anvils stay smooth, as astronaut photographs at a high sun show them.

**Without heights**: invented slab (ADR 0028's); **the flat layer, pixel by pixel** (chosen).

## Decision

**Data.** Unchanged: the same tiles and pack. Where a texel has no observed height the volume draws
nothing and the flat layer shows instead (`cloudKnownAt`), with a soft edge at tile and window
borders.

**Bake**, per window (1, 2, 4, 8 km texels, 512²), when its inputs change (place, frames and blend,
tiles loaded, sun, styling) and once every 32 frames otherwise. The 1 and 2 km windows centre on the
ground 40 % of the half-height below the screen centre, where oblique views magnify it, at most
400 km from the others' centre (the screen centre), so the windows stay nested. Field and
observations are kept in half floats: 8 bits stepped the tops by 78 m, which the light drew as
contour lines.

1. **Observations**: blended opacity, observed top, convective core, heights known.
2. **Style**, from the neighbourhood (8 km ring, local spread of the tops, cover gradient):

| Where | What | Bound |
|---|---|---|
| Inside opaque cloud | Compression noise of the 2 km tops smoothed (±0.4 km), a slow swell (≤ 0.15 to 0.3 km, 14 km) | Styled, tops within 1 km |
| Tops ≥ 0.3 to 1.2 km above their opaque ring, or rough (spread ≥ 0.35 km) | Billows: rounded domes between soft creases (≤ 0.95 km, 4 and 8 km); lobes on mid-level convective cells (≤ 0.5 km, 3.5 km) | Styled, tops within 1 km |
| Thin high cloud, fraying anvil margins | Streaks of the cover along the iso-lines or across them, only where cover is partial (`0.45 · a · (1 − a)`) | Styled, cover bound |
| Dips inside an opaque high system under a low or mid sun (fading out from 30° to 53° of elevation; above, dips stay as observed) | 35 % of the dip kept as cover (at most twice the observed), a small depression, and a dome on its sunward side | Styled, cover and top bounds |
| Semi-transparent edges of a high system | Top lifted toward the plateau 3 to 18 km inward (local radiative centre, as in the ABI cloud-type algorithm), as a thin plate | Assumed: corrects the infrared's low bias; to validate against GOES `ACHA2KMF` |

Noise is hashed gradient noise in Earth-frame km: no texture, no period. Octaves finer than 2.5
window texels are dropped, so nothing aliases.

3. **Sun**: transmittance through the other columns at the ground and at each column's own top,
   and, in the 1 and 2 km windows, the share of sky each dense top sees past its neighbours
   (8 directions, 1.5 to 12 km); skipped on the night side.

**March.** Half the CSS size (`high`, at most 48 crossings) or 0.4 (`medium`, 40); a quarter of the
pixels per frame, the rest reprojected at the depth the march returns. Clear air is crossed about
1.25 pixels of ground per step; a column crossing is integrated in one piece and cut every half
pixel of ground sideways. Sunlight falls with depth below the top in closed form,
`σ / (σ + k·descent) · (1 − e^−(σ + k·descent)·len)` per term, with three scattering octaves, a
relief term from the styled top's slope (over 2 km, strongest at a low sun, none on thin cloud),
sun-facing walls lit directly at their own incidence (grey under a high sun), and a sun reddened by
the air under each height (high tops stay white at a low sun, low cloud turns peach). Sunlight meets
the extinction of the 0.8 veil, so light and shadows reach as deep whatever opacity is drawn. Under
a high sun, dense tops take the incidence of their slope over 3 km drawn 1.5× steeper again (faded
when looking along the sun, where shaded faces hide), creases keep up to 35 % less sunlight, the sun
is neutral white and the exposure drops to 0.86 of the gain. A highlight shoulder (from 0.6, hue
kept) brings sunlit tops below white instead of clipping them; the flash glow is added after it. Steps and rays take low-discrepancy offsets that a
history averages; the history shortens where cover changes or the camera moves. A tier downgrade
lowers the march resolution and crossings too.

**Transparency and brightness.** Drawn opacity straight down is the cover up to 0.5, then eased
linearly to 0.95 at full cover (`capOpacity`), which the flat layer near the ground follows where the
volume knows heights. Flashes there are veiled by the same knee eased to 0.8 only (`veilOpacity`),
so they show through the densest clouds. Brightness follows the real depth: a scattering gain (2,
0.86 of it under a high sun) makes thick clouds as white as observed photographs.

**Lightning.** No flash is moved, added or removed. The glow of flashes inside the clouds is kept
out of the history and added in the composite, so it rises and fades in real time. Channels are
veiled by the lighter veil (eased to 0.8) where the volume draws the clouds, and placed under the drawn top
(styled and lifted), within 1 km of the observed top for opaque clouds.

**Haze.** The atmosphere hazes the clouds the volume draws by the air above their tops only
(`exp(−height / 8 km)` of the column), except toward the limb, where the line of sight runs long
through the air above them.

**Observed, procedural, assumed, styled.** Cover and top: observed. Base and thickness, lifted
edges, channel heights: assumed. Swell, billows, lobes, streaks, dip depressions and domes,
transparency knee and the lighter veil over flashes: styled, within the bounds. Sunlight, shadows,
relief shading, creases, haze: procedural; slopes exaggerated 1.6× in the lighting, 2.4× in the
incidence of dense tops under a high sun (heights are not exaggerated).

**Bounds** (ADR 0030 rule 2), measured on the shader with `cloudVolume.styleCheck()`, which reads
the finest window back in full precision before and after styling: cover averaged over 4 km blocks within 0.05 of the
observed on average and 0.1 per block; tops of saturated texels (cover ≥ 0.98) within 1 km. The
knee and the lift are reported apart, as `drawnBias` and `liftedShare` / `maxLiftKm`.

## Measurements

Replays of 2026-10-29 and a live frame of 2026-10-30, `iss` pose, Chromium headless on the
reference Mac, read back in full precision.

| Place | 4 km blocks | Mean difference | Worst block | Saturated tops | Drawn bias (knee) | Lifted edges |
|---|---|---|---|---|---|---|
| Pacific ITCZ, noon (20:00 UTC) | 16,384 | 0.00004 | 0.033 | 0.95 km | −0.03 | 2.0 %, up to 5.5 km |
| Off Central America, noon (19:30 UTC) | 16,384 | 0.0001 | 0.042 | 0.95 km | −0.02 | 1.9 %, up to 5.5 km |
| Pacific, mid-sun (23:20 UTC) | 16,384 | 0.0013 | 0.060 | 0.83 km | −0.03 | 0.9 %, up to 4.3 km |
| Colombia, dusk (22:15 UTC) | 15,648 | 0.0007 | 0.073 | 0.87 km | −0.04 | 8.0 %, up to 5.6 km |
| Central Africa, noon, live | 16,354 | 0.00003 | 0.008 | 0.85 km | −0.04 | 0.3 %, up to 3.8 km |

Frame cost, GPU synchronised, 1920 × 1080 at DPR 2, same live scene back to back (noise about
±1 ms between runs):

| Scene | ADR 0028 volume | This record |
|---|---|---|
| `window`, Pacific, noon | 9.1 ms | 9.7 ms |
| `iss`, Pacific, noon | 10.6 ms | 8.3 ms |
| Storm follow, Colombia, dusk | 10.6 ms | 8.9 ms |
| `window`, Central Africa, night, flashes | 9.6 ms | 10.7 ms |

Per-pass timings on the reference Mac (synthetic storm field, blended copies) put the new passes at
or below ADR 0028's once the flat layer steps aside where the volume draws, the sun bake and the
march skip the night side and the streaks run only where they show: scaled by 6 to 7, about 6 to
7 ms by day and 4.5 to 5 ms at night on an Iris Xe at `medium` (estimated, to be measured on a real
laptop). The midday changes keep that cost: in interleaved runs on the same replays (noon `window`
and `iss`, dusk follow, 1920 × 1080 at DPR 2) the median frame moved by −1.0 to 0 ms against the
first version. The sky seen by each top costs about 0.3 ms per re-baked window on the reference Mac,
paid only when a window is baked again. GPU memory: −1 MB (3D noise), +2 MB (raw window), +4 MB
(field in half floats), +0.7 to 1 MB (depth target).

## Consequences

- No repeating motif anywhere: the only texture is hashed and follows the observed field.
- Old replays without heights show the flat layer close up: clean, without relief. Storms kept for
  30 days have heights from 2026-10-29 19 UTC on.
- Warm low clouds stay faint (an infrared limit): the low-cloud landscapes of the brief
  (stratocumulus cells, fair-weather cumulus fields) are not invented.
- The lift of semi-transparent edges moves tops by several km; it stays only if it beats the
  observed tops against GOES `ACHA2KMF` on the reference hours.
- City lights and the ground show through the densest clouds at 5 %, flashes at 20 %.
- Broad anvils stay smooth under a high sun, as photographed; the relief of noon shows on towers,
  overshooting tops, walls and creases.
- The neighbourhood measures can feed a cloud-type map for a hover label, at no R2 cost: evaluated
  separately.
- Phones keep the flat layer until a real phone is measured, as in ADR 0028.
