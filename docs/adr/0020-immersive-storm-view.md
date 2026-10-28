# 0020 · Immersive storm view: lightning sets the zoom, the zoom sets the detail

- Status: proposed
- Date: 2026-10-28

## Context

M5 dives from the globe into a storm and follows it (#125, #126, #131, #251 to #259). Each ticket
needs the same targets: how close the camera goes, how fine the ground and clouds must be there,
what may be exaggerated, and how much frame time, memory and transfer the scene may cost.

Lightning is the one input we cannot improve. GLM pixels are about 8 km, MTG LI pixels about
4.5 km, and a flash is located within about one pixel. Ground imagery and the cloud source can be
replaced; the lightning cannot. A storm is 50 to 700 km across, its cells 10 to 50 km.

The merged renderer lets the camera down to 15 km above the ground, while its Earth texture has
9.8 km texels (4k) and its clouds 8 km pixels (GMGSI). A first baseline at 100 and 250 km showed
nothing readable: one texel covered 40 to 170 screen pixels, so the ground and clouds were blocks
or blur, and the 4 times glow covered the view. Detail is missing well before the camera gets
that low: at 2 screen pixels per texel, the 4k Earth already shows its pixels below about
8,000 km, GMGSI clouds below about 3,500 km.

Audit of the renderer and the measured baseline: [immersive view](../immersive-view.md).

## Options

- **Free zoom with today's textures.** No work, but every view below a few thousand km shows
  pixels and the deepest views show only blur.
- **Zoom limited by today's textures.** Honest, but the floor would sit around 8,000 km, where a
  storm is a small cluster of points: no immersion.
- **Lightning sets the zoom floor, textures are raised to match it.** The camera stops where
  going lower would only magnify the lightning data; ground and clouds get fine enough that no
  texel is visible at that floor.

## Decision

Adopt the third option, specified in [immersive view](../immersive-view.md):

1. **Zoom floor: 400 km above the ground, the ISS altitude.** There, one screen pixel (1080 px
   tall view) covers 0.23 km and the view is about 450 km wide: a whole storm or its core fills
   the screen, an LI pixel is 19 px and a GLM pixel 34 px. Lower, the view only magnifies the
   flash locations and the image becomes procedural. The floor applies to the camera height in
   every mode: manual zoom, tilt, flights and storm framing.
2. **No visible pixels at the floor.** At the nearest visible point, a ground texel covers at
   most 2 screen pixels, a cloud texel at most 4 with smooth (bicubic) filtering. This gives:
   - ground (day, night lights, water mask): **500 m per texel**, the finest release of Blue
     Marble and Black Marble (today's assets use their 1.9 km and 3 km releases), loaded by
     visible level of detail; #125 verifies the sources before building (#251 to #253);
   - clouds: **about 1 km** (FCI infrared at 1 km where its feed allows, visible channels at 0.5
     to 1 km by day). Where only 2 km infrared exists (night outside FCI coverage), clouds are the
     softest layer at the floor: smoothed, never sharpened (#131).
   No source is resampled beyond its native resolution and no synthetic relief or noise is added.
3. **A storm view shows each flash only while it lives.** Opening or following a storm sets the
   afterglow to 0 whatever the globe setting: a flash appears at its observed time, flickers and
   fades within about a second, as an observer would see it. The 1 and 30 minute afterglows stay
   for the globe overview.
4. **Each flash plays in real time.** Its flicker lasts its observed duration in wall clock time,
   whatever the replay speed, with pulses timed like real strokes (tens of milliseconds apart, a
   few per flash, sharp rise, fast decay). Replay speed compresses the time between flashes, never
   a flash itself. The pulse pattern stays procedural: only the duration, energy and footprint are
   observed.
5. **The final immersive view comes after the detail.** The `iss` (looking down) and `window`
   (looking toward the horizon from 400 km) poses are measurement points. Tilt, framing and the
   grazing composition (#126) are chosen by the maintainer on captures made once #253 and #131
   deliver the new ground and clouds.
6. **Observed, procedural, assumed.** Time, position, footprint area, energy and duration are
   observed and keep their meaning at every pose. Channel paths, branches, the cloud to ground
   share and channel heights are procedural. Cloud top (12 km) and cloud shell (10 km) are
   assumptions. Methodology and debug tooling keep this split visible.
7. **Visual rules.** Distant flashes are luminous points; channels appear progressively; halos
   stay restrained; near the floor the glow stays within twice the observed footprint; exposure
   changes smoothly with altitude only. Numeric bounds are in the specification.
8. **Budgets.** On the reference Mac, at every pose with the storm view afterglow (0), and at
   `globe` with the 30 minute afterglow: frame cost p95 ≤ 10 ms without a tier drop, no frame
   over 50 ms in a flight, no more than 2 % near white pixels. GPU
   textures and buffers ≤ 384 MB desktop and 256 MB mobile; first load ≤ 10 MB desktop and 8 MB
   mobile; diving from `globe` to `iss` ≤ 12 MB desktop and 5 MB mobile. Every M5 PR touching the
   scene measures them with `web/scripts/bench.mjs` against the recorded baseline.

## Consequences

- #126 replaces the 15 km surface floor by a 400 km camera height, and the M3 storm framing
  minimum (300 km) by the same floor. Its grazing view becomes a look toward the horizon from that
  height, not a pass just above the cloud tops.
- #125 confirms the 500 m target and judges each option at the `iss` and `window` poses; #251 to
  #253 build and load levels down to 500 m, only where the view needs them.
- #131 targets 1 km clouds and compares them with GMGSI at `iss`. If 1 km is out of reach (feed
  or licence), 2 km is the accepted fallback and the floor views stay visibly softer at night.
- #254 sizes glows and channels for a floor at 400 km (points from orbit, channels readable at
  `regional`, glow within twice the footprint at `iss`), moves the flicker to wall clock time
  with stroke like timing, and forces the afterglow to 0 while a storm is open (#258 keeps it
  while following). Today a flash flickers in scene time: at the default 60× replay its 60 to
  600 ms flicker lasts 1 to 10 ms on screen, under one frame.
- The baseline at 400 km shows blurred clouds and ground at about 8 ms per frame: the cost
  leaves room for the new detail. The whiteout measured with the 30 minute afterglow (up to
  96 % near white at `iss`) no longer concerns storm views.
- Until #125 and #131 land, the views below a few thousand km keep showing pixels: the baseline
  records this as the starting point, not a target.
- Compressed Earth textures and one channel cloud frames (about 150 MB less GPU memory) are the
  cheapest way to make room for the new levels; mobile today exceeds its first load budget.
- The 30 day lifecycle on `archive/clouds/` removes the reference storms' clouds around
  2026-11-17. Keeping them needs a longer lifecycle or a protected copy, decided with #41.
- Desktop numbers come from one MacBook Pro; phone emulation only stands in for the smaller
  drawing buffer. A real phone is measured in #259.
