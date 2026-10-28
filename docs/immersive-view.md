# Immersive storm view

Targets for the M5 dive from the globe into a storm ([ADR 0020](adr/0020-immersive-storm-view.md)):
reference storms and poses, scale, visual rules and budgets. M5 PRs that touch the scene compare
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

## Poses

`view` in a share URL is `lat,lon,altitude,tilt`: with tilt 0 the altitude is the camera height above
the ground; with a tilt it is the range from the target point to the camera.

| Pose | View | Camera height | Ground width at target (16:9) | Purpose |
|---|---|---|---|---|
| `globe` | storm centre, 20,000 km, tilt 0 | 20,000 km | whole disc | Activity across the planet |
| `regional` | M3 storm framing (`frameStorm`, tilt 20°, at least 300 km) | 300 to 6,000 km | the storm bounds | Choose and read one storm |
| `close` | storm centre, range 250 km, tilt 55° | 147 km | 280 km | A few cells, oblique like the ISS |
| `deck` | storm centre, range 100 km, tilt 72° | 32 km | 112 km | Lowest view, just above the cloud deck |

Heading is north. The storm centre is the track point of the reference hour.

## Scale

1 world unit is the Earth radius, 6,371 km (`kmToWorld`). The vertical field of view is 35°, so
at a range `d` one CSS pixel of a 1080 px tall view covers `d × 0.000584` km at the centre; with a
tilt, that is across the view, and `1 / cos(tilt)` times more along it.

| Pose | km per CSS px | GLM pixel (8 km) | LI pixel (4.5 km) | Earth 4k texel (9.8 km) | Cloud texel, 2k / 4k | Glow, r = 8 km | Channel half length |
|---|---|---|---|---|---|---|---|
| `globe` (20,000 km) | 11.7 | 0.7 px | 0.4 px | 0.8 px | 1.7 / 0.8 px | 2.7 px | 1.5 px, floor 3 px |
| `regional` (1,500 km) | 0.88 | 9 px | 5 px | 11 px | 22 / 11 px | 36 px | 20 px |
| `close` (250 km) | 0.15 | 55 px | 31 px | 67 px | 134 / 67 px | 219 px | 120 px |
| `deck` (100 km) | 0.058 | 137 px | 77 px | 168 px | 336 / 168 px | 548 px | 301 px |

Glow radius is 4 times the observed radius `r = √(area / π)` at mid intensity (0.6 to 1.4 times
with intensity), at least 5 physical px. Channel half length is 2.2 `r`, at least 6 physical px.
At DPR 2, a physical px is half a CSS px.

What the table says:

- At `globe`, every source is at or below one pixel: flashes are points, compensation is required.
- From `regional` down, every source is magnified. At `close`, one GLM pixel is about 55 px and
  one Earth texel about 67 px: the Earth and clouds are soft blocks, and the glow (4 times
  the footprint) covers a large part of the view.
- At `deck`, the scene is mostly procedural: channels, cloud texture filtering and atmosphere.
  Detail must come from #125 (surface down to 500 m per texel, 2 px per texel at `close`) and
  #131 (clouds at about 2 km), never from synthetic noise.

## Observed, procedural, assumed

| Element | Status | Source in the renderer |
|---|---|---|
| Flash time, duration, source | Observed | Live and replay chunks |
| Flash position | Observed, within about 8 km (GLM) or 4.5 km (LI) | `FlashInstances` |
| Flash footprint area | Observed (illuminated cloud top area) | `flashShape.y`, radius `√(area / π)`, at least 3 km |
| Flash brightness | Observed energy, normalized | `intensityBrightness` |
| Flicker pulses within the duration | Procedural, seeded | `flashProfile` |
| Channel path, branches | Procedural, seeded | `ribbon.glsl.ts` |
| Cloud to ground share (25 %) | Procedural, not a classification | `CHANNEL.groundShare` |
| Channel heights (8 to 11.5 km, ground strokes from 7 km base) | Assumed, ground strokes exaggerated 2.5× | `CHANNEL` |
| Cloud top 12 km, cloud shell 10 km | Assumed | `CLOUD_TOP_KM`, `CLOUD_SHELL_KM` |
| Cloud opacity | Observed IR, converted (ADR 0007), about 8 km, hourly | GMGSI frames |
| Ground | Observed imagery, 2004/2016 composites | Blue Marble, Black Marble |

