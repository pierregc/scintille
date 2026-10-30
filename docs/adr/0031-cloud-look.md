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
(ADR 0028's 0.95, flashes stay hidden); **a knee** (chosen): as observed up to 0.5, eased to 0.8.

**Without heights**: invented slab (ADR 0028's); **the flat layer, pixel by pixel** (chosen).

## Decision

**Data.** Unchanged: the same tiles and pack. Where a texel has no observed height the volume draws
nothing and the flat layer shows instead (`cloudKnownAt`), with a soft edge at tile and window
borders.

**Bake**, per window (1, 2, 4, 8 km texels, 512²), when its inputs change (place, frames and blend,
tiles loaded, sun, styling) and once every 32 frames otherwise:

1. **Observations**: blended opacity, observed top, convective core, heights known.
2. **Style**, from the neighbourhood (8 km ring, local spread of the tops, cover gradient):

| Where | What | Bound |
|---|---|---|
| Inside opaque cloud | Compression noise of the 2 km tops smoothed (±0.4 km), a slow swell (≤ 0.15 to 0.3 km, 14 km) | Styled, tops within 1 km |
| Tops ≥ 0.3 to 1.2 km above their opaque ring, or rough (spread ≥ 0.35 km) | Billows (≤ 0.75 km, 4 km), lobes on mid-level convective cells (≤ 0.5 km, 3.5 km) | Styled, tops within 1 km |
| Thin high cloud, fraying anvil margins | Streaks of the cover along the iso-lines or across them, only where cover is partial (`0.45 · a · (1 − a)`) | Styled, cover bound |
| Daytime dips inside an opaque high system | 35 % of the dip kept as cover (at most twice the observed), a small depression, and a dome on its sunward side | Styled, cover and top bounds |
| Semi-transparent edges of a high system | Top lifted toward the plateau 3 to 18 km inward (local radiative centre, as in the ABI cloud-type algorithm), as a thin plate | Assumed: corrects the infrared's low bias; to validate against GOES `ACHA2KMF` |

Noise is hashed gradient noise in Earth-frame km: no texture, no period. Octaves finer than 2.5
window texels are dropped, so nothing aliases.

3. **Sun**: transmittance through the other columns at the ground and at each column's own top;
   skipped on the night side.

**March.** Half the CSS size (`high`, at most 48 crossings) or 0.4 (`medium`, 40); a quarter of the
pixels per frame, the rest reprojected at the depth the march returns. Clear air is crossed about
1.25 pixels of ground per step; a column crossing is integrated in one piece and cut every half
pixel of ground sideways. Sunlight falls with depth below the top in closed form,
`σ / (σ + k·descent) · (1 − e^−(σ + k·descent)·len)` per term, with three scattering octaves, a
relief term from the styled top's slope (smoothed over 2 km, strongest at a low sun, none on thin
cloud), sun-facing walls lit directly, and a sun reddened by the air under each height (high tops
stay white at a low sun, low cloud turns peach). Steps and rays take low-discrepancy offsets that a
history averages; the history shortens where cover changes or the camera moves. A tier downgrade
lowers the march resolution and crossings too.

**Transparency and brightness.** Drawn opacity straight down is the cover up to 0.5, then eased
linearly to 0.8 at full cover (`capOpacity`); the flat layer near the ground and the lightning veils
use the same knee where the volume knows heights. Brightness follows the real depth: a scattering
gain (2.3) makes thick clouds as white as observed photographs.

**Lightning.** No flash is moved, added or removed. The glow of flashes inside the clouds is kept
out of the history and added in the composite, so it rises and fades in real time. Channels are
veiled by the eased opacity of the volume where it draws the clouds, and placed under the drawn top
(styled and lifted), within 1 km of the observed top for opaque clouds.

**Haze.** The atmosphere hazes the clouds the volume draws by the air above their tops only
(`exp(−height / 8 km)` of the column), except toward the limb, where the line of sight runs long
through the air above them.

**Observed, procedural, assumed, styled.** Cover and top: observed. Base and thickness, lifted
edges, channel heights: assumed. Swell, billows, lobes, streaks, dip depressions and domes,
transparency knee: styled, within the bounds. Sunlight, shadows, relief shading, haze: procedural;
slopes exaggerated at most 1.6× in the lighting (heights are not exaggerated).

**Bounds** (ADR 0030 rule 2), measured on the shader with `cloudVolume.styleCheck()`, which reads
the finest window back before and after styling: cover averaged over 4 km blocks within 0.05 of the
observed on average and 0.1 per block; tops of saturated texels (cover ≥ 0.98) within 1 km. The
knee and the lift are reported apart, as `drawnBias` and `liftedShare` / `maxLiftKm`.

## Measurements

2026-10-29 around 22:30 UTC, live frames with heights, `iss` pose, Chromium headless on the
reference Mac.

| Place | 4 km blocks | Mean difference | Worst block | Saturated tops | Drawn bias (knee) | Lifted edges |
|---|---|---|---|---|---|---|
| Vaupés storm, Colombia | 14,149 | 0.0004 | 0.064 | 0.94 km | −0.17 | 6.2 %, up to 8.3 km |
| Pacific ITCZ | 16,384 | 0.0013 | 0.052 | 0.94 km | −0.11 | 6.4 %, up to 7.2 km |
| Hawaii | 15,359 | 0.0002 | 0.029 | 0.94 km | −0.06 | 0.5 %, up to 6.3 km |
| California | 16,366 | 0.0001 | 0.009 | 0.94 km | −0.18 | 0 %, up to 1.1 km |
| Brazil | 11,437 | 0.00004 | 0.031 | 0.94 km | −0.04 | 1.0 %, up to 5.9 km |

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
laptop). GPU memory: −1 MB (3D noise), +1 MB (raw window), +0.7 to 1 MB (depth target).

## Consequences

- No repeating motif anywhere: the only texture is hashed and follows the observed field.
- Old replays without heights show the flat layer close up: clean, without relief. Storms kept for
  30 days have heights from 2026-10-29 19 UTC on.
- Warm low clouds stay faint (an infrared limit): the low-cloud landscapes of the brief
  (stratocumulus cells, fair-weather cumulus fields) are not invented.
- The lift of semi-transparent edges moves tops by several km; it stays only if it beats the
  observed tops against GOES `ACHA2KMF` on the reference hours.
- City lights and the ground show through the densest clouds at 20 %.
- The neighbourhood measures can feed a cloud-type map for a hover label, at no R2 cost: evaluated
  separately.
- Phones keep the flat layer until a real phone is measured, as in ADR 0028.
