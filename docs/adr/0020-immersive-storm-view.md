# 0020 · Immersive storm view: scale ladder, visual rules and budgets

- Status: proposed
- Date: 2026-10-28

## Context

M5 dives from the globe into a storm and follows it (#125, #126, #131, #251 to #259). Each ticket
needs the same targets: which views count, how kilometres become pixels, what may be exaggerated,
and how much frame time, memory and transfer the scene may cost. Without them, every PR invents its
own scale and nobody can tell a regression from a choice.

The merged renderer sets the starting point (audited in [immersive view](../immersive-view.md#current-renderer)):

- 1 world unit is the Earth radius (6,371 km); field of view 35°; the surface camera stops 15 km
  above the ground at a 20 km range.
- Earth textures are 2k/4k/8k global images (9.8 km per texel at 4k); clouds are 2k/4k GMGSI
  frames at about 8 km native resolution, on a smooth shell at 10 km.
- Flashes are glows lifted to 12 km, scaled to 4 times the observed radius, with a 5 px floor.
  Channels are procedural: 2.2 flash radii long with a 6 px floor, 25 % drawn as cloud to ground
  with heights exaggerated 2.5 times, halos up to 512 channels.
- GLM locates a flash within about 8 km, MTG LI within about 4.5 km. At 250 km range a GLM pixel
  covers about 55 screen pixels; at the 20 km floor it covers almost the whole screen.
- The baseline on five storms (MacBook Pro M4 Max, production data) is flat at about 8 ms per
  frame with the default afterglow. With the 30 minute afterglow, every view below the globe turns
  19 to 94 % white and costs up to 78 ms, and the quality tier falls to `low`. Daytime close views
  are one blurred cloud; city lights become blocks; Earth and cloud textures take 277 MB
  uncompressed; clouds are 70 to 80 % of a 6 to 9 MB first load.

## Options

- **Free zoom, tuned by eye per ticket.** No upfront work, but scale and cost drift between PRs
  and the five-storm validation (#259) has nothing to compare against.
- **Physically exact everything.** Honest, but distant flashes vanish (a 30 km glow is under 3 px
  from orbit) and close views expose 8 km data as large soft blocks.
- **A fixed scale ladder with declared compensations and measured budgets.** Four reference poses
  on five reference storms, physical scale by default, every visibility compensation named and
  bounded, and a repeatable benchmark that later tickets must pass.

## Decision

Adopt the third option, specified in [immersive view](../immersive-view.md):

1. **Reference set.** Five published storms (compact and large, day and night, land and ocean,
   tropics and mid latitudes, GLM and MTG LI) reopened by share URL, each at four poses: `globe`
   (20,000 km, nadir), `regional` (the M3 storm framing), `close` (250 km range, 55° tilt) and
   `deck` (100 km range, 72° tilt, the lowest pose).
2. **Scale.** Positions, footprints and heights are in kilometres through `kmToWorld`. Screen size
   is derived, never stored. Detail may be added only where a source provides it: surface imagery
   down to 500 m per texel (#125), clouds at their native resolution (#131), no synthetic terrain
   or cloud relief.
3. **Observed, procedural, assumed.** Time, position, footprint area, energy and duration are
   observed and keep their meaning at every pose. Channel paths, branches, the cloud to ground
   share and channel heights are procedural. Cloud top (12 km) and cloud shell (10 km) are
   assumptions. Methodology and debug tooling keep this split visible.
4. **Visual rules.** Distant flashes are luminous points; channels appear progressively once their
   physical length is readable; halos stay restrained; exposure changes smoothly with altitude and
   never from scene content; the camera keeps 25 km above the ground. Each rule has numeric bounds
   in the specification.
5. **Budgets.** On the reference Mac, at both afterglows and every pose: frame cost p95 ≤ 10 ms
   without a tier drop, no frame over 50 ms in a flight, no more than 2 % near white pixels.
   GPU textures and buffers ≤ 384 MB desktop and 256 MB mobile; first load ≤ 10 MB desktop and
   8 MB mobile; diving from globe to deck ≤ 12 MB desktop and 5 MB mobile. They apply to every M5
   PR touching the scene, measured with `web/scripts/bench.mjs` against the recorded baseline.

## Consequences

- #254 replaces the pixel floors with continuous functions of km per pixel, removes the 6 px
  channel floor at globe scale and brings the 30 minute afterglow within budget; #126 moves the
  surface floor from 15 to 25 km, keeps the storm track below the horizon and softens the deck
  horizon.
- Mobile today exceeds its first load budget (up to 9.2 MB): loading lighter clouds on phones, and
  compressed Earth and one channel cloud textures (about 150 MB less GPU memory), are the cheapest
  ways to make room for #252 and #131.
- #125, #251 to #253 and #131 report the four poses and the benchmark before and after their change;
  a PR over budget either fixes it or asks for an amended budget.
- The 30 day lifecycle on `archive/clouds/` removes the clouds of the reference storms after a
  month. Keeping them needs a longer lifecycle or a protected copy, decided with #41.
- Desktop numbers come from one MacBook Pro. Phone emulation on that Mac only stands in for the
  smaller drawing buffer; a real phone is measured in #259. Software rendering only checks that
  the benchmark runs.
- The procedural share of the image grows as the camera descends. The deck pose is a composition
  above the data, not a claim of finer observation.
