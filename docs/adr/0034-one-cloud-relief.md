# 0034 · One cloud relief from the globe to the floor

- Status: proposed
- Date: 2026-11-05
- Replaces the far relief light, the deck light, the march's own relief, the warm sun and the haze
  above the tops of [ADR 0031](0031-cloud-look.md); amends visual rule 12 of
  [immersive view](../immersive-view.md#visual-rules) and the reading of
  [ADR 0030](0030-bounded-aesthetic-license.md) rule 2 for cloud edges

## Context

Maintainer QA of 2026-11-05 (#427): no relief on arrival, relief appearing around mid zoom, then
over the last part of the zoom the clouds turn from blue-white to a burnt yellow-white, the relief
changes or vanishes, and close views are blurry. The intermediate relief invents large shapes on
wide decks, though its fine detail reads well. Wanted: one relief, the same from the first view to
the closest, or none at all.

Three lights took turns with the camera's height: the flat layer, unshaded, above about 7,700 km;
the far relief light (slopes 6 to 12× steeper, sun lowered to 40°, hollows up to 27 % darker, a deck
light on large decks at noon) down to 1,200 km, with the volume replacing the flat layer between
2,800 and 1,800 km; the volume's own light below, with a warmer sun, a brighter low sun (up to
2.2×) and the atmosphere's haze kept to the air above the tops. Measured on 13-height zoom series
(cloud pixels, CIELAB): in the late afternoon the clouds jumped from L* 80 to 90 and b* −9 to −2.6
at 1,800 km; at noon b* went from −15 to −11; the relief band (3 to 12 pixels) halved below
1,300 km.

## Options

- **Tune the hand-overs between the three lights.** Each keeps its own look; the steps move.
- **Relief in 2.5D everywhere** (flat layer shaded at full resolution, no volume). Homogeneous by
  construction, sharp and cheaper, but no walls or parallax at tilted poses.
- **One light at every height on the current renderer** (chosen). The full-resolution relief light
  carries the shape from the whole globe to the floor; the volume keeps the light through the
  columns, its walls and the sky each top sees; one colour and one haze for both layers.
- **No relief** (the maintainer's fallback if the steps remained).

## Decision

1. **Relief light at every height.** Baked in every window, now six (1, 2, 4, 8, 16 and a new
   32 km), from the dense tops spread over 1.5 texels; read at full resolution from the window whose
   texel spans about 3.4 screen pixels, so broad shapes are 10 to 40 pixels across at every height.
   Slopes are drawn 3 × texelKm^0.25 times steeper (3 in the 1 km window, 7 in the 32 km one),
   lit by the sun at most 45° high, on every dense cloud; no hollows, no deck light. The march no
   longer lights the styled slopes itself (relief term, noon incidence, deck light): the shape has
   one light.
2. **One colour.** The volume's sunlit tops take the flat layer's white (0.93, 0.94, 0.96), warm
   only near the terminator, and dim with the sun as √(sin elevation), as the flat layer does, with
   the noon exposure of ADR 0031 on top. The atmosphere hazes the volume as it hazes the flat layer.
3. **Heights at every distance.** The height cache keeps loading level 3 however far the view (about
   64 tiles over the visible disk, 0.9 MB per hourly frame), in 80 layers instead of 24.
4. **Sharper cover close up.** The 1 and 2 km windows sharpen the cover against its ring of
   neighbours (unsharp mask, weight 1): crisper small clouds and edges, the same mean cover.
5. **Rule 12** becomes: *Magnification never sharpens, except cloud edges within the bounds of
   ADR 0030 rule 2 (ADR 0034).*

Styled, with their bounds: the relief light (shading only, slopes 3 to 7× steeper, sun at most
45°); the sharpened cover (ADR 0030 rule 2, 4 km blocks). Heights are not exaggerated.

## Measurements

Local build, replay of 2026-11-05 (Maniema, DR Congo), 1600 × 1000, `high`, Chromium headless on
the reference Mac, frames mirrored from R2. Cloud pixels, before → after:

| Height | Late afternoon L* | Late afternoon b* | Noon b* | Late afternoon relief band (%) |
|---|---|---|---|---|
| 20,000 km | 76.8 → 76.9 | −14.7 → −15.0 | −15.6 → −15.8 | 2.13 → 2.12 |
| 4,500 km | 77.4 → 76.9 | −11.1 → −11.0 | −16.2 → −15.5 | 0.89 → 0.53 |
| 2,400 km | 79.9 → 75.7 | −9.1 → −12.0 | −15.3 → −14.9 | 0.78 → 0.60 |
| 1,800 km | 90.6 → 75.3 | −2.6 → −13.0 | −11.8 → −14.8 | 0.69 → 0.71 |
| 1,000 km | 91.2 → 73.0 | −2.2 → −13.7 | −10.5 → −14.4 | 0.46 → 0.75 |
| 400 km | 91.3 → 72.6 | −1.9 → −14.3 | −12.6 → −15.4 | 0.39 → 0.52 |

From 20,000 to 400 km, L* now stays within 72.4 to 76.9 in the late afternoon (was 76.4 to 91.4) and
b* within −14.4 to −16.2 at noon (was −10.5 to −16.4). The relief band no longer drops at 1,800 km;
from 6,000 to 2,400 km it is 0.5 to 0.6 instead of 0.8 to 0.9, the price of the lower exaggeration
on wide decks. Edge sharpness (95th percentile of the gradient at cloud edges) at noon: +19 to +28 %
from 1,300 to 400 km.

Style bounds (`cloudVolume.styleCheck()`, finest window, noon and late afternoon at 1,200 and
400 km): mean cover difference 0.0032 to 0.0061 (bound 0.05), worst 4 km block 0.054 to 0.093
(bound 0.1; it was 0.098 to 0.112 before in the late afternoon), saturated tops within 0.95 km.

Frame cost, GPU synchronised, main against this record in alternated rounds: see the PR.

GPU memory: about +23 MB for the 56 more height layers and +5 MB for the 32 km window.

## Consequences

- The relief, its colour and its sharpness no longer change at 7,700, 2,800 to 1,800 or 1,200 km.
- Wide decks lose the large invented lumps; towers keep their walls and shadows from the march.
- From afar, about 0.9 MB more per hourly frame on desktop; phones keep the flat layer.
- High tops at a low sun are no longer whiter than the flat layer around them: the haze above the
  tops and the warm sun of ADR 0031 are gone for one colour at every height.
- Close views stay bounded by the ~1 km data: the cover is sharpened, not made up. Finer data is
  explored in #428.
