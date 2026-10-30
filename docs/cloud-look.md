# Cloud look: analysis and validation

Companion to [ADR 0031](adr/0031-cloud-look.md): why the relief clouds of ADR 0028 looked broken,
what replaced them, how the result was checked against observations, and what remains. The rules
themselves live in the ADR and in [immersive view](immersive-view.md#clouds-in-relief).

## Diagnosis

Four independent defects, plus one data gap, measured on the reported capture (storm follow,
Kampene, 2026-10-27 08:50 UTC) and on live frames of 2026-10-29.

| Symptom | Cause | Fix |
|---|---|---|
| Repeating grid | One 64³ Perlin-Worley tile, period 22 km, axis-aligned in Earth-frame km. The capture's autocorrelation peaks on a 49 × 22 km lattice | Hashed gradient noise without period, only where the observed neighbourhood calls for it |
| Cotton grain | Noise cells of 0.25 to 5.5 km under 1 km pixels, no filtering by footprint | Octaves finer than 2.5 window texels dropped |
| Hatching, even without noise | March started at a jittered offset with steps up to 16 km near the vertical, so tops were skipped at random | Closed-form integration of each column crossing, low-discrepancy jitter averaged by the history |
| Grey anvils | Sunlight baked at 0, 4, 8 and 12 km only; 13 to 16 km tops read the 12 km value | Sun baked at the ground and at each column's own top |
| Relief on Kampene | Detail tiles and heights had expired (kept 24 h): the noise invented every shape | No height, no volume: the flat layer shows, pixel by pixel |

## Before and after

Same live scene, same moment, old renderer on the left, new on the right (2026-10-29 around
22:40 UTC, Chromium on the reference Mac).

Kampene, the reported view. The frame has no heights any more, so the flat layer shows, sharp and
without invented relief:
![Kampene](immersive/cloud-look/kampene.jpg)

Pacific at noon, `window` pose: frosted cotton and grey lakes, then white clouds in relief with the
blue haze toward the horizon:
![Pacific window](immersive/cloud-look/pacific-window.jpg)

Pacific at noon, `iss` pose: uniform grain and plastic edges, then smooth plateaus and fibrous edges
drawn from the visible channel:
![Pacific iss](immersive/cloud-look/pacific-iss.jpg)

Vaupés storm (Colombia) at dusk, storm follow: dark mush, then peach-lit towers casting long shadows
on lower clouds:
![Vaupés follow](immersive/cloud-look/vaupes-follow.jpg)

Vaupés, `window` pose:
![Vaupés window](immersive/cloud-look/vaupes-window.jpg)

New renderer only. Left, an anvil plateau with flashes visible on and through it, isolated cumulus
and their shadows. Right, Central Africa at night: the flash lights the cloud around it and leaves
no trail on the next frame:
![Anvil and night](immersive/cloud-look/anvil-night.jpg)

## Against ISS photographs

Two NASA astronaut photographs in conditions close to the captures (public domain, NASA Earth
Observatory and Gateway to Astronaut Photography).

Northeast Brazil at sunset (ISS060-E-71360, "Long, Tall Shadows") against the Vaupés follow view.
Same physics: pink tops, long cast shadows. Our shadows still show 1 km steps:
![ISS long shadows](immersive/cloud-look/iss-long-shadows.jpg)

West Africa, 2015-07-16 (anvil, towers and a field of small cumulus) against an anvil `window` view.
The smooth bright plateau and shadowed cumulus match; the dense field of small cumulus is missing,
because the infrared barely sees warm low clouds:
![ISS anvil](immersive/cloud-look/iss-anvil.jpg)

## Against the written brief

The maintainer's brief describes ten genera seen from space and the light of a low and a high sun.

| Brief | Render | Match |
|---|---|---|
| Anvil: a fan, a large irregular palette | Smooth plateaus at observed tops, radiating streaks on the margins | Yes |
| A dome rises above the anvil and casts a small shadow | Domes on tops above their 8 km ring, computed shadows | Yes |
| A low sun reveals every bump with stretched shadows | Stronger relief at a grazing sun, long cast shadows | Yes |
| Ivory, peach or pink, blue-grey hollows | Sun reddened by the air under each height, blue-grey sky ambient | Yes |
| A high sun flattens shadows, surfaces look almost flat | Relief softened at noon, plain whites | Yes |
| Cirrus: filaments, wisps, nearly invisible | Thin veil on semi-transparent edges, fibres along iso-lines | Partly |
| Cumulus: islands of relief, shadow beside them | Relief and ground shadow where the infrared sees them | Partly |
| Stratocumulus: closed and open cells | No invented cells: too warm for the infrared | No |
| Repeating, mechanical motif (what to avoid) | No periodic texture anywhere | Avoided |

## Bounds and cost

Style bounds (ADR 0030 rule 2) hold at five places, read back from the shader with
`cloudVolume.styleCheck()`: mean cover difference at most 0.0013 (bound 0.05), worst 4 km block
0.064 (bound 0.1), saturated tops within 0.94 km (bound 1 km). Frame cost on the reference Mac stays
at the old renderer's level (−2.3 to +1.1 ms by pose). Tables in
[ADR 0031](adr/0031-cloud-look.md#measurements).

No new R2 object or byte: the renderer uses the tiles already published.

## Hover cloud type: evaluation

Not implemented. Hovering a cloud to outline it and show its type, size and area is feasible at no
R2 cost wherever heights exist: live and over the last 24 hours everywhere, and for 30 days under
the ten strongest storms of each day.

- **Pipeline**: a class map baked on the GPU with the style pass, read back once per satellite frame
  or window move (1 MB), connected components in a worker (about 6 ms measured on a 512² window),
  the object under the pointer found by a ray to the top, not the ground. Nothing per frame.
- **Labels**: cumulonimbus only when flashes are observed (WMO rule), "probable" otherwise; anvil,
  overshooting tops (Bedka 2010 test), high cloud of the cirrus family, mid-level cloud, low cloud
  field by day. The JMA satellite classes (Ci, Cm, St, Sc, Cu, Cg, Cb) name genera "for
  convenience"; finer genera (altostratus, cirrocumulus) are never shown alone.
- **Figures**: area (`R² Δλ (sin φN − sin φS)` per texel), equivalent diameter, top range, number
  of overshooting tops, flashes per minute, change over the last hour.
- **Outline**: a thin interface line on hover, like the storm outline, never drawn into the clouds
  (ADR 0030 rule 4). A tap on phones.
- **Effort**: about four days. Start with storm anatomy (cumulonimbus, anvil, overshooting tops),
  reliable and striking; other families later with careful wording. A 30-day catalogue everywhere
  would need an hourly height image (about 0.1 to 0.15 GB over 30 days, estimated).

## Open points

- Frame cost on a mid-range laptop (Iris Xe, `medium`) and on a phone is estimated, not measured.
- The lift of semi-transparent anvil edges is assumed; validate against GOES `ACHA2KMF`.
- Warm low clouds stay faint; no stratocumulus cells.
- Shadows at a very low sun keep 1 km steps.
- Old replays without heights show the flat layer close up.
