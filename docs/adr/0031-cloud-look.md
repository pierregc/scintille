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
screen centre rather than on the magnified foreground. A second review found broad decks still flat
at noon and asked for more relief there, even if more stylised. A third asked for all that relief to
read from farther away: it showed only below about 2,000 km. Above 2,800 km the flat layer has no
shading at all; between 1,800 and 2,800 km the crossfade halved the relief and thinned dense decks
(0.95 showed as 0.72 halfway); and the styled detail grows too fine for the march's pixels from
about 600 to 1,300 km.

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
sheet (all tried: crack lines, grey marbling and dimpled decks, the look the brief rejects); light
that shows the shape only where there is one: towers, overshooting tops, walls and creases, broad
anvils smooth as astronaut photographs at a high sun show them (shipped first, too flat on broad
decks for the maintainer); **that light, plus a stylised light on dense decks** (chosen): their
observed shape about 6 km across, smoothed so that no crease, texel or noise shows, lit by a lower
sun. Sampling that shape on rings instead of smoothing it drew polygons and ghosts; the same light on
every cloud stained small ones over land khaki.

**Relief from afar**: slopes read at the pixel's footprint and steepened in the march (ends at
2,800 km and stays before the highlight shoulder, which compresses it 3.5 to 7×); the volume raised to
about 5,500 km with 16 and 32 km windows (a quick try showed fine dimples and a hard seam where the
8 km window ends; about 3 to 4 ms more on an Iris Xe at regional views, estimated); **a far relief
light baked with the coarse windows and drawn at full resolution by the composite and the flat
layer** (chosen). Enlarging the styled billows for far views would invent shapes at a scale the tops
are observed at.