## Current renderer

Audit of `main` at 31d5bf3, the merged 3D lightning (#230 to #234) and M3 replay:

- Camera: orbit controls down to 0.2 Earth radius (1,274 km), then the surface camera
  (`surface.ts`): 15 km floor, 20 km minimum range, tilt up to 80°. Clip planes follow the closest
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
5. **Footprint at close range.** At `close` and `deck`, the round glow is between 1 and 2 times the
   observed radius; the 4 times compensation is for distant views only.
6. **Smooth exposure.** Exposure depends on camera height only, never on scene content, changes by
   at most one stop (2×) from `globe` to `deck`, and keeps brighter flashes brighter at every pose.
7. **Heights.** Cloud channels stay between 8 and 11.5 km. Any height exaggeration is at most 2.5×,
   named in the methodology, and must not lift geometry above the camera floor.
8. **Above-cloud camera clearance.** The camera stays at least 25 km above the ground, flights
   included: above tropical cloud tops (up to about 18 km) and the tallest drawn geometry (17.5 km),
   never inside the cloud shell or a channel.
9. **No false precision.** Flash positions are not interpolated or snapped. Surface and clouds
   show source detail only; magnification uses smooth filtering, never sharpening or added noise.

## Budgets

Measured with `bench.mjs` on the five storms, four poses, clouds on, at afterglow 0 (the default)
and 30 minutes (the heaviest choice). Every M5 PR touching the scene runs it before and after.

| Metric | Desktop | Mobile |
|---|---|---|
| Device | MacBook Pro M4 Max (32 core GPU), Chromium 1248 headed on Metal, 1920 × 1080 CSS at DPR 2, 120 Hz | Real phone not measured yet; iPhone 15 emulation on the same Mac as a proxy |
| Frame cost p95 (GPU synchronized) | ≤ 10 ms at every pose, tier kept at `high` | ≤ 10 ms in emulation, tier kept at `medium`; frame interval p95 ≤ 33 ms on a phone (#259) |
| 3 s flight between poses | no interval over 50 ms, p95 ≤ 17 ms | same, in emulation |
| GPU textures and buffers | ≤ 384 MB | ≤ 256 MB |
| Initial load transfer | ≤ 10 MB | ≤ 8 MB |
| Time to globe, to storm framed | ≤ 1 s, ≤ 5 s (broadband) | same, plus a 4G check in #259 |
| Zoom transfer, globe to deck | ≤ 12 MB; back to globe ≤ 0.5 MB | ≤ 5 MB; back ≤ 0.5 MB |
| Near white pixels (≥ 245 of 255) | ≤ 2 % of the frame at every pose | same |

MB are 10^6 bytes. The drawing buffer (screen size × DPR, 332 MB at 3840 × 2160 with MSAA) is
not budgeted. The desktop is a fast GPU: 10 ms there leaves room for laptops several times slower
before they fall under 30 fps and drop a tier.

## Baseline

Measured 2026-10-28 on `main` 31d5bf3 against production; raw results and screenshots in
[`immersive/baseline/`](immersive/baseline/): `bench-desktop.json` and `bench-mobile.json` at
30 minutes, `afterglow-0/` (default), `no-clouds/` (default, clouds off) and
`afterglow-30-no-clouds/` (R1 and R4). Videos stay on the maintainer's Mac.

| | Afterglow 0 (default) | Afterglow 30 min |
|---|---|---|
| Frame cost p95, desktop | 5.8 to 8.2 ms everywhere, tier `high` | 8 ms at `globe`; up to 46 ms at `regional`, 48 to 78 ms at `close` and `deck` (R1 to R3), tier dropped to `low` |
| Frame cost p95, mobile emulation | not run | 5 to 10 ms, up to 22 ms (`close`) and 26 ms (`deck`) on R1 |
| 3 s flight, desktop | p95 ≤ 9.3 ms, no interval over 50 ms | up to 108 ms p95, 37 intervals over 50 ms |
| Active flashes (display window) | 7 to 361 | 172 to 9,846 |
| Flashes uploaded to the GPU | 1,018 to 77,558 (whole replay) | same |
| Near white pixels (1280 px screenshots) | 0 % | 19 to 58 % at `regional`, 58 to 94 % at `close` and `deck` |
| GPU textures and buffers | 277 MB desktop (183 MB without clouds), 245 MB mobile | same |
| Initial load | 6.4 to 9.2 MB (R1 to R3 over the mobile budget), of which clouds 5.0 to 7.1 MB, Earth 1.0 MB, flashes 0.01 to 0.78 MB, code 0.3 MB | same |
| Globe ready, storm framed | 0.43 to 0.52 s, 3.8 to 4.2 s | 0.54 to 2.46 s, 4.8 to 7.2 s |
| Zoom transfer | 0 (no level of detail yet) | 0 |

Findings:

1. **The 30 minute afterglow whites out every view below `globe`.** Thousands of glows at 4 times
   the footprint add up: R1 is as white without clouds as with them, and even R4 (172 flashes) gets
   a white disc at `deck`. The same overdraw drives the frame cost and the tier drops (#254, rules
   1, 4, 5 and 6).
2. **At the default afterglow, cost is flat and the night views are dark.** Close night views show
   a few soft glows; at `deck`, one channel crosses half the view (R3), drawn over a large flat
   glow.
3. **Daytime close views are one blurred cloud.** 4k cloud texels are 67 px wide at `close` and
   168 px at `deck`; R2, R4 and R5 show a uniform grey white surface with a hard horizon (#131).
4. **City lights turn into blocks.** Black Marble texels are 11 to 67 px from `regional` to
   `close` (R1, night) (#125).
5. **Textures are uncompressed.** The globe loads the Earth as WebP into three 45 MB RGBA8
   textures although KTX2 tiers exist, and each 4k cloud frame takes 45 MB for one channel of data.
   Compressed Earth textures and one channel clouds would free about 150 MB for surface detail
   (#252) and finer clouds (#131).
6. **Clouds are 70 to 80 % of the first load.** Zoom loads nothing today.
7. **The storm track draws over the sky at `deck`** (R3): its lines cross the horizon (#126).
8. **The `deck` horizon is a hard edge** between the cloud shell and space; the atmosphere is not
   drawn from inside (#126).

## Benchmark

`web/scripts/bench.mjs` opens each reference storm on the deployed site with Playwright, flies
through the poses and writes `bench-<profile>.json` and one screenshot per pose.

```sh
pnpm -C web exec playwright install chromium
node web/scripts/bench.mjs --refs docs/immersive/references.json --out bench/ \
  --url https://scintille.app --profile desktop --gl gpu --headed
```

Per storm: cold load (bytes by kind, time to the storm framed), then for each pose the 3 s flight
(frame intervals, bytes), 2 s paused and `--seconds` playing at 60× (frame intervals, then frame
cost with the GPU synchronized each frame), the quality tier, active flashes, draw calls, the
largest instance counts per draw, the GPU memory the page allocated (textures, buffers, render
buffers, drawing buffer) and the screenshot brightness. `--afterglow <minutes>` overrides the
reference afterglow and `--no-clouds` hides the clouds.

Limits: memory is what the page asks WebGL for, not what the driver uses. Frame cost with
synchronization is an upper bound (CPU and GPU no longer overlap). Frame intervals follow the
display refresh. `--profile mobile` emulates a phone viewport on the desktop GPU and does not
replace a real phone. `--gl swiftshader` only checks that the script runs.

## Attribution

Reference images show NASA Blue Marble and Black Marble (credit NASA Earth Observatory), clouds from
NOAA NESDIS GMGSI (contains EUMETSAT Meteosat and JMA Himawari data), lightning from NOAA GOES GLM
and EUMETSAT MTG Lightning Imager (CC BY 4.0).
