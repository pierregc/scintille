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
- GLM locates a flash within about 8 km, MTG LI within about 4.5 km. At 400 km range a GLM pixel
  covers about 35 screen pixels; at the 20 km floor it covers almost the whole screen.

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
5. **Budgets.** Desktop and mobile frame time, GPU memory, initial load and zoom transfer budgets in
   the specification apply to every M5 PR touching the scene, measured with `web/scripts/bench.mjs`
   on the declared devices against the baseline recorded with this ADR.

## Consequences

- #254 replaces the pixel floors with continuous functions of km per pixel and removes the 6 px
  channel floor at globe scale; #126 moves the surface floor from 15 to 25 km.
- #125, #251 to #253 and #131 report the four poses and the benchmark before and after their change;
  a PR over budget either fixes it or asks for an amended budget.
- The 30 day lifecycle on `archive/clouds/` removes the clouds of the reference storms after a
  month. Keeping them needs a longer lifecycle or a protected copy, decided with #41.
- Desktop numbers come from one MacBook Pro; mobile numbers need a real phone. Emulation and
  software rendering only check that the benchmark runs.
- The procedural share of the image grows as the camera descends. The deck pose is a composition
  above the data, not a claim of finer observation.