**Without heights**: invented slab (ADR 0028's); **the flat layer, pixel by pixel** (chosen).

## Decision

**Data.** Unchanged: the same tiles and pack. Where a texel has no observed height the volume draws
nothing and the flat layer shows instead (`cloudKnownAt`), with a soft edge at tile and window
borders.

**Bake**, per window (1, 2, 4 and 8 km texels for the march, 16 km for the far relief, 512²), when
its inputs change (place, frames and blend, tiles loaded, sun, styling) and once every 32 frames
otherwise. The 1 and 2 km windows centre on the
ground 40 % of the half-height below the screen centre, where oblique views magnify it, at most
400 km from the others' centre (the screen centre), so the windows stay nested. Field and
observations are kept in half floats: 8 bits stepped the tops by 78 m, which the light drew as
contour lines.

1. **Observations**: blended opacity, observed top, convective core, share of heights known. The
   4, 8 and 16 km windows hold the mean of each texel (2 × 2 to 4 × 4 taps of heights, 1 to 2 × 2
   of cover) instead of a point of finer tiles.
2. **Style**, from the neighbourhood (8 km ring, local spread of the tops, cover gradient):

| Where | What | Bound |
|---|---|---|
| Inside opaque cloud | Compression noise of the 2 km tops smoothed (±0.4 km), a slow swell (≤ 0.15 to 0.3 km, 14 km) | Styled, tops within 1 km |
| Tops ≥ 0.3 to 1.2 km above their opaque ring, or rough (spread ≥ 0.35 km) | Billows: rounded domes between soft creases (≤ 0.95 km, 4 and 8 km); lobes on mid-level convective cells (≤ 0.5 km, 3.5 km) | Styled, tops within 1 km |
| Thin high cloud, fraying anvil margins | Streaks of the cover along the iso-lines or across them, only where cover is partial (`0.45 · a · (1 − a)`) | Styled, cover bound |
| Dips inside an opaque high system under a low or mid sun (fading out from 30° to 53° of elevation; above, dips stay as observed) | 35 % of the dip kept as cover (at most twice the observed), a small depression, and a dome on its sunward side | Styled, cover and top bounds |
| Semi-transparent edges of a high system | Top lifted toward the plateau 3 to 18 km inward (local radiative centre, as in the ABI cloud-type algorithm), as a thin plate | Assumed: corrects the infrared's low bias; to validate against GOES `ACHA2KMF` |

Noise is hashed gradient noise in Earth-frame km: no texture, no period. Octaves finer than 2.5
window texels are dropped, so nothing aliases. The swell and the dips and domes stay in the 1 and
2 km windows: the coarser ones feed the far relief, which would magnify them.

3. **Sun**: transmittance through the other columns at the ground and at each column's own top,
   and, in the 1 and 2 km windows, the share of sky each dense top sees past its neighbours
   (8 directions, 1.5 to 12 km); skipped on the night side.
4. **Light of the broad shape**, in the 4, 8 and 16 km windows: dense tops (cover 0.4 to 0.8 and
   above) spread by Gaussians 1.5 and 4 texels wide (6 and 16 km in the 4 km window) in two
   separable passes, then one pass for three values:
   - the **deck light** (4 and 8 km windows): the narrow shape drawn 6× steeper (tilt at most 45°)
     and lit by the sun lowered to 40° of elevation (fading out within 9° of the zenith, where the
     sun has no direction), hollows below their wide surroundings up to 18 % darker. Only on large
     decks (dense over 45 to 80 % of the wide surroundings): isolated towers keep the light of their
     own slopes. It fades in from 20° to 49° of sun elevation, below which the real light shows
     relief; the finer windows read it from the 4 km window;
   - the **far relief light**: the same shape drawn 6 · √(texel / 4 km) times steeper (6, 8.5 and
     12), slopes under about 0.06 cored out, tilt at most 45°, lit by the sun at most 40° high with
     its response per unit slope held to that of the 40° light (a lower sun draws slopes down to
     0.35 of that), hollows up to 18 % darker (27 % within 9° of the zenith) and domes 6 % brighter;
     on large decks under a high sun and on every dense system under a low one, where heights are
     known;
   - the **sunlit share of each top** from the sun pass, smoothed over about a texel.

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
when looking along the sun, where shaded faces hide), creases keep up to 35 % less sunlight, the
deck light falls on each top, fading within about a kilometre below it (thin edges take their
deck's, so no line marks their border; its shaded side turns a little bluer, not grey), the sun is
neutral white and the exposure drops to 0.86 of the gain. A highlight shoulder (from 0.6, hue
kept) brings sunlit tops below white instead of clipping them; the flash glow is added after it. Steps and rays take low-discrepancy offsets that a
history averages; the history shortens where cover changes or the camera moves. A tier downgrade
lowers the march resolution and crossings too.

**Far relief.** The far relief light is read at full resolution from the window whose texel spans
about 3.4 CSS pixels (two windows blended), so its shapes are 10 to 40 pixels across while a pixel
covers up to about 4.7 km (they shrink toward the limb beyond). It is applied after the highlight shoulder and before the flash glow, at 0.7 of its
shading (0.5 left relief 13 % weaker at 2,000 km than the deck light it takes over from), the shade
a little bluer and the light filling only the headroom below white:
- by the composite on the volume, where a pixel covers 0.9 to 1.6 km and more; the march hands its
  deck light over by the same share, and under a low sun keeps its own light until pixels reach 1.1
  to 1.7 km;
- by the flat layer, with the shadows of taller clouds (direct light down to 15 %).

It comes in from 700 to 1,200 km of camera height, so close views keep the volume's own light
exactly, and fades out as a pixel at the screen centre grows from 4.1 to 4.85 km (6,500 to 7,700 km
straight down on a 1,000-pixel-tall view), before the height tiles stop loading at 4.9 km (the globe
stays flat). The 16 km window joins the march's bakes once the far relief comes in. Above the march
only the coarse windows it reads are baked: missing ones first, coarsest first, one per frame;
changed ones in turn, at most one every four frames; one anyway every 128 frames. A coarse window
moves only once the view has gone 32 of its texels, and the sun pass skips the ground there. Storm packs keep heights at
level 4 only: from afar the client loads those in place of the missing level 3, in 24 height layers
instead of 16. In the crossfade the flat layer is drawn over the volume's share `y` as
`a (1 − y) / (1 − y a)`, so a deck keeps its cover.

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
incidence of dense tops under a high sun. Deck light under a high sun: styled, on the observed broad
shape, slopes 6× steeper and the sun lowered to 40°. Far relief light: styled, shading only, on the
observed broad shape at the scale of the screen, slopes 6 to 12× steeper, the sun lowered to 40° or
its response held to that light. Shadows of taller clouds on the flat layer: procedural. Means of
the coarse windows: observed. Heights are not exaggerated.

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
paid only when a window is baked again. The deck light adds three passes when the 4 or 8 km window
is baked again (about 55 texture reads per texel, estimated at 0.4 ms each time on the reference
Mac from the measured sun bake) and up to two reads per lit crossing; on still noon views (`window`,
`iss`, storm follow, 1920 × 1080 at DPR 2, interleaved) the median frame moved by −0.5 to +0.3 ms,
within the noise. GPU memory: −1 MB (3D noise), +2 MB (raw window), +4 MB (field in half floats),
+0.7 to 1 MB (depth target), +3 MB (deck light and its spread tops).

Relief from afar, Pacific replay at noon (20:00 UTC), 1600 × 1000, `high`: RMS of the luminance
band-pass from 3 to 12 CSS pixels over dense cloud, relative to its mean (%):

| Camera | 1,274 km (orbit floor) | 2,000 km | 2,600 km | 3,500 km |
|---|---|---|---|---|
| Nadir, before | 7.3 | 7.4 | 2.8 | 3.3 |
| Nadir, after | 7.3 | 7.8 | 7.4 | 7.2 |
| 45° tilt, before | | 6.7 | 5.2 | 2.0 |
| 45° tilt, after | | 8.2 | 8.1 | 4.9 |

At 5,000 km the flat layer had no relief at all; it now shows the decks' broad shape. A zoom from
1,400 to 3,400 km shows no step at 1,800 or 2,800 km (relief between 6.9 and 8.4). The finest band
(1 to 3 pixels, where orange peel would show) stays between 1.7 and 2.1, against 1.2 to 1.9 before
(the previous volume had 1.9 at 2,000 km). `iss`, `window` and storm follow differ from the previous version by 0.1 to 0.3 grey
levels on average. Frame cost, GPU synchronised, 1920 × 1080 at DPR 2, far relief on against off
(interleaved): still views at 2,000, 3,500 and 5,000 km, median −0.5 to +0.5 ms (one run +1.7 ms at
2,000 km, +0.2 and +0.3 ms when repeated); panning at 3,500 and 5,000 km, −1.0 to +0.8 ms, p95
−1.1 to +0.8 ms; within the noise. Not measured on an Iris Xe: a far window bake is about 1.5 to
2 ms on the reference Mac (estimated), paid each time a window is baked again (it moves, a frame or
the blend changes, tiles arrive, the sun moves, or the refresh every 128 frames), at most once every
four frames. GPU memory: about +11 MB (16 km
field and sun layers, the light of the broad shape in RGBA half floats, 8 more height layers).

## Consequences

- No repeating motif anywhere: the only texture is hashed and follows the observed field.
- Old replays without heights show the flat layer close up: clean, without relief. Storms kept for
  30 days have heights from 2026-10-29 19 UTC on.
- Warm low clouds stay faint (an infrared limit): the low-cloud landscapes of the brief
  (stratocumulus cells, fair-weather cumulus fields) are not invented.
- The lift of semi-transparent edges moves tops by several km; it stays only if it beats the
  observed tops against GOES `ACHA2KMF` on the reference hours.
- City lights and the ground show through the densest clouds at 5 %, flashes at 20 %.
- Under a high sun broad decks show their observed shape in a lowered, stylised light: more relief
  than astronaut photographs show at that hour, by the maintainer's choice. It is shading only: the
  style bounds, cover and tops do not move.
- Relief reads from the orbit floor to about 6,500 km of camera height, as the observed broad shape
  at the scale of the screen; the fine styled relief (cells, billows, creases) still needs the
  floor, as the march's pixels limit it. Above 7,700 km the globe stays flat: no heights are loaded.
- Around the subsolar point, within 9° of the zenith, far relief at noon keeps its hollows and domes
  only, as the light has no direction there.
- The neighbourhood measures can feed a cloud-type map for a hover label, at no R2 cost: evaluated
  separately.
- Phones keep the flat layer until a real phone is measured, as in ADR 0028.
