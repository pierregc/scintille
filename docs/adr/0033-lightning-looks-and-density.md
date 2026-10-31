# 0033 · Lightning looks and a density budget by replay speed

- Status: proposed
- Date: 2026-10-31
- Supersedes [0013 · 3D lightning ribbons](0013-bis-3d-lightning-ribbons.md); amends visual rules 6,
  7 and 11 of [ADR 0020](0020-immersive-storm-view.md)

## Context

The satellites see light on cloud tops from above. For each flash they observe its time, position,
footprint area, optical energy and duration ([data contract](../data-contract.md)); no channel, no
cloud-to-ground or in-cloud class, no height. [ADR 0030](0030-bounded-aesthetic-license.md) lets the
renderer style what nothing observes, within named bounds, and never move, add or remove a flash.

The renderer at `b1b35cf` draws every flash the same way up to one boolean: `isGround`, 25 % of the
seeds, decides the channel look, the stroke pattern, the light drift, the glow dips and the halo. In a
storm view the 500 newest flashes stay on screen and older ones fade within 150 ms of wall time.
Measured on the storm of the week (Basse-Kotto, 2026-10-27, level 5, 600 flashes a minute at the
peak) and on two night storms, before this set of changes:

- 0.4 % of the channel length on screen is steeper than 60° at the default frame: in-cloud leaders are
  flattened to 8-11.5 km, two thirds of a ground drop lies under the 7 km base where the veil keeps
  4 % of its light, the 20° framing tilt shows 34 % of any vertical, and the ground leader reaches the
  ground within one frame.
- The 500-newest cap does not thin a storm at speed, it shortens every flash: to 83 ms of light at
  600× and 14 ms at 3600×, while the fade puts 900 to 5,400 more flashes back on screen at partial
  light. Near-white pixels reach 2-28 % at 600× and 9-36 % at 3600× at night against the 2 % budget of
  ADR 0020.
- The round glow (40 % near the floor) screen-blended hundreds of times and a structureless disc of
  cloud light per flash build one bright blob over the cell.

The maintainer's brief names six problems: thirty minutes of nothing at the start of a replay;
channels too horizontal; not enough variety; a "ball of lightning" at 60×, a "lit Christmas tree" at
600×, "a light bulb that moves" at 3600×; too many flashes at speed, with 600× and 3600× still to be
told apart; and a mood to reach, ambient and photographic, blue-white, never neon, "a window, not a
control room", with real lightning as the reference.

Two facts from the literature frame the answer (the research notes of the rework). Perception: even
at 600 flashes a minute, fewer than six flashes are lit at once in real time, and the eye follows
three to eight objects. Population: in-cloud flashes are 60 to 85 % of a storm's flashes; what a camera
on the ground resolves is the cloud-to-ground channel below the base, so what is drawn as a channel is
not the flash population.

## Options

- **Keep the boolean and the cap, tune the constants.** Cheap. The channels stay flat, the cap keeps
  cutting flashes into stubs, and the variety stays one of seed noise.
- **Seven procedural looks with literature-bounded shares, and a deterministic, energy-weighted
  budget of flashes drawn in full per replay speed, every flash kept in the cloud light.** Honest with
  ADR 0030; two contracts to maintain in TypeScript and GLSL twins.
- **A field drawn with a soft fade and a handful of heroes (30 / 12 / 5).** The best mood, but most
  flashes lose their observed duration and their real-time flicker (ADR 0020 rule 4).
- **Age colouring or time binning, as the EUMETSAT viewers do.** Honest and legible, but a control
  room.

## Decision

The second option, in two layers that never compete.

**The field.** Every flash, at every replay speed, lights the cloud at its observed time, position,
footprint, energy and duration, with its real-time profile and light drift, uncapped in storm views.
The 500-newest cap binds only when every flash is drawn in full.

**The heroes.** Channels, the near-floor sprite, the halo and the sound are drawn for a sample:
`lot = channelHash(seed, 3) × mix(1.0, 0.4, intensity) < share`, so the strongest flash is up to 2.5×
likelier than the weakest; `share = target / (1.5 × alive)` with `alive` the flashes played in the
last 0.4 s of wall time; `target` 50 / 20 / 8 flashes within their flicker at once at 60× / 600× /
3600×, all of them at 1×, in a named band of 30-100 / 12-30 / 5-12; smoothed with a 2 s time constant
and set at once on a seek or a speed change, so a revisit or a shared link shows the same heroes.
Unselected flashes keep a point from afar and a half sprite where the cloud light has no surface, so
every flash stays a point (ADR 0020 rule 1). The HUD rate stays the data rate; no caption.

**Seven looks**, drawn from `u = channelHash(seed, 2)` and the observed duration and area:

| Kind | Share | Geometry (km above ground, r = observed radius) | Timing (wall clock, within the observed duration) |
|---|---|---|---|
| Negative cloud-to-ground, multi-stroke | 19 % | origin 6-8 km over 0.5 r, feed 0.3-0.8 r, drop within 30° of vertical (80 %) or 30-45°, strike 2-8 km away inside r, 3-12 branches below 5 km on both sides, a second contact in 40 % | leader 1 × 10^5 m/s (52-95 ms for 7 km, ≤ 150 ms), 2-12 strokes 10-400 ms apart, continuing current in 40 % |
| Negative cloud-to-ground, single-stroke | 7 % | as above, 1-3 branches | one stroke, then a faint activity to the end |
| Positive cloud-to-ground | 3 % | origin 9-11 km, run 0.8-2.2 r, drop at 30-45°, strike at 0.6-1.0 r, 0-3 branches | 1 stroke (81 %) or 2, long continuing current (75 %) |
| Bolt from the blue | 1 % | exit at 8-9 km, descent 45-60°, strike 5-12 km from the exit inside max(r, 8 km) | leader 1.5 × 10^5 m/s, first stroke at 150-250 ms |
| In-cloud trunk and fan | the rest (55-60 %) | oblique trunk from 6-8 km to 9-11 km at 15-40° from vertical, then 1-3 fans at 8.5-11.5 km within min(2.2 r, 8 × 10^4 m/s × 0.8 × duration) | trunk 2 × 10^5 m/s (10-20 ms), fans 8 × 10^4 m/s, 0 / 1 / 2-3 bright pulses in 25 / 45 / 30 %, 12.5 ms stutters in the final half |
| In-cloud crawler | flashes observed ≥ 600 ms or ≥ 1,500 km² (7-12 % per storm) | 1-2 leaders at 6-8 km to 1.76-2.2 r | a steady 0.3 with a lit tip walking at 1 × 10^5 m/s, never flickering |
| Cloud-to-air | 3 % | a trunk and fan whose longest branch leaves the cloud and stops 1-3 km beyond | as the trunk and fan |

Cloud-to-ground kinds are 30 % of the seeds (observed band 15-40 %). Each flash runs its leaders at
the kind's speed times a pace drawn once per flash, 0.75 to 1.35. Heights are drawn 1.0×; a
`cgHeightScale` of at most 1.5 may lift cloud-to-ground channels only, and is named here if used.
Below the cloud base a channel keeps at least 30 % of its light through any cloud; in-cloud trunks are
drawn as a crisp trace; fans keep the depth veil. About half of all flashes do not flicker. Reduced
motion keeps the single soft fade.

**The contracts**, in `web/src/globe/lightning/`:

- `kind.ts`: `FlashKind` (`CgMulti` 0, `CgSingle` 1, `CgPositive` 2, `BoltFromBlue` 3, `IcTrunkFan` 4,
  `IcCrawler` 5, `CloudToAir` 6) and `isGround(kind)`.
- `channel.ts`: `flashKind(seed, durationMs, areaKm2)` with `KIND_SHARES` cumulative
  `[0.19, 0.26, 0.29, 0.30]`, `CRAWLER` (600 ms, 1,500 km²) and `CLOUD_TO_AIR_SHARE` 0.03; the `KIND`
  table of bounds per kind; `leaderSeconds(kind, radiusKm, seed)` and
  `spreadSeconds(kind, radiusKm, flicker, seed)`; GLSL twins of each, the shaders passing the radius.
- `profile.ts`: `flashProfile(wallAge, sceneAge, display, durationMs, seed, flicker, kind)` dispatching
  to `groundProfile` and `cloudProfile`; `skeleton.ts`: `channelSkeleton(seed, radiusKm, kind)`.
- Channel segments: `level` 4 marks a second ground contact path, lit from a later stroke; the cloud
  flag is tri-state: 0 clear air (crisp, with a halo), 1 in the cloud (veiled by depth), 2 a trace in
  the cloud (crisp, at least 30 % of its light).

**Visual rules amended** (ADR 0020): rule 6 is about exposure; the share of flashes drawn in full is a
named deterministic sampling, not an exposure. Rule 7: channels run 6-11.5 km in the cloud and
cloud-to-ground ones from 6-11 km to the ground, heights 1.0×. Rule 11: gaps 10-400 ms, one stroke for
25 % of negative and 81 % of positive cloud-to-ground flashes, 0-3 bright pulses in cloud, flicker up
to 2 s. The glow sprite is max-blended below 1 km/px in storm views and screen-blended from afar.

Delivery: #400 introduces the kinds and the contracts with the picture unchanged, #399 the density
budget, #401 the geometry, #402 the timing, #403 the glow, #404 the cloud light, #408 validates and
turns this record to accepted.

## Consequences

- The picture at speed becomes a sample over a field, measurable through `lightning.stats`; the same
  heroes on a revisit or a shared URL; the sound follows the sample.
- Four hand-mirrored GLSL twins (`flashKind`, `flashProfile`, `spread`, `shown`), guarded by
  string-containment tests of their constants and by GPU captures only.
- The sample drifts for about two seconds after a lightning jump (named). A storm's predecessor cell
  before its first replay chunk stays out of the replay until the pipeline scans from `t_start`.
- To watch: near-white ≤ 2 % at night, p95 frame cost relative to a same-evening `main`, the `low` tier
  (no light map: heroes plus half sprites), phones, never measured yet.
- ADR 0013-bis no longer describes the code (vertex-shader paths, 2,048 channels): the CPU skeletons of
  256 segments for 384 flashes and the kinds are recorded here.
