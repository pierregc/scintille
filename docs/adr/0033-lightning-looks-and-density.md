# 0033 · Lightning looks and a density budget by replay speed

- Status: accepted (#408, with the final values below)
- Date: 2026-10-31
- Supersedes [0013 · 3D lightning ribbons](0013-bis-3d-lightning-ribbons.md); amends
  [visual rules](../immersive-view.md#visual-rules) 6, 7 and 11, the bounds that ADR 0020 specifies

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
`lot = seed × mix(1.0, 0.4, intensity) < share`, the seed being already a uniform hash of the flash's
time and place (hashing it again would not survive the GPU's float32), so the strongest flash is up to
2.5× likelier than the weakest; `share = target / (1.5 × load)` with `load` the flashes within their
flicker or fade, estimated from those played in the last 0.4 s of wall time; `target` 50 / 20 / 8
flashes within their flicker at once at 60× / 600× / 3600× (a power law between them), all of them at
1×, in a named band of 30-100 / 12-30 / 5-12; a flash fades out over the next 10 % of the share
rather than popping; the applied share follows the wanted one with a 0.5 s time constant (2 s lagged a
storm's rate by ten minutes at 600×) and is set at once on a seek, a new storm view and, frame by frame,
through a speed change, so a revisit or a shared link shows the same heroes. Unselected flashes keep a
point from afar (farness 0.7 to 1) and a half sprite where the cloud light has no surface, both among
the 500 newest, so every flash stays a point (ADR 0020 rule 1). The HUD rate stays the data rate; no
caption.

**Seven looks**, drawn from `u = channelHash(seed, 2)` and the observed duration and area:

| Kind | Share | Geometry (km above ground, r = observed radius) | Timing (wall clock, within the observed duration) |
|---|---|---|---|
| Negative cloud-to-ground, multi-stroke | 19 % | origin 6-8 km over 0.5 r, feed 0.3-0.8 r, drop within 30° of vertical (80 %) or 30-45°, strike 2-8 km away inside r, 3-12 branches below 5 km on both sides, a second contact in 40 % | leader 1 × 10^5 m/s (52-95 ms for 7 km, ≤ 150 ms), 2-12 strokes 10-400 ms apart, continuing current in 40 % |
| Negative cloud-to-ground, single-stroke | 7 % | as above, 1-3 branches | one stroke, then a faint activity to the end |
| Positive cloud-to-ground | 3 % | origin 9-11 km, run 0.8-2.2 r, drop at 30-45° (5-11 km across), strike at 0.6-1.0 r from the position, inside r, 0-3 branches | 1 stroke (81 %) or 2, long continuing current (75 %) |
| Bolt from the blue | 1 % | trunk from 7.0-8.4 km up to 9-10 km, run 0.5-1 r, exit at 8-9 km, descent 45-60°, strike 5-12 km from the exit inside max(r, 8 km) | leader 1.5 × 10^5 m/s over the whole path from the trunk foot, first stroke at 150-250 ms |
| In-cloud trunk and fan | the rest (55-60 %) | oblique trunk from 6-8 km to 9-11 km at 15-40° from vertical, then 1-3 fans at 8.5-11.5 km within min(2.2 r, 8 × 10^4 m/s × 0.8 × duration) | trunk 2 × 10^5 m/s (10-20 ms), fans 8 × 10^4 m/s, 0 / 1 / 2-3 bright pulses in 25 / 45 / 30 %, 12.5 ms stutters in the final half |
| In-cloud crawler | flashes observed ≥ 600 ms or ≥ 1,500 km² (7-12 % per storm) | 1-2 leaders at 6-8 km to 1.76-2.2 r | a steady 0.3 with a lit tip walking at 1 × 10^5 m/s, never flickering |
| Cloud-to-air | 3 % | a trunk and fan whose longest branch leaves the cloud and stops 1-3 km beyond | as the trunk and fan |

Cloud-to-ground kinds are 30 % of the seeds (observed band 15-40 %). Each flash runs its leaders at
the kind's speed times a pace drawn once per flash, 0.75 to 1.35. In-cloud heights are drawn 1.0×.
Cloud-to-ground heights are drawn 1.5× about the ground (`cgHeightScale` 1.5, the bound), the stem kept
under 11 km (`maxOriginKm`), so the effective factor is 1.375 to 1.5 for negative flashes and 1.0 to 1.22
for positive flashes and bolts from the blue: at 1.0× the captures at the oblique 45° pose (#401) show
drops 10 to 30 px tall under fans of 50 to 300 px, stubs rather than bolts.
Below the cloud base a channel keeps at least 30 % of its light through any cloud; in-cloud trunks are
drawn as a crisp trace; fans keep the depth veil. About half of all flashes do not flicker. Reduced
motion keeps the single soft fade.

**The contracts**, in `web/src/globe/lightning/`:

- `kind.ts`: `FlashKind` (`CgMulti` 0, `CgSingle` 1, `CgPositive` 2, `BoltFromBlue` 3, `IcTrunkFan` 4,
  `IcCrawler` 5, `CloudToAir` 6) and `isGround(kind)`.
- `channel.ts`: `flashKind(seed, durationMs, areaKm2)` with `KIND_SHARES` cumulative
  `[0.19, 0.26, 0.29, 0.30]`, `CRAWLER` (600 ms, 1,500 km²) and `CLOUD_TO_AIR_SHARE` 0.03; the `KIND`
  table of bounds per kind; `leaderSeconds(kind, radiusKm, seed)` and
  `spreadSeconds(kind, radiusKm, flicker, seed)`.
- `channel.ts` (#402): `flashTiming(kind, radiusKm, flicker, seed)` → `{ leader, spread }`, the leader
  within half the flicker; `flashLook(seed, durationMs, areaKm2, radiusKm)` → `[kind, leader, spread]`,
  drawn once per flash on the CPU and carried to the shaders as the `flashLook` attribute of the flash
  instances and channel segments, so no shader draws the kind or the timing itself.
- `profile.ts`: `flashProfile(wallAge, sceneAge, display, durationMs, seed, flicker, kind, timing,
  activity?)` dispatching to `groundProfile` and `cloudProfile`, and its GLSL twin `flashProfile(…,
  kind, timing, activity)`; `flashStroke(wallAge, flicker, seed, kind, leader)` → the stroke a
  cloud-to-ground flash is in (−1 during the leader), its age and the time to the next, whose GLSL twin
  is read from the same loop as the profile (`flashProfileStroke`, for the channel); `skeleton.ts`:
  `channelSkeleton(seed, radiusKm, kind, durationMs)`.
- Channel segments: `level` 4 marks a second ground contact path, lit from a later stroke; the cloud
  flag is tri-state: 0 clear air (crisp, with a halo), 1 in the cloud (veiled by depth), 2 a trace in
  the cloud (crisp, at least 30 % of its light).

**Glow and cloud light.** Near the floor the round glow is drawn at 15 % (40 % where no cloud light
shows), 35 % of that over sunlit cloud, easing back from 0.3 to 1 km per CSS px to the far view's ramp;
while a channel of the sample shows, it steps back to 40 % for a cloud-to-ground flash (10 % with its
halo, and only as much as the cloud lets the channel through) and to 25 % for an in-cloud one; in storm views below 1 km per CSS px overlapping glows keep the
brightest, cross-fading to screen blending from 0.7 to 1 km per CSS px; the bloom radius tightens to
0.4 at the floor; the halo is cool only, 8 core widths at 30 %. Each flash lights an elongated,
irregular patch of the cloud along its drift or, for a ground flash, its in-cloud feed (long over short axis 1.4 to 2.2), reaching
`(1.3 + 1.7 w) r` (1.5 r at the 400 km floor, `w` the share of the globe the light window covers) on
its pulses (whole from a profile of 0.7) and 0.65 of that between them, at `0.35 + 0.65 w` of its
level, max-blended; the cloud reads it sharpened by `1.25 - 0.25 w`, with a gain of 5, and the volume
lights each column in a band of 3.5 km half width, 3 km under its own top where that top rises above
11.5 km and at 8.5 km otherwise, at 1.8 times the flat layer's level; 35 % of it over sunlit cloud; a 1024 × 512 light map on `medium` and `high`: the 2048 × 1024 map on `high` was kept only
within 384 MB of GPU memory on desktop, and this set measured 386.2 MB with it at 60× (383.1 MB without).

**Drawing and framing.** Channel cores cross-fade their joints in screen values and are drawn no
thinner than 1.25 device px, so threads never bead (#407). Storms are framed at 45° instead of 20°
(#406), so a vertical channel shows 0.71 of its length instead of 0.34. A replay opens at its first
flash, not at the catalog's start (#405).

**[Visual rules](../immersive-view.md#visual-rules) amended** (ADR 0020): rule 6 is about exposure; the
share of flashes drawn in full is a named deterministic sampling, not an exposure. Rule 7: channels run
6-11.5 km in the cloud and cloud-to-ground ones from 6-11 km to the ground, in-cloud heights 1.0×,
cloud-to-ground heights 1.5× with the stem under 11 km. Rule 11: gaps
10-400 ms, one stroke for 25 % of negative and 81 % of positive cloud-to-ground flashes, 0-3 bright
pulses in cloud, flicker up to 2 s.

**Final values (#408).** The validation pass on the capture matrix of the epic (#398) kept every
named value at its design value within its band: targets 50 / 20 / 8 (bands 30-100 / 12-30 / 5-12),
near-floor sprite 0.15 (0.1-0.2), cloud light level 0.35 near the floor (0.3-0.4), volume boost 1.8
(1.5-2.5), sharpen 1.25 (1-1.5), `VEIL.trace` 0.3 (0.2-0.35), `cgHeightScale` 1.5 (1-1.5); the light
map stays at 1024 × 512 on `high`, the fallback #398 named for a desktop over 384 MB. Measured in
[Lightning look validation](../immersive-view.md#lightning-look-validation).

Delivery: #400 introduced the kinds and the contracts with the picture unchanged, #399 the density
budget, #401 the geometry, #402 the timing, #403 the glow, #404 the cloud light, #405 the replay
start, #406 the framing tilt, #407 the hairlines; #408 validated them together and accepted this
record.

## Consequences

- The picture at speed becomes a sample over a field, measurable through `lightning.stats`; the same
  heroes on a revisit or a shared URL; the sound follows the sample.
- Hand-mirrored GLSL twins (`flashProfile`, `spread`, `cloudDrift`, `shown`), guarded by
  string-containment tests of their constants and by GPU captures; the profile's twins are also run
  as JavaScript against the TypeScript in the tests.
- The kind is drawn once from the seed, on the CPU, and carried to every pass (`flashLook`, three floats
  per flash instance and per channel segment: the kind, the leader and the spread times). Drawn on the
  GPU in float32 as well, it disagreed with the CPU's for about 21 % of flashes (12 % on
  cloud-to-ground against in-cloud), so a skeleton of one kind would have got the timing of another.
  The stroke and pulse draws stay on the GPU, in float32, alike in every pass but not equal to the
  TypeScript draws: a stroke time the CPU predicts can land a few tens of milliseconds off on screen.
- The sample follows a storm's rate with a 0.5 s lag and is set at once on a seek or a speed change. A storm's predecessor cell
  before its first replay chunk stays out of the replay until the pipeline scans from `t_start`.
- To watch: near-white ≤ 2 % at night, p95 frame cost relative to a same-evening `main`, the `low` tier
  (no light map: heroes plus half sprites), real phones (only emulated so far). Not reached in this
  set: the share of channel length steeper than 60° on screen (9.7 % at 45°, 1.2 % at 20°, against
  targets of 20 and 8 %), since in-cloud fans, horizontal by nature, are most of the drawn length; the
  noon picture at speed, where little of a flash shows over a sunlit deck by design; and GPU memory
  at replay speed, over its budget by 3 to 10 MB (desktop 394.3 MB at 600× and 3600×, phone 259.3 MB),
  of which this set adds 4.4 MB on desktop and 4.3 MB on phones (the `flashLook` buffers), the rest
  being cloud frames that `main` also loads at speed (389.9 and 255.0 MB). At 60× desktop stays within
  it (383.1 MB) because the light map stays at 1024 × 512 on `high`: the 2048 × 1024 map of #404 would
  take it to 386.2 MB.
- ADR 0013-bis no longer describes the code (vertex-shader paths, 2,048 channels): the CPU skeletons of
  256 segments for 384 flashes and the kinds are recorded here.
