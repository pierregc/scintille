# Immersive storm view

Targets for the M5 dive from the globe into a storm ([ADR 0020](adr/0020-immersive-storm-view.md)):
reference storms, the resolution chain from lightning to ground and clouds, poses, scale, visual
rules and budgets. M5 PRs that touch the scene compare
against this page and the baseline below.

## Reference storms

Five storms of 2026-10-18 from the published catalog, each with its archived clouds. Times are UTC,
at the busiest hour of the track; sun elevation at the storm centre.

| Id | Storm | Reference time | Why | Sources | Sun | Extent | Flashes |
|---|---|---|---|---|---|---|---|
| R1 | [Minas Gerais](https://scintille.app/?storm=2026-10-18-minas-gerais-7&time=2026-10-18T23:15:00Z&paused=1) | 23:15 | large, land, night, tropics | GLM, LI | -33° | 568 × 303 km | 38,579 |
| R2 | [Mato Grosso](https://scintille.app/?storm=2026-10-18-mato-grosso-22&time=2026-10-18T19:15:00Z&paused=1) | 19:15 | largest, land, day, near the equator | GLM, LI | 38° | 680 × 550 km | 36,849 |
| R3 | [North Atlantic](https://scintille.app/?storm=2026-10-18-north-atlantic-ocean-464&time=2026-10-18T23:15:00Z&paused=1) | 23:15 | ocean, night, subtropics | GLM | -38° | 295 × 256 km | 28,916 |
| R4 | [Ngaoundéré](https://scintille.app/?storm=2026-10-18-ngaoundere&time=2026-10-18T12:15:00Z&paused=1) | 12:15 | compact, land, high sun, Africa | LI | 63° | 88 × 66 km | 1,009 |
| R5 | [Ibiza](https://scintille.app/?storm=2026-10-18-ibiza&time=2026-10-18T14:15:00Z&paused=1) | 14:15 | mid latitude, island and sea, low sun | LI | 29° | 160 × 105 km | 11,366 |

Replays of storms seen by both GLM and LI hold about twice the storm's flash count: the
track-bounds selection keeps both instruments ([ADR 0011](adr/0011-storm-publication-contract.md)).
Archived clouds expire after 30 days (`archive/clouds/` lifecycle): without a longer retention,
these storms lose their clouds around 2026-11-17 and later runs compare lightning only.

Each storm opens on its share URL, paused at the reference time. The machine readable list, with
poses, is [`immersive/references.json`](immersive/references.json).

## Resolution chain

The lightning is fixed; everything else follows from it.

| Step | Value | Why |
|---|---|---|
| Lightning | LI pixel 4.5 km, GLM pixel 8 km, location within about one pixel | Instruments, not improvable |
| Zoom floor | camera 400 km above the ground (ISS altitude) | 0.23 km per screen pixel, view about 450 km wide: a storm fills the screen, an LI pixel is 19 px. Lower only magnifies the lightning data |
| Ground | 500 m per texel (day, night lights, water mask); night lights from 0.93 km texels, close to their 0.74 km sensor pixels ([ADR 0022](adr/0022-surface-imagery.md)) | At most 2 px per texel at the floor: no visible pixel |
| Clouds | about 1 km (2 km accepted where only that exists) | At most 4 px per texel at the floor with bicubic filtering |
| Immersive view | horizon view: from the floor, tilt 72°, aimed 200 km ahead of the storm along its motion | #126, chosen on captures with today's ground and clouds; revisit after #253 and #131 |

With today's assets, texels become visible (more than 2 px for the ground, 4 px for clouds) below
about 8,400 km for the 4k Earth, 4,200 km for the 8k Earth and 3,400 km for GMGSI clouds.

## Poses

`view` in a share URL is `lat,lon,altitude,tilt[,heading]`: with tilt 0 the altitude is the camera
height above the ground; with a tilt it is the range from the target point to the camera. Heading is
degrees clockwise from north, left out when north.

| Pose | View | Camera height | View width at target (16:9) | Purpose |
|---|---|---|---|---|
| `globe` | storm centre, 20,000 km, tilt 0 | 20,000 km | whole disc | Activity across the planet |
| `regional` | M3 storm framing (`frameStorm`, tilt 20°, camera at least 400 km high) | 400 to 6,000 km | the storm bounds | Choose and read one storm |
| `iss` | storm centre, range 400 km, tilt 1° | 400 km | 450 km | The floor, looking down |
| `window` | storm centre, range 740 km, tilt 60° | 400 km | 830 km, horizon in view | The floor, looking toward the horizon |

Heading is north. The storm centre is the track point of the reference hour. `iss` uses a 1° tilt
because the orbit camera stops at 1,274 km; the surface camera takes over with any tilt.

### Horizon view

The `Horizon` switch of an open storm (`grazeStorm`) flies to the floor and looks toward the
horizon: tilt 72° (range 1,054 km), aimed 200 km ahead of the storm's position at the scene time,
facing its motion (bearing between the neighbouring track points, north without motion). The
horizon sits in the upper third, the storm below the centre and the limb glows above the ground.
`window` (tilt 60°) leaves the horizon at the top edge, and leads over 300 km push long storms out
of the bottom. Captures in [`immersive/horizon/`](immersive/horizon/): `R1-tilt-60-66-72-78.jpg`
(no lead), `R1-tilt-lead.jpg` (68° and 100 km, 70° and 150 km, 72° and 200 km, 72° and 100 km),
then the chosen view on the reference storms. Pressing it again
returns to the storm frame; any camera input leaves it. Above the cloud tops only: below them the
scene is not observed.

Cost, `bench.mjs` desktop headless, 60×, afterglow 0, R1, R2, R5: frame cost p95 9.2 to 11.8 ms at the
horizon view against 11.8 to 14.6 ms at `window` in the same run, no frame interval over 16.8 ms at p95.
Other GPU jobs shared the Mac: compare the two poses, not the absolute values.

## Scale

1 world unit is the Earth radius, 6,371 km (`kmToWorld`). The vertical field of view is 35°, so
at a distance `d` one CSS pixel of a 1080 px tall view covers `d × 0.000584` km across the line of
sight. At `window`, the nearest visible ground is 510 km away and the centre 740 km.

| Pose | km per CSS px | GLM pixel | LI pixel | Earth 4k texel (9.8 km) | GMGSI cloud (8 km) | Ground target (0.5 km) | Cloud target (1 km) | Glow radius before #254, r = 8 km |
|---|---|---|---|---|---|---|---|---|
| `globe` | 11.7 | 0.7 px | 0.4 px | 0.8 px | 0.7 px | | | 2.7 px |
| `regional`, R1 (873 km) | 0.51 | 16 px | 9 px | 19 px | 16 px | 1.0 px | 2.0 px | 63 px |
| `regional`, R4 and R5 (306 km) | 0.18 | 45 px | 25 px | 55 px | 45 px | 2.8 px | 5.6 px | 179 px |
| `iss` | 0.23 | 34 px | 19 px | 42 px | 34 px | 2.1 px | 4.3 px | 137 px |
| `window`, nearest ground | 0.30 | 27 px | 15 px | 33 px | 27 px | 1.7 px | 3.4 px | 107 px |

Before #254, the glow radius was 4 times the observed radius `r = √(area / π)` at mid intensity
(0.6 to 1.4 times with intensity), at least 5 CSS px, and the channel half length 2.2 `r`, at least
6 CSS px, at every zoom. [Lightning scale](#lightning-scale) gives the sizes since.

What the table says:

- At `globe`, every source is at or below one pixel: flashes are points, compensation is required.
- At the floor, today's Earth and cloud texels are 27 to 42 px wide: that is the pixelation seen in
  the baseline. The targets bring them to 2 and 4 px.
- The M3 framing of small storms (R4, R5) goes below the floor (306 km); it moves to 400 km.
- Near the floor the 4 times glow (137 px radius at `iss`) hides the cells it should reveal.

## Lightning scale

Since #254, every lightning size is a continuous function of `k`, the km per CSS px at the flash
([`zoom.ts`](../web/src/globe/lightning/zoom.ts), mirrored in the shaders). With `r` the observed
radius and `i` the intensity:

- **Farness** `f = smoothstep(0, 1, ln(k / 0.3) / ln 10)`: 0 up to 0.3 km per px (the floor poses),
  1 from 3 km per px.
- **Round glow** radius `r × mix(1 + i, 4 × (0.6 + 0.8 i), f)`, at least `5 × (0.6 + 0.8 i)` CSS px:
  1 to 2 `r` near the floor, the former 4 times compensation (2.4 to 5.6 `r`) from afar, and a
  point of 3 to 7 CSS px when that is larger.
- **Channel** half length 2.2 `r`, always physical. Opacity `smoothstep(6, 18, 2.2 r / k)`.
- **Halo**: 8 core widths at 30 % of the core, with the channel opacity, fading from 1,500 to
  6,000 km away.
- **Bloom** strength `0.9 × (0.15 + 0.85 f)`, with `k` taken from the camera height only.
- **Cloud light**: a window 3 times the camera height in half height around the point looked at
  (4.7 km texels at 400 km, the whole globe from about 3,300 km); each flash lights `(2 + w) r`,
  at least 2 texels and `150 w²` km, `w` being the share of the globe the window covers.

1 world unit is 6,371 km: a world length is `km / 6371`, a CSS px is `k` km. Representative values
at mid intensity, for the 5th, 50th and 95th percentile footprints of R1 (`r` = 5, 10.5 and 18.6 km):

| Pose | km per CSS px | `f` | Glow, r = 5 km | Glow, r = 10.5 km | Glow, r = 18.6 km | Glow, r = 10.5 km, world units | Channel half length, r = 10.5 km, opacity | Channel opacity, r = 5 km | Bloom |
|---|---|---|---|---|---|---|---|---|---|
| `globe` | 11.7 | 1 | 58 km, 5 px | 58 km, 5 px | 74 km, 6 px | 0.0092 | 2 px, 0 | 0 | 0.90 |
| mid zoom (camera 2,000 km) | 1.17 | 0.63 | 15 km, 13 px | 32 km, 28 px | 57 km, 49 px | 0.0051 | 20 px, 1 | 0.20 | 0.62 |
| `regional`, R1 (873 km) | 0.51 | 0.13 | 9 km, 18 px | 19 km, 38 px | 34 km, 67 px | 0.0030 | 45 px, 1 | 1 | 0.24 |
| `regional`, R4 and R5 (306 km) | 0.18 | 0 | 8 km, 42 px | 16 km, 88 px | 28 km, 156 px | 0.0025 | 129 px, 1 | 1 | 0.14 |
| `iss` | 0.23 | 0 | 8 km, 32 px | 16 km, 67 px | 28 km, 119 px | 0.0025 | 99 px, 1 | 1 | 0.14 |
| `window`, nearest ground | 0.30 | 0 | 8 km, 25 px | 16 km, 53 px | 28 km, 94 px | 0.0025 | 78 px, 1 | 1 | 0.14 |
| `window`, target | 0.43 | 0.07 | 8 km, 19 px | 18 km, 41 px | 31 km, 72 px | 0.0028 | 53 px, 1 | 1 | 0.14 |

The glow profile has a hot core: its light falls to half at about 0.3 of the glow radius and to a
tenth at half of it, so near the floor a glow of 1 to 2 `r` reads as a disc of 0.5 to 1 `r`, and
the cloud light around it spreads over about 2 `r`.

Physical scale and compensation:

- Positions, footprints, energies and durations keep their measured values at every pose; channel
  lengths are physical; channel heights follow [Observed, procedural, assumed](#observed-procedural-assumed).
- Compensation only applies where the footprint is a few pixels: the 4 times glow and the point
  size from afar, the pixel width of channels and halos, and the bloom. Near the floor the glow is
  1 to 2 footprints and the bloom 15 % of the globe's.
- Each flash flickers for its observed duration in wall clock time, so at 60× a storm view shows
  about a minute of flashes at once ([flash profile](flash-profile.md)). Glows there use screen
  blending, the cloud light keeps the brightest flash, and bloom and cloud light scale with how
  dark the scene is, so overlaps and sunlit clouds never turn white.

Measured on 2026-10-28 with a local production build of #254 against production data, on the same
Mac as the baseline; captures at the four poses in [`immersive/lightning-scale/`](immersive/lightning-scale/).
The Mac also ran other GPU jobs that evening, so frame costs swung by up to 3 times between runs of the
same build; the figures below compare builds run back to back.

| | #254 | `main` |
|---|---|---|
| Frame cost, desktop, 60×, quiet repetitions of interleaved runs (R1, R2, R5; `regional`, `iss`, `window`) | 7.3 to 9.1 ms | 6.8 to 7.8 ms |
| Frame cost p95, mobile emulation, 60×, all storms and poses | 2.8 to 6.4 ms, tier `medium` | 2.2 to 5.5 ms |
| 3 s flights | no interval over 50 ms | same |
| Near white pixels, bench screenshot (paused at 60×) | at most 0.9 % (R1 `iss`), desktop | 0 % |
| Flashes on screen at once, 60× | up to about 360 (R1) | under a second of scene time |
| GPU textures and buffers | 283 MB desktop, 243 MB mobile | 285 MB, 245 MB |
| First load, zoom transfer | unchanged | |

At 600× and 3600×, the 500 flash budget keeps the frame cost at 10 to 15 ms and the tier at `high` on
R1 (without it, 3600× dropped the tier and hitched flights up to 170 ms), but near white pixels reach
12 % (600×) and 22 % (3600×) at `iss`: those speeds show ten minutes or an hour per second.

## Observed, procedural, assumed

| Element | Status | Source in the renderer |
|---|---|---|
| Flash time, duration, source | Observed | Live and replay chunks |
| Flash position | Observed, within about 8 km (GLM) or 4.5 km (LI) | `FlashInstances` |
| Flash footprint area | Observed (illuminated cloud top area) | `flashShape.y`, radius `√(area / π)`, at least 3 km |
| Flash brightness | Observed energy, normalized | `intensityBrightness` |
| Flicker pulses within the duration | Procedural, seeded, timed like return strokes, played in wall clock time | `flashProfile` |
| Leader spread and light drift within the footprint | Procedural, seeded, within 0.6 `r` of the observed position | `spread`, `cloudDrift` |
| Channel path, branches, widths, brightness along them | Procedural, seeded | `skeleton.ts` |
| Cloud to ground share (25 %) | Procedural, not a classification | `CHANNEL.groundShare` |
| Channel heights (in-cloud 8 to 11.5 km, ground channels from the cloud to the ground) | Assumed, not exaggerated | `SKELETON` |
| Cloud top 12 km, cloud shell 10 km | Assumed | `CLOUD_TOP_KM`, `CLOUD_SHELL_KM` |
| Cloud opacity | Observed IR, converted (ADR 0007), about 8 km, hourly | GMGSI frames |
| Channels veiled in the cloud, hidden below it | Observed cloud opacity on the line of sight, assumed scattering | `veil.ts` |
| Ground | Observed imagery, 2004/2016 composites | Blue Marble, Black Marble |

## Scene time

One clock drives the scene (`SceneClock`). Each layer shows observations, never a picture made up
between them, and says how far they are from the scene when it matters
([`scene-time.ts`](../web/src/globe/scene-time.ts), #255).

- **Observed time.** The time of the newest flashes drawn: the clock in replay; in live, the clock
  minus the slowest delay among the open storm's sources (`LIVE_DELAY_MS`, GLM 2 min, LI 12 min),
  or the fastest one on the globe. Ages are measured from it.
- **Storm position.** The latest track sample at or before the observed time, never interpolated.
  Samples come once per hourly window: up to 90 min old the position is shown with its age, then
  as "No position since". Nothing is shown before the first sample.
- **Clouds.** Frames within 90 min of each other crossfade; across a wider gap (missing frames) the
  nearest frame is shown alone. Its age appears from 15 min, earlier or later than the scene; beyond
  3 h the layer hides ("No cloud data").
- **Live and replay.** Leaving a storm returns to the wall clock at 1×, the live clouds and no
  selection; browser history reopens the storm at its time, speed and pause state. Layer switches
  are kept.

Fixtures: [`scene-time-cases.json`](../web/src/globe/scene-time-cases.json) (delayed sources, old
clouds, missing frames, absent positions, scrubbing) and the round trip test in
[`round-trip.test.ts`](../web/src/globe/replay/round-trip.test.ts).

## Current renderer

Audit of `main` at 31d5bf3, the merged 3D lightning (#230 to #234) and M3 replay:

- Camera: orbit controls down to 0.2 Earth radius (1,274 km), then the surface camera
  (`surface.ts`): 400 km floor (#126; 15 km before), tilt up to 80°. Zooming in stops at the floor
  without changing the tilt; flights are lifted to the floor where their path would dip under it. Clip planes follow the closest
  shell (`orbit.ts`).
- Earth: one global texture set per tier (2k, 4k, 8k on disk; the globe loads 4k on medium and high).
- Clouds: one shell at 10 km, 2k or 4k frames, bicubic on medium and high, lit from inside by a
  1024 × 512 flash light map.
- Lightning: one instanced glow per flash in the display window (up to the 262,144 flash ring),
  channels for flashes still flickering (at most 2,048), halos up to 512 channels, fading out from
  1,500 to 6,000 km. Exposure 1.6 and bloom (strength 0.9) are constant at every altitude.
- Quality: `low` (2k, DPR 1, no cloud light, no bloom), `medium`, `high` (DPR 2, bloom); one step
  down after 5 s under 30 fps.

## Visual rules

1. **Distant flashes are luminous points.** While the physical glow radius is under 3 CSS px, a
   flash is a round point of 1.5 to 3 CSS px, sized and lit by intensity. No channel, no halo.
2. **Channels appear progressively.** Channel length is always physical (2.2 `r`). Its opacity
   rises from 0 to 1 while its half length grows from 6 to 18 CSS px. No pixel floor on length.
3. **No popping.** Every size, opacity and exposure is a continuous function of km per pixel. During
   a 3 s flight no flash changes size or brightness by more than 10 % from one frame to the next,
   apart from its own flicker.
4. **Restrained halos.** A halo exists only with a visible channel, at most 8 core widths wide and
   30 % of the core level. At `regional`, halos never merge into a glow covering the storm.
5. **Footprint near the floor.** At `iss` and `window`, the round glow is between 1 and 2 times the
   observed radius; the 4 times compensation is for distant views only.
6. **Smooth exposure.** Exposure depends on camera height only, never on scene content, changes by
   at most one stop (2×) from `globe` to `iss`, and keeps brighter flashes brighter at every pose.
7. **Heights.** Cloud channels stay between 8 and 11.5 km. Any height exaggeration is at most 2.5×,
   named in the methodology.
8. **Camera floor.** The camera stays at least 400 km above the ground in every mode: zoom, tilt,
   flights and storm framing.
9. **No visible pixels at the floor.** At the nearest visible point, a ground texel covers at most
   2 CSS px and a cloud texel at most 4 CSS px, with bicubic filtering for clouds.
10. **Storm views without afterglow.** While a storm is open or followed, the afterglow is 0: each
   flash shows its flicker and a fade of about a second, then leaves no trace.
11. **Real time flicker.** A flash flickers for its observed duration in wall clock time at any
   replay speed: pulses about 60 ms apart (10 to 200 ms, as between real strokes), a rise within
   one frame, a decay of tens of milliseconds. Replay speed only compresses the gaps between
   flashes.
12. **No false precision.** Flash positions are not interpolated or snapped. Surface and clouds
   show source detail only; magnification uses smooth filtering, never sharpening or added noise.

## Budgets

Measured with `bench.mjs` on the five storms, four poses, clouds on, at afterglow 0 (the storm
view setting). The 30 minute afterglow is measured at `globe` only, where it stays offered. Every
M5 PR touching the scene runs it before and after. Since #254 an open storm forces afterglow 0, so
the benchmark, which opens the storms, measures every pose at 0; the 30 minute afterglow concerns
the globe overview without a storm.

| Metric | Desktop | Mobile |
|---|---|---|
| Device | MacBook Pro M4 Max (32 core GPU), Chromium 1248 headed on Metal, 1920 × 1080 CSS at DPR 2, 120 Hz | Real phone not measured yet; iPhone 15 emulation on the same Mac as a proxy |
| Frame cost p95 (GPU synchronized) | ≤ 10 ms at every pose, tier kept at `high` | ≤ 10 ms in emulation, tier kept at `medium`; frame interval p95 ≤ 33 ms on a phone (#259) |
| 3 s flight between poses | no interval over 50 ms, p95 ≤ 17 ms | same, in emulation |
| GPU textures and buffers | ≤ 384 MB | ≤ 256 MB |
| Initial load transfer | ≤ 10 MB | ≤ 8 MB |
| Time to globe, to storm framed | ≤ 1 s, ≤ 5 s (broadband) | same, plus a 4G check in #259 |
| Zoom transfer, `globe` to `iss` | ≤ 12 MB; back to globe ≤ 0.5 MB | ≤ 5 MB; back ≤ 0.5 MB |
| Near white pixels (≥ 245 of 255) | ≤ 2 % of the frame at every pose | same |

MB are 10^6 bytes. The drawing buffer (screen size × DPR, 332 MB at 3840 × 2160 with MSAA) is
not budgeted. The desktop is a fast GPU: 10 ms there leaves room for laptops several times slower
before they fall under 30 fps and drop a tier.

## Baseline

Measured 2026-10-28 on `main` 31d5bf3 against production, at the four poses. Raw results and
screenshots in [`immersive/baseline/`](immersive/baseline/): `bench-desktop.json`,
`bench-mobile.json` and one 1920 px screenshot per storm and pose at afterglow 0, with a 100 %
centre crop at `iss` and `window` (`R1-iss-crop.jpg`…); `afterglow-30/` holds the same runs with
the 30 minute afterglow.

| | Afterglow 0 (storm view) | Afterglow 30 min |
|---|---|---|
| Frame cost p95, desktop | 7.3 to 8.3 ms at every pose, tier `high` | 7.4 to 8.4 ms at `globe`; up to 41 ms at `regional` and 61 ms at `iss` (R1), tier dropped to `medium` or `low` on R1 to R3 |
| Frame cost p95, mobile emulation | 2.9 to 6.0 ms, tier `medium` | up to 35 ms at `iss` (R1) |
| 3 s flight, desktop | p95 ≤ 9.2 ms, no interval over 50 ms | up to 108 ms p95, 19 intervals over 50 ms (R1 to `iss`) |
| Active flashes (display window) | 7 to 359 | 172 to 9,845 |
| Near white pixels | 0 % | 0 at `globe`; 19 to 60 % at `regional`, 38 to 77 % at `iss` (96 % on mobile, R2) |
| GPU textures and buffers | 277 MB at `high` (268 + 8.5), 245 MB at `medium` | same |
| Initial load | 5.5 to 9.2 MB, of which clouds 4.1 to 7.0 MB, Earth 1.0 MB, flashes up to 0.8 MB, code 0.3 MB | same |
| Globe ready, storm framed | 0.34 to 0.56 s, 3.7 to 4.1 s | 0.35 to 0.85 s, 3.7 to 4.9 s |
| Zoom transfer, `globe` to `iss` | about 1 kB (no level of detail yet) | same |

Findings:

1. **At the floor, everything is pixels or blur.** At `iss` the clouds are soft blobs 30 to 40 px
   wide and the ground under them a smeared 4k texture (`R2-iss.jpg`, crops). At `window`, the
   far half reads well (coasts, cloud fields, limb), the near half is blurred (`R5-window.jpg`).
   This is the gap #125, #251 to #253 and #131 close; until then the floor views are not judged
   on looks.
2. **Default storm view cost is flat and low.** About 8 ms everywhere on desktop, 6 ms on mobile
   emulation: room for finer ground and clouds.
3. **Paused, the storm view shows almost no lightning.** With afterglow 0 a flash lives about a
   second of scene time, so a paused frame catches few; playing at 60×, it lives 17 ms on screen
   and its flicker under one frame. Real time flicker (rule 11) is what will make it visible.
4. **The 30 minute afterglow whites out the storm views** (38 to 96 % near white at `iss`) and
   drops the tier: storm views no longer use it (rule 10). At `globe` it costs nothing extra.
5. **The M3 framing goes below the floor** for compact storms: 306 km for R4 and R5 on desktop.
   Mobile frames up to 3 times higher (397 to 3,033 km).
6. **Textures are uncompressed.** The Earth loads as WebP into three 45 MB RGBA8 textures though
   KTX2 tiers exist, and each 4k cloud frame takes 45 MB for one channel of data: about 150 MB to
   free for the new levels.
7. **Clouds are 70 to 80 % of the first load,** which goes over the mobile budget (8 MB) for R1
   to R3. Zoom loads nothing today.

## Benchmark

`web/scripts/bench.mjs` opens each reference storm on the deployed site with Playwright, flies
through the poses and writes `bench-<profile>.json` and one screenshot per pose.

```sh
pnpm -C web exec playwright install chromium
node web/scripts/bench.mjs --refs docs/immersive/references.json --out bench/ \
  --url https://scintille.app --profile desktop --gl gpu --headed --afterglow 0
```

Per storm: cold load (bytes by kind, time to the storm framed), then for each pose the 3 s flight
(frame intervals, bytes), 2 s paused and `--seconds` playing at 60× (frame intervals, then frame
cost with the GPU synchronized each frame), the quality tier, active flashes, draw calls, the
largest instance counts per draw, the GPU memory the page allocated (textures, buffers, render
buffers, drawing buffer) and the screenshot brightness. `--afterglow <minutes>` overrides the
reference afterglow, `--speed` plays at another replay speed than 60× and `--no-clouds` hides the
clouds. Active flashes count those started within a second of wall clock time, or within the
afterglow window.

Limits: memory is what the page asks WebGL for, not what the driver uses. Frame cost with
synchronization is an upper bound (CPU and GPU no longer overlap). Frame intervals follow the
display refresh. `--profile mobile` emulates a phone viewport on the desktop GPU and does not
replace a real phone. `--gl swiftshader` only checks that the script runs.

## Attribution

Reference images show NASA Blue Marble and Black Marble (credit NASA Earth Observatory), clouds from
NOAA NESDIS GMGSI (contains EUMETSAT Meteosat and JMA Himawari data), lightning from NOAA GOES GLM
and EUMETSAT MTG Lightning Imager (CC BY 4.0).
