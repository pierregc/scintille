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
degrees clockwise from north, left out when north. A tilt above 80° is the 80° view with the gaze
raised by the difference ([free tilt](#free-tilt)).

| Pose | View | Camera height | View width at target (16:9) | Purpose |
|---|---|---|---|---|
| `globe` | storm centre, 20,000 km, tilt 0 | 20,000 km | whole disc | Activity across the planet |
| `regional` | M3 storm framing (`frameStorm`, tilt 45° since #406, camera at least 400 km high) | 400 to 6,000 km | the storm bounds | Choose and read one storm |
| `iss` | storm centre, range 400 km, tilt 1° | 400 km | 450 km | The floor, looking down |
| `window` | storm centre, range 740 km, tilt 60° | 400 km | 830 km, horizon in view | The floor, looking toward the horizon |
| `grazing` | storm centre, tilt 80° (range 1,439 km) | 400 km | 1,610 km, horizon at 44 % from the top | The most grazing orbit |
| `limb` | storm centre, tilt 90°: the `grazing` camera, gaze raised 10° | 400 km | 1,610 km at the storm, horizon at 71 % from the top | The horizon and the limb |

Heading is north. The storm centre is the track point of the reference hour. `iss` uses a 1° tilt
because the orbit camera stops at 1,274 km; the surface camera takes over with any tilt. `grazing`
and `limb` are given at 400 km: the camera slides back to the floor range of its tilt.

### Horizon view

The `Horizon` switch of an open storm (`grazeStorm`) flies to the floor and looks toward the
horizon: tilt 72° (range 1,054 km), aimed 200 km ahead of the storm's position at the scene time,
facing its motion (bearing between the neighbouring track points, north without motion). The
horizon sits in the upper third, the storm below the centre and the limb glows above the ground.
`window` (tilt 60°) leaves the horizon at the top edge, and leads over 300 km push long storms out
of the bottom. Captures in [`immersive/horizon/`](immersive/horizon/): `R1-tilt-60-66-72-78.jpg`
(no lead), `R1-tilt-lead.jpg` (68° and 100 km, 70° and 150 km, 72° and 200 km, 72° and 100 km),
then the chosen view on the reference storms. Pressing it again
returns to the storm frame; any camera input leaves it, and a drag tilts on past it to the limb. Above the cloud tops only: below them the
scene is not observed.

Cost, `bench.mjs` desktop headless, 60×, afterglow 0, R1, R2, R5: frame cost p95 9.2 to 11.8 ms at the
horizon view against 11.8 to 14.6 ms at `window` in the same run, no frame interval over 16.8 ms at p95.
Other GPU jobs shared the Mac: compare the two poses, not the absolute values.

### Storm frame tilt

The storm frame (`REPLAY_FRAME`, the `regional` pose, the `Follow` frame) tilts 45° from straight
down since #406; it was 20°. A vertical channel projects at sin(tilt) of its length on screen, 0.34
at 20° against 0.71 at 45°; a horizontal one across the line of sight shows in full, and one along it
at cos(tilt) (0.94 at 20°, 0.71 at 45°), so verticals go from about a third of the along-sight
horizontals to par: the old frame flattened every flash by construction ("flashes are too
horizontal", #398). `frameStorm` is unchanged: the
footprint is fitted in the 62 % safe area by bisection, never nearer than the floor range of the tilt
(`floorRange`: 424 km at 20°, 550 km at 45°), so a small storm sits at 561 km instead of 432 km and
wide storms move by −15 to +6 % (table below). At the floor the camera is 408 km high and the
bottom edge looks 24° from nadir: the nearest visible ground is 450 km away, between `iss` (400 km)
and `window` (510 km), so a 1 km cloud texel stays under 4 px (visual rule 9). A 16:9 frame's top
corners look 63° from nadir at the floor, under the 70° horizon. Of the storms below, only
Basse-Kotto (camera 1,250 km high, horizon 57° from nadir, top corners 58 to 59°) shows the limb in
the desktop top corners; R2 (970 km, horizon 60°) stays just under it. On a 390 × 844 phone, wide
storms are framed from 2,600 to 4,200 km high, and the limb with black sky fills the top of the
screen: about 16 % of its height for Basse-Kotto, 11 % for R2 and 7 % for R1, against none at 20°.
The horizon view (72°) and the
floor poses are unchanged. A reload with a frame checkpoint saved at the old tilt flies to the new frame
(`sameFrame` is false). The tilt is a tunable of [ADR 0020](adr/0020-immersive-storm-view.md)
point 5, chosen by the maintainer on captures: the sweep below shows 20°, 35°, 42°, 45° and 50° on
Basse-Kotto (2026-10-27, 12:00 UTC, 60×) and the five reference storms, desktop 1600 × 1000 and
phone 390 × 844, in [`immersive/lightning-look/framing-tilt/`](immersive/lightning-look/framing-tilt/)
(`<storm>-tilt-20-35-42-45-50.jpg`, the 45° phone frame in the last cell;
`<storm>-phone-tilt-20-35-42-45-50.jpg`; `C1-tilt-20.jpg`, `C1-tilt-45.jpg`, `R1-tilt-20.jpg`,
`R1-tilt-45.jpg` full size). Fitted range (km) per storm and tilt, desktop / phone:

| Storm (bounds) | 20° | 35° | 42° | 45° | 50° |
|---|---|---|---|---|---|
| Basse-Kotto 2026-10-27 (863 × 690 km) | 1,827 / 4,972 | 1,724 / 5,056 | 1,635 / 5,091 | 1,639 / 5,106 | 1,661 / 5,128 |
| R1 Minas Gerais (568 × 303 km) | 965 / 3,228 | 1,002 / 3,265 | 1,018 / 3,281 | 1,024 / 3,287 | 1,034 / 3,297 |
| R2 Mato Grosso (680 × 550 km) | 1,471 / 3,891 | 1,382 / 3,958 | 1,308 / 3,986 | 1,289 / 3,998 | 1,307 / 4,015 |
| R3 North Atlantic (295 × 256 km) | 677 / 1,722 | 628 / 1,753 | 591 / 1,765 | 575 / 1,771 | 610 / 1,778 |
| R4 Ngaoundéré (88 × 66 km) | 432 / 510 | 491 / 517 | 536 / 536 | 561 / 561 | 610 / 610 |
| R5 Ibiza (160 × 105 km) | 432 / 926 | 491 / 938 | 536 / 943 | 561 / 945 | 610 / 949 |

Small storms sit on the floor range of the tilt (432 km at 20°, 561 km at 45°, 610 km at 50°). Storms
bound by their north-south extent fit closer at a higher tilt, which foreshortens it: Basse-Kotto
1,827 → 1,639 km, R2 1,471 → 1,289 km, R3 677 → 575 km; R1, bound by its east-west extent, backs off
from 965 to 1,024 km.
Phone frames are 1.0 to 3.2× farther than desktop ones at 45° (1.2 to 3.3× at 20°); four storms pass
3× at 45° (Basse-Kotto, R1, R2, R3) against one at 20° (R1). The phone ranges barely move
(+1.8 to +2.8 %, R4 +10 % onto the floor range): the crossing comes from the desktop frames of the
storms bound north-south coming 10 to 15 % closer. At 35° only R1 passes 3× (3.26, against 3.35 at
20°).

The `regional` pose of `bench.mjs` (`"framed"` in `immersive/references.json`) moves with the
constant: benches before #406 measured the 20° frame. Against it, same evening, R1, R2 and R5 at
60×, five alternated rounds on a Mac shared with other GPU jobs: median frame cost p95 +0.6, +0.5
and −1.0 ms (+1.4, +2.2 and −2.5 ms over the three quietest rounds), near white 0.2 to 0.5 %, no
flight frame over 50 ms.

### Free tilt

A vertical drag tilts the surface camera from straight down to 90° in one gesture (#394,
[ADR 0032](adr/0032-free-camera-tilt.md)): right drag or Ctrl + drag with a mouse, two fingers on a
touch screen, 0.005 rad per pixel, so about 310 px from straight down to 90°.

- **0 to 80°: orbit.** The camera turns around the point at the screen centre. Where the range the
  visitor chose would take it under the floor, it slides back along the floor instead of stopping:
  from `iss`, `window` and the horizon view the drag no longer blocks.
- **80 to 90°: raised gaze.** The camera stays where it is and looks up by up to 10°. At the floor
  the horizon moves from 44 % to about 71 % of the screen height, the orbited point to about 78 %.
- **Back.** Dragging down lowers the gaze first, then the tilt, and ends on the view the drag
  started from: only zoom, pinch, flights and `Follow` change the chosen range. Zooming in at the
  floor changes nothing; zooming out starts from where the camera is, and hands over to the globe
  view once the camera, not the range, passes 1,274 km.
- **Horizon and Follow.** Their compositions are unchanged. A drag from the horizon view tilts on
  past it; a drag while following stops `Follow`, as any input.
- **Point looked at.** The cloud relief windows and the flash cloud light follow the screen centre
  on the ground up to 80° and stay at that point beyond (1,342 km ahead at the floor), instead of
  jumping under the camera when the centre passes the horizon.

Measured with `bench.mjs` on the five storms and the `grazing` and `limb` poses against production
data, on the dev server, flights and frame cost on a local production build
([`measurements.json`](immersive/free-tilt/measurements.json)):

| | Desktop | Mobile (emulated) |
|---|---|---|
| GPU textures and buffers at `grazing` and `limb` | 366 MB, as at every pose | 244 MB, as at every pose |
| Transfer, `window` to `grazing` to `limb` | at most 0.47 MB | at most 0.18 MB |
| Near white pixels at `grazing` and `limb` | at most 0.1 % | at most 0.4 % |
| Quality tier | `high` kept | `medium` kept |
| 3 s flight into each pose | interval p95 16.8 ms, none over 50 ms | same |

Frame cost, three interleaved rounds of `window`, `grazing` and `limb` per storm, two runs, median
p95: `grazing` 8.1 to 11.3 ms and `limb` 7.5 to 12.1 ms, against 9.1 to 14.6 ms at `window` in the
same runs; at p50 `limb` costs less than `window` in all ten storm runs and `grazing` in nine.
Another session's GPU measurements shared the Mac, so `window` itself read over the 9.6 ms of the
[final validation](#final-validation): the grazing views cost no more than `window`, which holds the
budget on a quiet machine, but their own 10 ms is not shown alone. Five rounds on R5 with less load:
`window` 9.8, `grazing` 9.1, `limb` 8.9 ms. The far view draws more sky and less ground, so `limb`
is the cheapest storm pose. Captures in [`immersive/free-tilt/`](immersive/free-tilt/) (clock in
Paris time): `R2-drag.jpg` and `R5-drag.jpg` (one right drag from `iss`: 1°, 35°, 70°, 89.8°; the drag
back ends on the starting view), `R2-limb.jpg` and `R5-limb.jpg` (89.8°).

### Storm follow

`Follow` keeps the camera on a storm (#258): the open replay, or a storm picked on the live globe
([`focus/`](../web/src/globe/focus/)).

- **Picking a live storm.** A tap or click selects the active cell under it, or the nearest one
  within 12 CSS px (24 on touch), from `storms/active.json`. The globe polls it every 60 s with
  revalidation while it is live (ADR 0021); a changed object is about 80 kB gzipped. The camera
  frames the cell, its hull and 10 minute path appear, and each flash is drawn alone (afterglow 0)
  as in a replay. `Globe` drops it and flies back out (Escape stops following first); leaving a
  replay flies out too.
- **Position and footprint.** Both follow [scene time](#scene-time): the latest position at or
  before the observed time, never interpolated, shown for 90 minutes. Live, the 10 minute path point
  and the hull of the current cell, solid. Replay, the catalog keeps one centroid and area per
  hourly window, not the outline: a dashed circle of that area. A thin light line over a 1 px dark
  shadow, so it reads over sunlit clouds and at night; changes fade over 500 ms.
- **Framing.** The storm frame: tilt 45° ([storm frame tilt](#storm-frame-tilt)), the footprint fitted in the safe area (`frameStorm`), never
  below the floor, so it backs off as the storm grows. With `Horizon`, the horizon view along a fixed
  heading: the one the view had, or the motion between the last two positions when switched on
  while following. The heading never turns with the storm.
- **Motion.** The camera glides to each new position with a critically damped spring (most of the
  way in 2 s) and stops on it, never past it: it lags the observations and predicts nothing. A
  position more than 4° away is reached by a flight. With reduced motion it moves at once.
- **Leaving.** Any camera input (drag, wheel, pinch, tap on the globe) stops following at once.
  Scrubbing, speed and pause keep it: the camera goes to the position of the new time.
- **Splits, merges and ends.** A live storm is followed through `previous_ids`, `ended` and `into`
  (`resolveCell`). A replaced id continues silently; a merger continues with the other storm and
  says so ("Lakeland merged into it at 18:44"); a split leaves the main branch followed ("A cell
  split off at 18:33"). An expired storm ("Ended · last flash 18:41") or one the feed no longer
  lists ("No longer tracked") stops following and loses its hull, its path stays. A silent source
  ("No data from MTG LI since 18:29") keeps it, as it may come back. A replay storm past its last
  flash says "Ended · last flash 05:22".
- **Lost updates.** A snapshot older than 15 minutes adds "Updates delayed since 10:05" and the last
  one stays; a failed poll backs off. The camera holds the last position.
- **Still camera.** While a storm is open, in replay or picked live, the globe never turns on its
  own: only the visitor or `Follow` moves the camera. The idle turn comes back 20 s after leaving it.
- **End of a replay.** Past the storm's last flash, `Replay from start` plays it again from its first
  flash, the camera where it is. After 10 s playing past the end the globe goes back to live with
  every flash and flies out, as `Back to live` does. Captures in
  [`immersive/replay-end/`](immersive/replay-end/). A replay opens, restores and restarts at the
  first flash its chunks hold (the later of the catalog's `t_start` and the earliest `event_min` of
  its chunks), which can be later than the catalog's `t_start`: Basse-Kotto (2026-10-27) opens at
  04:00:06 UTC while its catalog entry starts at 03:30. Captures in
  [`immersive/lightning-look/405/`](immersive/lightning-look/405/).

Measured on the five storms with a local production build against production data, 60× from
12 minutes before the reference hour, following, then the horizon view
([`measurements.json`](immersive/follow/measurements.json)), at the 20° frame, before #406:

| | R1 | R2 | R3 | R4 | R5 |
|---|---|---|---|---|---|
| Camera range while following, km | 545 to 658 | 568 to 821 | 432 | 432 | 432 |
| Frames where the camera moved away from the position it follows | 0 | 0 | 0 | 0 | 0 |
| Largest move between two frames, km | 0.7 | 0.9 | 0.8 | 0.6 | 0.3 |
| Flashes of the last 10 minutes within half the view height, p10 | 85 % | 84 % | 97 % | 100 % | 100 % |

Same page A/B on R1 and R5 (desktop, DPR 2): the footprint adds 2 draw calls (28 to 30) and no
measurable frame cost (p95 14.7 against 14.7 ms and 10.7 against 11.0 ms; the Mac ran other GPU
jobs). The follow update costs under 0.2 ms at p99 per frame at 600×, parsing a snapshot 0.6 ms
(2.3 ms with a 4× slower CPU). Ten rounds of picking, following, opening a replay, following and
returning to live kept WebGL buffers at 25 and vertex arrays at 18, and the JS heap between 37 and
46 MB. Captures in [`immersive/follow/`](immersive/follow/) (clock in Paris time): `R1-follow.jpg`
to `R5-follow.jpg`, `live.jpg` and `live-touch.jpg` (a live storm picked, followed, at the horizon,
back to the globe), `R5-touch.jpg` (phone: follow, horizon, a drag stops it, scrubbing while
following, back to live).

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
- **Closeness** `c = 1 - smoothstep(0, 1, ln(k / 0.3) / ln(1 / 0.3))`: 1 up to 0.3 km per px, 0 from
  1 km per px, where storm views screen-blend glows again. It weighs the rules of the floor, so views
  from 1 km per px (the globe) are drawn as before them. Since the 45° storm frame (#406) every
  whole-storm frame of the reference storms is under 1 km per px on a 1,000 px tall view (`k` from
  the camera height): Basse-Kotto's, camera 1,248 km high, is at 0.79 km per px, inside the
  cross-fade from max to screen blending (75 % max-blended, 10 % of the rules of the floor; at 20° it
  was 1.1 km per px, screen-blended with the far rules), R2 at 0.61 and R1 at 0.48 (37 % and 66 % of
  the rules of the floor), R3, R4 and R5 at 0.26, on the floor rules. The table below gives the sizes
  at representative `k`.
- **Round glow** radius `r × mix(1 + i, 4 × (0.6 + 0.8 i), f)`, at least `5 × (0.6 + 0.8 i)` CSS px:
  1 to 2 `r` near the floor, the former 4 times compensation (2.4 to 5.6 `r`) from afar, and a
  point of 3 to 7 CSS px when that is larger. Level `mix(mix(0.4, 1, f), 0.15, c)`: 15 % at the
  floor, where the lit cloud and the channel carry the flash (40 % where the cloud light does not
  show: the `low` tier, clouds hidden or not loaded yet), the ramp from 40 % to full from 1 km per px.
  The level steps between 15 and 40 % in the frame the cloud light turns on or off, as the picture
  itself does then. Times `mix(1, 0.35, day × c)` over
  sunlit cloud, with `day = smoothstep(-0.05, 0.25, n · sun)` as for channels.
- **Channel** half length 2.2 `r`, always physical. Opacity `smoothstep(6, 18, 2.2 r / k)`.
- **Halo**: 8 core widths at 30 % of the core, cool only, with the channel opacity, fading from
  1,500 to 6,000 km away.
- **Bloom** strength `0.9 × (0.1 + 0.9 f)`, radius `mix(0.55, 0.4, c)`, with `k` taken from the camera height only.
- **Cloud light**: a window 3 times the camera height in half height around the point looked at
  (4.7 km texels at 400 km on `medium` and `high`, the whole globe from about 3,300 km);
  each flash lights an elongated, irregular patch reaching `(1.3 + 1.7 w) r` on its pulses and 0.65 of that between them, at least
  2 texels and `150 w²` km, `w` being the share of the globe the window covers, at `0.35 + 0.65 w`
  of its level (1.5 `r` at 43 % at the 400 km floor), read sharpened by `1.25 - 0.25 w`.
  Where the clouds are in relief, each column is lit in a band under its own top
  ([flash profile](flash-profile.md#cloud-light)).
- **Phones** draw these sizes as a 1080 CSS px tall view would, shrunk to their height (`k` and
  channel widths times `h / 1080`), so a phone shows the middle of the desktop picture; the point
  floor stays in CSS px. Their glow (at the floor and at the start of its ramp from afar) and their
  cloud light near the floor drop to 0.6 of the desktop level (#333).

1 world unit is 6,371 km: a world length is `km / 6371`, a CSS px is `k` km. Representative values
at mid intensity, for the 5th, 50th and 95th percentile footprints of R1 (`r` = 5, 10.5 and 18.6 km):

| Pose | km per CSS px | `f` | Glow, r = 5 km | Glow, r = 10.5 km | Glow, r = 18.6 km | Glow, r = 10.5 km, world units | Channel half length, r = 10.5 km, opacity | Channel opacity, r = 5 km | Bloom |
|---|---|---|---|---|---|---|---|---|---|
| `globe` | 11.7 | 1 | 58 km, 5 px | 58 km, 5 px | 74 km, 6 px | 0.0092 | 2 px, 0 | 0 | 0.90 |
| mid zoom (camera 2,000 km) | 1.17 | 0.63 | 15 km, 13 px | 32 km, 28 px | 57 km, 49 px | 0.0051 | 20 px, 1 | 0.20 | 0.60 |
| `regional`, R1 (873 km) | 0.51 | 0.13 | 9 km, 18 px | 19 km, 38 px | 34 km, 67 px | 0.0030 | 45 px, 1 | 1 | 0.20 |
| `regional`, R4 and R5 (306 km) | 0.18 | 0 | 8 km, 42 px | 16 km, 88 px | 28 km, 156 px | 0.0025 | 129 px, 1 | 1 | 0.09 |
| `iss` | 0.23 | 0 | 8 km, 32 px | 16 km, 67 px | 28 km, 119 px | 0.0025 | 99 px, 1 | 1 | 0.09 |
| `window`, nearest ground | 0.30 | 0 | 8 km, 25 px | 16 km, 53 px | 28 km, 94 px | 0.0025 | 78 px, 1 | 1 | 0.09 |
| `window`, target | 0.43 | 0.07 | 8 km, 19 px | 18 km, 41 px | 31 km, 72 px | 0.0028 | 53 px, 1 | 1 | 0.15 |

The glow profile has a hot core: its light falls to half at about 0.3 of the glow radius and to a
tenth at half of it, so near the floor a glow of 1 to 2 `r` reads as a disc of 0.5 to 1 `r`, and
the cloud light under it ends at 1.5 `r` at the 400 km floor along its long axis, with about 9 % of its centre left at `r`.

Physical scale and compensation:

- Positions, footprints, energies and durations keep their measured values at every pose; channel
  lengths are physical; channel heights follow [Observed, procedural, assumed, styled](#observed-procedural-assumed-styled).
- Compensation only applies where the footprint is a few pixels: the 4 times glow and the point
  size from afar, the pixel width of channels and halos, and the bloom. Near the floor the glow is
  1 to 2 footprints at 15 % of its level and the bloom 10 % of the globe's.
- Each flash flickers for its observed duration in wall clock time, so at 60× a storm view shows
  about a minute of flashes at once ([flash profile](flash-profile.md)). Overlaps there blend by
  distance: below 1 km per CSS px the brightest glow sets each pixel, so a cell never piles up into
  a white ball; from 1 km per CSS px glows screen-blend, so points still accumulate softly. From 0.7
  to 1 km per CSS px (`k` from the camera height, times `h / 1080` on phones) a screen-blended copy
  weighted `1 - m` is drawn under the max-blended glows, `m = 1 - smoothstep(0, 1, ln(k / 0.7) /
  ln(1 / 0.7))`: a lone glow on the dark keeps its light and an overlap brightens smoothly from its
  brightest flash to its screen sum, so zooming across never pops (rule 3). The copy is drawn only
  in that band. The cloud light keeps the brightest flash, and bloom, cloud light and the near-floor glow scale with
  how dark the scene is, so overlaps and sunlit clouds never turn white.
  At replay speed, channels and near-floor sprites go to a seeded sample of the flashes sized for
  the speed (about 50 / 20 / 8 within their flicker at once at 60× / 600× / 3600×); every flash
  still lights the cloud ([overlaps in a storm view](flash-profile.md#overlaps-in-a-storm-view)).

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

At 600× and 3600× that renderer kept the 500 newest flashes, which held the frame cost at 10 to 15 ms
on R1 but cut every flash short and left 12 % (600×) and 22 % (3600×) of near white pixels at `iss`.
Since ADR 0033, every flash lights the cloud and a sample is drawn in full: measured in
[Lightning look validation](#lightning-look-validation).

## Surface detail

The pyramid of [ADR 0022](adr/0022-surface-imagery.md) loads through
[`web/src/globe/detail/`](../web/src/globe/detail/) (#252): tiles wanted per layer by the 2 px rule at
their nearest visible point, requested after 300 ms and never while the camera climbs, most blurred
area first, 6 at once and 8 per second after a burst of 40; a GPU byte budget (96 MB, 40 MB on
phones, none at `low`) evicts the least recently drawn; 404 shows the parent, 429 and errors back off.

The Earth shader draws it in one pass (#253):

- **Tile array.** Loaded tiles live in one sRGB texture array with mipmaps, as many layers as the
  budget holds (88 on desktop, 36 on phones), allocated when the first tile is needed. Each tile goes
  to the GPU through a scratch texture whose mipmaps the GPU builds, then every level is copied into
  its layer.
- **Page table.** One cell per level 5 tile (192 × 96), for day and night: the layer and level shown
  there and the one it fades from; level 0 is the global texture. The fragment finds its cell from
  its longitude and latitude and samples the tile with the derivatives of those coordinates: day
  bilinear with the water mask in alpha, night with the cubic B-spline.
- **Fades.** Every change of source in a cell, finer or coarser, fades over 400 ms, including back
  to the global texture when the camera climbs.
- **Brightness.** Tiles are scaled to the linear mean of the 4k textures over each level, measured on
  every tile: 0.98 by day, and by night (red, green, blue) 0.98, 0.99, 1 at level 2, 0.95, 0.97, 1 at
  level 3 and 0.91, 0.95, 0.99 at level 4. The pyramid was downsampled from 15″ in sRGB, so its finer
  night levels held up to 9 % more red light than the globe.
- **Seams.** Coordinates come from the point itself rather than the mesh UVs, which bend near the
  poles, and the longitude derivative wraps at the antimeridian, so no line of coarse texels runs
  along it. Blue Marble itself changes at 180° at high latitudes (also in the 4k texture).
- **Fallback.** `low`, offline renders and `?surface=base` (development and PR previews) keep the
  global textures only.

Measured 2026-10-29 on a local build against production data, five storms, clouds on, afterglow 0,
with `bench.mjs --journey` (pan of 2° at `iss`, then back to `globe`), tiles and base run back to
back per storm:

| | Tiles | Base |
|---|---|---|
| First load, Earth | 1.33 to 2.26 MB | 1.02 MB |
| Framing and dive to `iss` | 0 to 0.24 MB | 0 |
| Pan at `iss`, `iss` to `window` | 0 to 0.06 MB, 0.01 to 1.0 MB | 0 |
| Back to `globe` | 0 | 0 |
| GPU textures and buffers | 332 MB desktop, 244 MB mobile, once a tile was needed | 235 MB, 203 MB |
| Draw calls | 28 at every pose | 28 |
| Tiles loaded but never drawn | 0 | |
| Frame cost p95, desktop, same page, modes alternated 6 times | +0.1 to +0.4 ms (R2 `iss`, R1 and R5 `window`) | |
| Frame cost p95, mobile emulation, median of all poses | 5.2 ms, tier `medium` | 5.1 ms |
| 3 s flights | no interval over 50 ms | same |

Separate page runs swung by 3 ms between repetitions (median p95 15.1 ms with tiles, 13.3 ms base,
other GPU jobs on the Mac), so the cost is measured in one page with the modes alternated. The
prototype of #252 drew patches over the globe and cost about 2 ms more. [`spike/surface/stress.mjs`](https://github.com/pierregc/scintille/blob/87e41af/web/spike/surface/stress.mjs)
(rapid flights, repeated dives, missing tiles, 429, offline) kept the globe whole, the tile array
full but never over it (88 and 36 layers), the JS heap flat (37.3 MB desktop, 36.3 MB mobile) and
no page error.

Captures in [`immersive/surface-detail/`](immersive/surface-detail/): `R1-poses.jpg` and
`R5-poses.jpg` (`globe`, `regional`, `iss`, `window`, base above and tiles below, clouds on),
`R5-horizon.jpg` (horizon view, clouds off) and `seams.jpg` (100 % centre crops, clouds off: the
corner of four tiles of every level at 45° N 0° by day and by night, the antimeridian at 65.6° N,
the south pole).

## Observed, procedural, assumed, styled

Observed: measured by the satellites. Procedural: drawn from a seed within stated bounds where nothing
is observed. Assumed: a fixed physical value where nothing is observed. Styled: chosen for the look,
against what physics alone would show, within the bounds of
[ADR 0030](adr/0030-bounded-aesthetic-license.md). The lightning rows are recorded in
[ADR 0033](adr/0033-lightning-looks-and-density.md) and detailed in the [flash profile](flash-profile.md).

| Element | Status | Source in the renderer |
|---|---|---|
| Flash time, duration, source | Observed | Live and replay chunks |
| Flash position | Observed, within about 8 km (GLM) or 4.5 km (LI) | `FlashInstances` |
| Flash footprint area | Observed (illuminated cloud top area) | `flashShape.y`, radius `r = √(area / π)`, at least 3 km |
| Flash brightness | Observed energy, normalized | `intensityBrightness` |
| Flash kind: seven looks | Procedural, seeded, not a classification: cloud-to-ground 30 % of seeds (negative multi-stroke 19 %, single-stroke 7 %, positive 3 %, bolt from the blue 1 %; observed band 15 to 40 %), cloud-to-air 3 %, crawlers for the flashes observed ≥ 600 ms or ≥ 1,500 km², trunk and fan for the rest; drawn once per flash on the CPU with its leader and spread times | `flashKind`, `KIND_SHARES`, `CRAWLER`, `flashLook` |
| Strokes and pulses, flicker up to 2 s | Procedural, seeded by kind, in wall clock time within the observed duration (clamped to 60 ms to 2 s): one stroke for a quarter of negative and 81 % of positive cloud-to-ground flashes, otherwise 2 to 12, 10 to 400 ms apart (57 ms in geometric mean; 94 ms for positive flashes), spread up to 2.3 times in flashes over 0.9 s; continuing current 20 to 30 % for 40 to 300 ms in 15 to 75 % by kind; single-stroke in-cloud activity 12 to 18 %; in-cloud 0, 1 or 2 to 3 bright pulses (25 / 45 / 30 %), a 35 to 50 % swell without one, 12.5 ms stutters in the last half; crawlers steady at 25 to 35 %, never flickering; about half of all flashes do not flicker | `flashProfile`, `flashStroke`, `PROFILE` |
| Leaders, return stroke, darts | Styled timing of procedural paths: cloud-to-ground leaders at 1 × 10^5 m/s (1.5 × 10^5 for a bolt from the blue), the slow bound of the observed speeds, at 12 % of the stroke, 50 to 150 ms (150 to 250 ms for a bolt; real 20 to 40 ms) and at most half the flicker; in-cloud trunks at 2 × 10^5 m/s (10 to 20 ms), fans at 8 × 10^4 m/s within 80 % of the flicker, crawlers at 1 × 10^5 m/s with a lit tip; pace 0.75 to 1.35 per flash; the first stroke fills the channel from the ground up over 33 ms, two frames (real: microseconds); darts down the trunk in 40 ms at 30 %; branches die first (60 ms) | `leaderSeconds`, `spreadSeconds`, `flashTiming`, `spread`, `ribbon.glsl.ts` |
| Light drift within the footprint | Procedural, seeded: the light of in-cloud flashes drifts within 0.6 `r` of the observed position along the heading of their first drawn leader, and averages back to it | `cloudDrift`, `CHANNEL.drift` |
| Channel path, cloud-to-ground | Procedural, seeded, within the footprint: origin 6 to 8 km over 0.5 `r`; negative: a feed of 0.2 to 0.5 `r` along the heading, a drop to a strike 2 to 8 km sideways inside `r`, within 25° of the vertical for 85 % (25 to 40° otherwise), 0.6 of the path roughness (about 15° per segment), 3 to 12 branches (1 to 3 for single-stroke) leaving it 1.5 to 5 km up on every side at 15 to 35° (80 %) or 40 to 65°, at least 35° below the horizontal, ending 0.3 to 2 km above the ground, a second ground contact in 40 % of multi-stroke flashes 1 to 4 km from the first foot; positive: origin 9 to 11 km, run 0.8 to 2.2 `r`, drop at 30 to 45°, strike 0.6 to 1 `r` from the position; bolt from the blue: a trunk from 7 to 8.4 km to 9 to 10 km, run 0.5 to 1 `r`, exit at 8 to 9 km, descent at 45 to 60° to a strike 5 to 12 km away inside `max(r, 8 km)` | `channelSkeleton`, `SKELETON`, `KIND` |
| Channel path, in-cloud | Procedural, seeded, within the footprint: trunk and fan: a steep trunk climbing 3 to 5.5 km at 5 to 25° from the vertical, then 1 to 3 fans within `min(1.4 r, 8 × 10^4 m/s × 0.8 × flicker)` with 0 to 5 branches (filament 20 %, branching 30 %, network 50 %); crawlers 0.8 to 1.1 `r` both ways; cloud-to-air: the first fan leaves the cloud over its outer 30 to 60 %, 1 to 3 km beyond the fan or up to 1 km over the top; deep paths in segments of at least 1.5 km | `channelSkeleton`, `SKELETON`, `KIND` |
| Channel heights | Assumed: cloud from 7 to 11.5 km, fans 8.5 to 11.5 km, trunks from 5-7 to 9-11 km, crawlers 6 to 8 km. Styled for cloud-to-ground channels: drawn 1.5 times as tall about the ground, their stem kept under 11 km (so negative ones run from 9 to 11 km down to the ground); in-cloud heights 1.0×. Where the clouds are in relief the part above 7 km is compressed under the drawn top (to at least 30 %, ADR 0028, 0031) while a drop under it keeps its height | `SKELETON.cgHeightScale`, `SKELETON.maxOriginKm`, `reliefLift` |
| Channel light through the cloud | Observed cloud opacity on the line of sight (eased like the volume where it draws the clouds), assumed scattering: in the cloud a channel spreads over 0.5 km under the top to 4 km at the base, times the opacity, losing up to half its light, each short segment keeping its share of the spread (`max(length, core width) / spread width`). Styled: under the cloud a channel keeps at least 30 % of its light through any cloud; in-cloud trunks are a crisp trace, at most 2 core widths and at least 30 % (physics: 0 %, from orbit a channel shows only in clear air); over sunlit cloud channels keep 30 % (physics: none) | `veil.ts`: `VEIL`, `cloudVeil`, `veilOverlap`, `clearAirLight`; `CHANNEL.dayLevel` |
| Channel cores and halo on screen | Styled: joints cross-faded in screen values, each segment's cross-fade adding up to its length and given back the light its overlaps used to add (channels keep 92 to 102 % of their former light), no core thinner than 1.25 device px, so threads never bead; a halo on clear-air main channels and trunk traces, 8 core widths at 30 % of the core, cool only | `RIBBON`, `lengthShare`, `overlapGain`, `overlapTone`, `vTint` |
| Flashes drawn in full by replay speed | Styled rendering budget, not a classification: every flash lights the cloud at full level for its observed duration, uncapped; channels, near-floor sprites, halos and sound go to a seeded sample of about 50 / 20 / 8 flashes within their flicker at once at 60× / 600× / 3600× (all of them at 1× and on quiet storms; bands 30 to 100, 12 to 30, 5 to 12), stronger flashes up to 2.5× likelier and cloud-to-ground kinds 2.5× likelier than in-cloud ones, whose channel the cloud mostly hides, fading out over the next 10 % of the share, the share following the load over 0.5 s and set at once on a seek or a speed change; the others keep a point from afar (farness 0.7 to 1) and half a sprite where no cloud light shows, both among the 500 newest, so on the `low` tier at 600× and 3600× most flashes outside the sample draw nothing | `DENSITY`, `heroLot`, `heroShare`, `pointWeight`, `lightning.stats` |
| Round glow near the floor, by day, and where glows overlap | Styled: 15 % of its level at the floor (40 % where no cloud light shows), 35 % of that over sunlit cloud (physics: none), easing back from 0.3 to 1 km per CSS px to the far view's 40 % to full ramp; in a storm view below 1 km per CSS px overlapping glows keep the brightest, never add up, cross-fading to screen blending from 0.7 to 1 km per CSS px; while a channel of the sample shows, it steps back to 40 % (10 % with a halo, and only as much as the cloud lets a ground channel through) or 25 % in cloud; bloom radius 0.4 at the floor | `ZOOM.nearGlowLevel`, `ZOOM.glowLevel`, `nearFloor`, `maxBlendShare`, `CHANNEL.glowDayLevel`, `CHANNEL.glowDip`, `BLOOM.nearRadius` |
| Cloud light shape | Styled about the observed footprint, at the observed energy: an elongated, irregular patch along the flash's drift or, for a ground flash, its drawn in-cloud feed (long over short axis 1.4 to 2.2, edge lobed by 0.18 and 0.10), the whole of it during the flash's pulses and 0.65 of it between them, its farthest point at `(1.3 + 1.7 w) r` (1.5 `r` at the 400 km floor) at `0.35 + 0.65 w` of its level; shaped by the styled columns (a band of 3.5 km half width 3 km under each top above 11.5 km, at 8.5 km otherwise, 1.8 times the flat layer's level), read sharpened by up to 1.25 near the floor, 35 % of it over sunlit cloud (physics: none); in storm views overlaps keep the brightest, never add up | `CLOUD_LIGHT`, `LIGHT_WINDOW`, `cloudPatch`, `flashBand`, `glowDepths` |
| Cloud top 12 km, cloud shell 13 km | Assumed, for the flat layer seen from afar and where no height is published; the shell sits over the channels' tops so flashes start inside the clouds (styled, [ADR 0035](adr/0035-lightning-inside-clouds.md)) | `CLOUD_TOP_KM`, `CLOUD_SHELL_KM` |
| Cloud opacity | Observed IR, converted (ADR 0007), with visible detail by day (ADR 0023); about 1 km, 0.5 km by day around strong storms (ADR 0037), 2 km at night outside Europe and Africa, hourly | Composite frames and detail tiles |
| Cloud-top height | Observed IR matched to the GFS temperature profile (ADR 0028); 2 km, about 1 km median difference with GOES ACHA on opaque tops, thin cirrus placed too low | Height tiles, `volumeField` |
| Cloud base and thickness | Assumed: 0.7 to 1 km for low tops, 1.5 km for thin high clouds, 2.5 km for anvil edges, down to 1.5 km above sea level inside storms | `volumeColumn` |
| Tops of semi-transparent edges of high systems | Assumed (ADR 0031): lifted toward the nearest opaque plateau inward, as infrared places them too low | `styleFragmentShader` |
| Cloud detail: swell, billows on rising or rough tops, streaks on thin and fraying edges, visible dips as depressions | Styled (ADR 0031), chosen from the observed neighbourhood: cover over 4 km blocks within 0.05 of the observed on average and 0.1 per block, saturated tops within 1 km | `styleFragmentShader`, checked by `cloudVolume.styleCheck()` |
| Translucency, glow of flashes inside | Styled (ADR 0031): drawn as observed up to 0.5, eased to 0.95 at full cover; flashes under them veiled as if eased to 0.8, so they show through; brightness follows the real depth, sunlit tops kept below white by a highlight shoulder; the glow rises and fades in real time, outside the history | `capOpacity`, `veilOpacity`, `scatterGain`, `compositeFragmentShader` |
| Sunlight, shadows on the clouds and on the ground, relief shading, haze | Procedural, on the assumed columns; at every height dense clouds shaded by their observed broad shape at the scale of the screen, slopes 3 to 7× steeper, sun at most 45° high (styled, [ADR 0034](adr/0034-one-cloud-relief.md)), and by the shadows of taller clouds; the flat layer's colour and haze for the volume too; cover sharpened close up (styled) | `sunFragmentShader`, `reliefFragmentShader`, `marchFragmentShader`, `reliefFieldGlsl`, `cloudShadowAt`, `atmosphere.glsl.ts` |
| Ground | Observed imagery, 2004/2016 composites | Blue Marble, Black Marble |

## Clouds in relief

Below a camera height of 1,800 km the flat cloud layer gives way to a volume (#312,
[ADR 0028](adr/0028-cloud-relief.md), [ADR 0030](adr/0030-bounded-aesthetic-license.md),
[ADR 0031](adr/0031-cloud-look.md), [ADR 0034](adr/0034-one-cloud-relief.md)); the two crossfade up
to 2,800 km, the flat layer keeping the cover the volume hands over. At every height, from the whole
globe to the floor, both are shaded by the same relief light of the broad shapes, drawn at full
resolution, and the flat layer by the shadows of taller clouds. Where no height is observed, the
volume draws nothing and the flat layer stays, unshaded, pixel by pixel; it leaves a pixel to the
volume only where heights are known both on it and where its line of sight comes down to 0.5 km, so
an oblique view never looks through a gap between the two. Diagnosis, before and after
captures and the comparison with ISS photographs are in [cloud look](cloud-look.md).

- **Data**: each composite frame carries cloud-top heights for levels 3 and 4 in its tile pack
  ([data contract](data-contract.md#cloud-detail-tiles)), loaded by a second tile cache (80 layers),
  level 3 however far the view; storm packs keep level 4 only, which is loaded from afar in place of
  level 3.
- **Bake**: seven nested windows of 512² texels (0.5, 1, 2, 4, 8, 16 and 32 km), in half floats:
  the 0.5, 1 and 2 km windows around the ground below the screen centre (40 % of the half-height,
  at most 400 km from it), the others around the screen centre; the march reads the first five.
  The 0.5 km window is baked only while level 6 storm tiles are loaded there
  ([ADR 0037](adr/0037-storm-cloud-detail.md)), and the relief light never reads it. Three passes: the
  observations (blended opacity, top, convective core, heights known; texel means from 4 km up),
  their styling from the neighbourhood (hashed noise, never finer than 2.5 texels), and the sunlight
  through the other columns at the ground and at each column's own top, with the sky each dense top
  sees in the three finest windows, whose cover is also sharpened against its ring of neighbours.
  Every window adds the relief light of the broad shape, from its dense tops spread over 1.5
  texels, and the sunlit share of each top. A window is baked again when its
  place, frames, tiles or sun change (at most one every other frame); windows fade into each other
  near their edges. Above the march only the coarse windows are baked, one at a time, and a window
  moves only once the view has gone 32 of its texels.
- **March**: half the CSS resolution, a quarter of the pixels per frame, the rest reprojected at the
  depth the march returns; at most 48 crossings per ray (`high`) or 40 (`medium`). Each column
  crossing is integrated in one piece, sunlight falling with depth below the top in closed form, so
  the picture does not depend on where steps fall. While the view holds still, steps and rays get
  low-discrepancy offsets that a history averages ever more finely (down to 1/128 a ray), held
  within the sixteen rays around and shortened only where cover changes beyond what they disagree
  on, so the picture settles and holds. While it moves, rays stay in place, each new ray is spread
  over its neighbours and weighs 12 %, and the history is clamped to the four rays around, so cloud
  edges do not sparkle. Flashes light the cloud around them from the flash light map, added in the
  composite so the glow is never delayed. Sunlit tops take the flat layer's white and its √(sin
  elevation) dimming, and under a high sun the exposure comes down; a highlight shoulder keeps them
  below white. The composite draws the relief light at full resolution after the shoulder, at every
  height, where the line of sight crosses the tops the field holds; the march keeps the light
  through the columns, the walls and the sky. The atmosphere hazes the volume as it hazes the flat
  layer.
- **Ground**: the Earth shader darkens sunlight by the baked transmittance at the ground.
- **Tiers**: `high` (half the CSS size) and `medium` (0.4); `low` and phones keep the unshaded flat layer
  until a real phone is measured. In development and PR previews, `?clouds=flat|columns` and
  Shift+C compare with the flat layer and with the columns without styling, and
  `cloudVolume.styleCheck()` measures the styling against the observations.

The first measurements below are those of ADR 0028's volume; ADR 0031 records the new ones.

Measured 2026-10-29 on a local build with the reference hours rendered again with heights,
desktop profile, Chromium headless on the reference Mac (60 Hz, noisier than the headed runs of
the budgets):

| | Flat layer | Volume |
|---|---|---|
| Frame cost p95, `regional`, `iss`, `window`, five storms, best of two interleaved runs | 10.5 to 15.7 ms | 10.9 to 15.8 ms (median difference +0.3 ms, from −1.4 to +1.7) |
| GPU textures and buffers | 340 MB | 366 MB |
| Transfer at `regional` | 3 to 113 kB | 135 to 247 kB (height tiles) |
| Near white pixels | at most 1.4 % | at most 1.7 % (R1 `iss`) |
| Nadir opacity with the styling, 3.8 km blocks, five storms at `iss` | | bias +0.009 to +0.018, mean difference 0.026 to 0.031 |

Captures in [`immersive/relief/`](immersive/relief/): `R5-window.jpg` (day, low sun),
`R2-iss.jpg` (day, from above: flashes seen through the anvil), `R1-window.jpg` (night: flashes
light the clouds from inside) and `views.jpg` (horizon view, `window` over the Amazon), the flat
layer on the left. `prototype.jpg` is the prototype the ADR was decided on.

## Scene time

One clock drives the scene (`SceneClock`). Each layer shows observations, never a picture made up
between them, and says how far they are from the scene when it matters
([`scene-time.ts`](../web/src/globe/scene-time.ts), #255).

- **Observed time.** The time of the newest flashes drawn: the clock in replay; in live, the clock
  minus the slowest delay among the open storm's sources (`LIVE_DELAY_MS`, GLM 70 s, LI 12 min),
  or the fastest one on the globe. Ages are measured from it.
- **Storm position.** The latest track sample at or before the observed time, never interpolated.
  Samples come once per hourly window: up to 90 min old the position is shown with its age, then
  as "No position since". Nothing is shown before the first sample.
- **Clouds.** Frames within 90 min of each other crossfade; across a wider gap (missing frames) the
  nearest frame is shown alone; beyond 3 h the layer hides.
- **Live and replay.** Leaving a storm returns to the wall clock at 1×, the live clouds and no
  selection; browser history reopens the storm at its time, speed and pause state. Layer switches
  are kept.

Fixtures: [`scene-time-cases.json`](../web/src/globe/scene-time-cases.json) (delayed sources, old
clouds, missing frames, absent positions, scrubbing) and the round trip test in
[`round-trip.test.ts`](../web/src/globe/replay/round-trip.test.ts).

## Current renderer

Audit of `main` at b1b35cf with the lightning look rework (#399 to #407, validated in #408):

- Camera: orbit controls down to 0.2 Earth radius (1,274 km), then the surface camera
  (`surface.ts`): 400 km floor (#126), free tilt from straight down to 90° (ADR 0032). Zooming in
  stops at the floor without changing the tilt; flights are lifted to the floor where their path
  would dip under it. Storms are framed at 45° (#406). Clip planes follow the closest shell
  (`orbit.ts`).
- Earth: one global texture set per tier (2k, 4k, 8k on disk; the globe loads 4k on medium and
  high), with surface detail tiles near the floor (ADR 0022).
- Clouds: one shell at 13 km, 2k or 4k frames, bicubic on medium and high, in relief near the floor
  (ADR 0028, 0031), lit from inside by a flash light map of 1024 × 512 texels on `medium` and
  `high`, none on `low`.
- Lightning: every flash in the display window (up to the 262,144 flash ring) lights the cloud and,
  outside storm views at replay speed, keeps an instanced glow; in a storm view at replay speed, a
  seeded sample of about 50 / 20 / 8 flashes at once (60× / 600× / 3600×) is drawn in full
  ([ADR 0033](adr/0033-lightning-looks-and-density.md)), and the other flashes keep a glow only as
  points from afar and, among the 500 newest, as half sprites where no cloud light shows.
  Each flash has one of seven kinds, drawn once on the CPU with its leader and spread times
  (`flashLook`). Channels are CPU skeletons of up to 256 segments for the 384 newest flickering
  flashes of the sample, at most 24 built per frame; a halo follows clear-air main channels and
  trunk traces, fading out above 256 channels and from 1,500 to 6,000 km. Near the floor the glow
  drops to 15 % and storm views keep the brightest overlapping glow below 1 km per CSS px. Exposure
  1.6; bloom strength 0.9, tightening near the floor ([Lightning scale](#lightning-scale)).
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
   The share of flashes drawn in full at replay speed is not an exposure but a named, deterministic
   sampling: it picks which flashes show their channel, never how bright the scene is drawn
   ([ADR 0033](adr/0033-lightning-looks-and-density.md)).
7. **Heights.** In-cloud channels stay between 6 and 11.5 km (fans 8.5 to 11.5, trunks from 6-8 to
   9-11, crawlers 6 to 8), cloud-to-ground channels run from 6 to 11 km down to the ground, drawn 1.5
   times as tall with their stem kept under 11 km (`cgHeightScale`, so from about 9 to 11 km), and
   only cloud-to-air leaders leave the cloud, at most 1 km over its 11.5 km top (ADR 0033). Any height
   exaggeration is at most 2.5×, named in the methodology; only that 1.5× is used.
8. **Camera floor.** The camera stays at least 400 km above the ground in every mode: zoom, tilt,
   flights and storm framing.
9. **No visible pixels at the floor.** At the nearest visible point, a ground texel covers at most
   2 CSS px and a cloud texel at most 4 CSS px, with bicubic filtering for clouds.
10. **Storm views without afterglow.** While a storm is open, picked on the live globe or followed,
   the afterglow is 0: each flash shows its flicker and a fade of about a second, then leaves no trace.
11. **Real time flicker.** A flash flickers for its observed duration, up to 2 s, in wall clock
   time at any replay speed, in the pattern of its kind: strokes 10 to 400 ms apart (57 ms in
   geometric mean, as between real strokes), one stroke for a quarter of negative and 81 % of
   positive cloud-to-ground flashes, 0 to 3 bright pulses in cloud, crawlers steady; each stroke or
   pulse rises within one frame and decays over tens of milliseconds. About half of all flashes do
   not flicker. Replay speed only compresses the gaps between flashes.
12. **No false precision.** Flash positions are not interpolated or snapped. Surface and clouds
   keep their sources' values at the sources' scale; below it they may carry styled detail within
   the bounds of [ADR 0030](adr/0030-bounded-aesthetic-license.md). Magnification never sharpens,
   except cloud edges within those bounds ([ADR 0034](adr/0034-one-cloud-relief.md)).

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

## Final validation

Measured 2026-10-29 on production (scintille.app, `main` 7ccf560) with `bench.mjs`, Chromium headed
on the reference Mac, five storms, clouds on, afterglow 0. Cold is a fresh browser profile, warm
opens the storm once before measuring (`--warm`), 4G throttles the phone run (`--network 4g`, 9 Mbit/s,
150 ms). Raw results and captures in [`immersive/validation/`](immersive/validation/); the phone run
after #332 and #333 (PR preview, same data) is `bench-mobile-cold-phone-budgets.json`.

| Budget | Desktop | Mobile emulation | Verdict |
|---|---|---|---|
| Frame cost p95 ≤ 10 ms, tier kept | 7.4 to 9.6 ms, `high` | 4.6 to 9.1 ms, `medium` | met |
| 3 s flights: no interval over 50 ms, p95 ≤ 17 ms | max 17.6 ms, p95 ≤ 10 ms | max 10.4 ms | met |
| GPU textures and buffers | 332 MB (≤ 384) | 244 MB (≤ 256) | met |
| First load, cold | 6.3 to 9.7 MB (≤ 10) | 6.7 to 8.4 MB (≤ 8): R1 8.36, R2 8.33; 5.3 to 6.2 MB since #332 | met since #332 |
| First load, warm | 0.02 to 1.1 MB | 0.01 to 1.0 MB | met |
| First load, 4G | | 5.7 to 6.4 MB settled in 9.6 to 14.5 s, globe ready 1.2 to 7.0 s | checked |
| Time to globe, to storm framed | 0.38 to 0.62 s, 3.7 to 4.4 s; 1.2 to 3.5 s ready when the page itself is slow (TTFB 0.5 to 0.7 s) | 0.40 to 0.84 s, 3.6 to 5.2 s | met, network outliers |
| Zoom `globe` to `iss` and back | 0.13 to 1.08 MB, back 0 | 0.03 to 0.31 MB, back 0 | met |
| Near white pixels ≤ 2 % | at most 1.4 % (R1 `iss`), unchanged by #333 | 3.8 % R1 `iss`, 2.4 % R1 `window` and R3 `iss`; at most 1.6 % since #333 | met since #333 |

Journeys (globe, Follow, Horizon, back to live), one capture every few seconds:
`R1-journey.jpg` to `R5-journey.jpg` (desktop, night R1 and R3, day R2, R4 and R5),
`touch-R1-R5.jpg` (phone: Follow, drag, pinch, Follow again, Horizon, back to live) and
`live-follow.jpg`, `live-horizon.jpg` (a live day storm with the composite clouds).

Findings:

1. **No tile pops, clipping or camera jumps** in the journeys; flights stay smooth and the fly out
   to the live globe is continuous.
2. **Reference storms show 8 km clouds at the floor.** Cloud detail is kept one day, so replays of
   2026-10-18 fall back to GMGSI: blurred blobs by day at Follow (R2, R5). Live storms show the
   composite detail (#331).
3. **Night glows read large on phones** (R1, R3) and exceed the near white budget (#333). Fixed:
   phones now draw lightning at the desktop scale ([Lightning scale](#lightning-scale)).
4. **HUD text fades over sunlit clouds** near the floor (#334).
5. **Phone gestures over the HUD zoom the page.** The replay caption and the gaps between the storm
   buttons now let gestures through to the globe; the clock, layers and timeline blocks remain (#335).
6. A real phone is not measured yet: the frame interval p95 ≤ 33 ms on a phone needs a device.

## Lightning look validation

Measured 2026-10-31 on the nine tickets of the lightning look rework merged together (#399 to #407,
#408), against production data through a local dev server, with `main` (b1b35cf) measured the same
evening on the same Mac. That Mac also ran another project, so frame costs are noisy: they are compared
run against run, best of two interleaved runs. After review (2026-11-01) the light map of `high` went
back to 1024 × 512 and the lit patch took its own seeded draws along the ground channel's feed; the
matrix, the stepped frames and GPU memory were measured again on that build (7491b7c), the frame
costs, the `low` tier and the phone captures were not (the change does not reach `low`, and changes
only per-flash patch shapes on the phone's `medium`).

**Captures.** The matrix of #398 (C0 to C21 and its variants) with `capture.mjs --frames 4 --gap 700
--settle 12 --stats` at 1,600 × 1,000 on `high`, the size of the baseline report so the metrics
compare; the leader and reduced-motion frames with `--step 50` (and `--at` for the bolt from the blue of
C16L). One frame per capture is in
[`immersive/lightning-look/matrix/`](immersive/lightning-look/matrix/) with every frame's metrics and
`lightning.stats` in `measurements.json`; the before and after sheets against `main` are in
[`immersive/lightning-look/408/`](immersive/lightning-look/408/); the baseline report of the rework and
its research notes are in [`analysis/lightning-look/`](analysis/lightning-look/).

| Target of #398 | Baseline report | `main`, same evening | Target | Measured |
|---|---|---|---|---|
| On-screen channel length steeper than 60°, tilt 45° / 20° (2,000 skeletons) | 4 % / 0.4 % | | ≥ 20 % / ≥ 8 % | 9.7 % / 1.2 % (cloud-to-ground 31.5 % / 5.0 %): not met |
| Cloud-to-ground channels reaching down in C2 (noon, 60×, oblique) | 0 | | ≥ 6 per frame | 6 to 10 short steep drops per frame, 10 to 30 px, faint over the sunlit deck |
| Leader visible over consecutive frames, C16L | never | | ≥ 3 frames | the bolt from the blue of C16L (00:31:57.375Z): 4 frames 50 ms apart, the stroke on the fifth (`stepped.C16B` in `measurements.json`, `c16l-bolt.jpg`) |
| Flashes that do not flicker | about 0 | | 45 to 55 % | 54.4 % of Basse-Kotto's 212,695 flashes, 54.7 % of Amazonas' 222,356, 54.0 % of R1's 77,558 (their observed durations and areas through the app's own draws; 52 % on the synthetic set of `profile.test.ts`) |
| `stats.drawn`, C2 / C5 / C8 | about 45 / 30 to 40 stubs / 0 | | 50 ± 15 / 20 ± 6 / 8 ± 3 | 44 to 60 / 14 to 26 / 5 to 11 (bands 30 to 100 / 12 to 30 / 5 to 12; the first run had one C5 frame at 13, inside the band, outside 20 ± 6) |
| Near white at night, 600× and 3600× (C13, C18, C19, C21) | 1.7 to 36 % | 0.9 to 13.4 % | ≤ 2 % | 0 to 0.01 % |
| Near white at night, 60× (C17, C20) | 0.5 to 1.7 % | 0.55 to 1.79 % | ≤ 1 % | 0 to 0.01 % |
| Near white by day at `iss`, C3 / C6 / C9 | 1.6 to 2.6 / 5 to 13 / 2.5 to 31 % | 2.0 to 2.7 / 5.7 to 7.9 / 0.1 to 30.6 % | ≤ 1.5 / ≤ 2 / ≤ 2 % | 0.02 to 0.05 / 0 to 0.02 / 0 % |
| Lit radius of a lone flash, C15 | about 2 `r` | 1.98 `r` (#404) | 1.3 `r` ± 20 % | on a stroke or a bright pulse 1.21 to 1.25 `r` along the patch (1.23 to 1.28 `r` farthest), for one or two frames 10 ms apart; 0.71 to 0.77 `r` between pulses; a crawler, which never pulses, 0.81 `r`: met on pulses only (#404's procedure on this build, glows hidden; `lone` in `measurements.json`) |
| Separate lit cells along the line, C7 (noon) and C11 (15:30) | kept | kept (C7: a line of stubs and glows) | kept | C11 kept; C7 not met: at noon, 600× over a sunlit deck shows 2 or 3 marks |
| 600× and 3600× told apart, C5 against C8 | | | by channels and front motion | 14 to 26 against 5 to 11 channels; the front moves 27 min against 2 h 38 min of scene over the four frames |
| Replay start, C0 | 03:30:02 | 03:30:02 | 04:00:06 | 04:00:06 |

**Budgets.** `bench.mjs --afterglow 0 --seconds 6` with clouds on, headless Chromium on the GPU (the
page runs at 60 Hz), desktop (1920 × 1080 at DPR 2) and `--profile mobile` (iPhone 15 emulation), on
R1, R2, R3, R5 and Basse-Kotto (12:00Z, added to a copy of `references.json`) at 60×, 600× and 3600×,
six poses each. This branch and `main` interleaved in two rounds on desktop (round A branch first,
round B `main` first), best of the two per pose; on mobile two rounds of the branch and one of
`main`. Frame cost p95 is GPU-synchronized; flights count the intervals over 50 ms that show in both
rounds; near white is the bench's paused screenshot after each flight.

Desktop (GPU memory with the 1024 × 512 light map of `high`, 7491b7c, measured on R1; textures and
buffers are the same at every storm and pose; frame costs and flights are those of the first run, with
the 2048 × 1024 map):

| Storm | Speed | p95 frame cost, worst pose (ms), this branch / `main` | Poses over 10 ms | Flights: worst interval (ms), intervals over 50 ms | Tier | GPU MB, this branch / `main` | Near-white, worst pose |
|---|---|---|---|---|---|---|---|
| R1 | 60× | 12.5 / 12.9 | 4 of 6 | 16.8, 0 (`main` 16.8, 0) | high | 383.1 / 378.7 | 0.0 % |
| R1 | 600× | 12.5 / 14.5 | 4 of 6 | 16.8, 0 (`main` 16.8, 0) | high | 394.3 / 389.9 | 0.0 % |
| R1 | 3600× | 12.2 / 15 | 4 of 6 | 133.3, 6 (`main` 133.2, 7) | high | 394.3 / 389.9 | 0.0 % |
| R2 | 60× | 12.2 / 12.1 | 4 of 6 | 16.8, 0 (`main` 16.8, 0) | high | 383.1 / 378.7 | 0.0 % |
| R2 | 600× | 12.4 / 13.9 | 6 of 6 | 16.8, 0 (`main` 16.8, 0) | high | 394.3 / 389.9 | 0.0 % |
| R2 | 3600× | 11.9 / 14 | 3 of 6 | 83.4, 8 (`main` 116.7, 8) | high | 394.3 / 389.9 | 0.0 % |
| R3 | 60× | 12.7 / 12.2 | 4 of 6 | 16.8, 0 (`main` 16.8, 0) | high | 383.1 / 378.7 | 0.0 % |
| R3 | 600× | 12.1 / 13.9 | 6 of 6 | 16.8, 0 (`main` 16.8, 0) | high | 394.3 / 389.9 | 0.0 % |
| R3 | 3600× | 12.3 / 15.1 | 6 of 6 | 133.2, 7 (`main` 133.4, 7) | high | 394.3 / 389.9 | 0.0 % |
| R5 | 60× | 12.1 / 11.5 | 4 of 6 | 16.8, 0 (`main` 16.8, 0) | high | 383.1 / 378.7 | 0.0 % |
| R5 | 600× | 12.2 / 11.8 | 4 of 6 | 16.8, 0 (`main` 16.8, 0) | high | 394.3 / 389.9 | 0.0 % |
| R5 | 3600× | 11.4 / 12.5 | 5 of 6 | 83.3, 7 (`main` 83.3, 8) | high | 394.3 / 389.9 | 0.0 % |
| BK | 60× | 12.8 / 13.6 | 5 of 6 | 16.8, 0 (`main` 16.8, 0) | high | 383.1 / 378.7 | 0.1 % |
| BK | 600× | 13.2 / 13.6 | 4 of 6 | 16.8, 0 (`main` 16.8, 0) | high | 394.3 / 389.9 | 0.0 % |
| BK | 3600× | 13.6 / 16.7 | 5 of 6 | 83.4, 10 (`main` 83.3, 10) | high | 394.3 / 389.9 | 0.0 % |

Mobile emulation:

| Storm | Speed | p95 frame cost, worst pose (ms), this branch / `main` | Poses over 10 ms | Flights: worst interval (ms), intervals over 50 ms | Tier | GPU MB, this branch / `main` | Near-white, worst pose |
|---|---|---|---|---|---|---|---|
| R1 | 60× | 9.4 / 11.1 | 0 of 6 | 16.8, 0 (`main` 16.8, 0) | medium | 248.1 / 243.8 | 0.4 % |
| R1 | 600× | 8.5 / 13.2 | 0 of 6 | 16.8, 0 (`main` 16.8, 0) | medium | 259.3 / 255.0 | 1.0 % |
| R1 | 3600× | 11.6 / 14.7 | 1 of 6 | 133.3, 5 (`main` 133.4, 6) | medium | 259.3 / 255.0 | 1.7 % |
| R2 | 60× | 7.4 / 7 | 0 of 6 | 16.8, 0 (`main` 16.8, 0) | medium | 248.1 / 243.8 | 0.3 % |
| R2 | 600× | 7.8 / 12.7 | 0 of 6 | 16.8, 0 (`main` 33.2, 0) | medium | 259.3 / 255.0 | 1.5 % |
| R2 | 3600× | 8.3 / 11 | 0 of 6 | 133.3, 5 (`main` 133.4, 6) | medium | 259.3 / 255.0 | 2.4 % |
| R3 | 60× | 8.3 / 6.9 | 0 of 6 | 16.8, 0 (`main` 16.8, 0) | medium | 248.1 / 243.8 | 0.0 % |
| R3 | 600× | 7 / 11.6 | 0 of 6 | 16.8, 0 (`main` 16.8, 0) | medium | 259.3 / 255.0 | 0.0 % |
| R3 | 3600× | 7.3 / 14.5 | 0 of 6 | 133.4, 4 (`main` 133.4, 5) | medium | 259.3 / 255.0 | 0.0 % |
| R5 | 60× | 6 / 5.9 | 0 of 6 | 16.8, 0 (`main` 16.8, 0) | medium | 248.1 / 243.8 | 0.0 % |
| R5 | 600× | 6.3 / 11.7 | 0 of 6 | 16.8, 0 (`main` 16.8, 0) | medium | 259.3 / 255.0 | 0.0 % |
| R5 | 3600× | 5.3 / 5.9 | 0 of 6 | 116.6, 5 (`main` 133.4, 7) | medium | 259.3 / 255.0 | 0.0 % |
| BK | 60× | 9.5 / 12.7 | 0 of 6 | 16.8, 0 (`main` 16.8, 0) | medium | 248.1 / 243.8 | 0.5 % |
| BK | 600× | 7.9 / 12.1 | 0 of 6 | 16.8, 0 (`main` 33.4, 0) | medium | 259.3 / 255.0 | 1.1 % |
| BK | 3600× | 9.6 / 15 | 0 of 6 | 83.3, 8 (`main` 83.3, 9) | medium | 259.3 / 255.0 | 1.6 % |

- **Frame cost.** On desktop neither build holds p95 ≤ 10 ms this evening (11.4 to 13.6 ms here, 11.5
  to 16.7 ms on `main`, against 7.4 to 9.6 ms in the headed runs of [Final validation](#final-validation)):
  the shared Mac and the headless page. Against `main` the branch stays within +0.6 ms at 60× and is
  0.4 to 3.1 ms cheaper at 600× and 3600×, where the sample skips the profile of flashes it does not
  draw. On mobile emulation p95 ≤ 10 ms everywhere but one pose of R1 at 3600× (11.6 ms; `main` 14.7).
- **Tier** kept: `high` on desktop, `medium` on mobile, at every storm, speed and pose.
- **Flights.** No interval over 50 ms at 60× and 600×. At 3600× both builds hitch, 83 to 133 ms, 4 to
  10 intervals per storm: an hour of scene a second loads cloud frames during the flights.
- **GPU memory.** Within budget at 60×, over it at speed: desktop 383.1 MB at 60× and 394.3 MB at
  speed (`main` 378.7 and 389.9), mobile 248.1 and 259.3 MB (`main` 243.8 and 255.0). The branch adds
  4.4 MB of buffers on desktop and 4.3 MB on phones, the three `flashLook` floats per flash of the ring
  and per channel segment (#402); the 11 MB more at speed are cloud frames, on both builds. The
  2048 × 1024 light map #404 put on `high` added 3.1 MB (386.2 and 397.4 MB in the first run): #398
  kept it only within 384 MB, so `high` stays at 1024 × 512 (the patches read a little softer; C17
  shows no tiled texels at the design values). MSAA renderbuffers (8.3 MB) are not counted, as in
  every earlier figure.
- **Near white** on the paused screenshots: at most 0.1 % on desktop; on mobile at most 1.7 % but
  2.4 % at R2's `regional` frame at 3600× (`main` 3.5 %), where the far-view points of the 500 newest
  flashes merge on a phone's whole-storm frame (rule 1, unchanged by the rework). The capture matrix
  above measures the lightning while it plays.

What the pictures show:

- **The ball is gone.** At night the cells read as soft lit cloud with a few channels at every speed;
  no pixel reaches white where `main` whitens 1 to 13 % of the frame at speed. 600× is the breathing
  storm, cells separate along the line (C21); 3600× the travelling field with rare strokes on it (C19).
- **The night is 10 to 25 times darker at 60× too.** The lit share (luminance over 90) falls from
  `main` to this branch in every night view at 60×: C16 11.9-13.4 → 1.0-1.2 %, C17 22.4-30.4 →
  1.4-2.0 %, C20 15.3-17.1 → 0.5-0.7 %, C15 1.2-6.0 → 0.15-0.4 %. The sample is not the cause (C16
  and C17 draw 49 to 58 of their 51 to 66 flashes alive, C14 and C15 all of them): the glow at 15 %
  near the floor (#403) and the cloud light at 0.35 of its level with the dimmer splat between pulses
  (#404) are. Within the bands the brightest values (sprite 0.2, cloud light level 0.4, volume boost
  2.5, and sharpen 1.0) together lift it 2.3 to 3.7 times (C16 2.3-3.2 %, C17 5.0-6.3 %, C20
  1.7-2.1 %), each alone by 0 to 50 %; `main`'s 60× picture is out of reach inside the bands.
- **Speed changes the subject:** about 50, 20 and 8 flashes drawn in full at once; the same heroes on
  two loads of a share URL (C2, C5 and C8 paused at 12:00: the same hashed list of hero flashes).
- **Strokes unfold:** a leader comes down dim for four frames, the column whips white, branches die
  first (`c16l-bolt.jpg`); reduced motion shows whole channels with one soft fade (C16R).
- **Still mostly horizontal.** In-cloud fans, horizontal by nature and 55 to 60 % of the flashes, are
  most of the drawn length; cloud-to-ground drops are steep (31.5 % steeper than 60° at 45°) but short
  next to the fans. Reaching the targets would take shorter fans, more cloud-to-ground flashes or a
  higher `cgHeightScale` than its bound of 1.5.
- **Noon.** Over a sunlit deck, glows keep 35 % and channels 30 % of their light, the cloud light 35 %
  of what the deck's headroom leaves, and most flashes now glow between few pulses: at noon the storm
  is a few small marks at 60× and nearly nothing at 600× and 3600× (C5 to C9), where `main` showed the
  line of cells (`noon-main-vs-408.jpg`). That is the honest picture #398 accepted, judged at 15:30
  (C10, C11) and at night; raising the named day levels is the maintainer's call.
- **The cloud light at speed** reads as overlapping elongated patches (C18, C19, C21): the shape #404
  gives each flash. No value within the bands changes that (`tuning-variants.jpg`).
- **Phones** (`--profile mobile`, tier `medium`): near white 0 % at night and at most 1.3 % by day
  (`phone.jpg`). **`?quality=low`** (no light map): the sample keeps its sprite and channel, and every
  other flash a half sprite only while among the 500 newest. At 60× that is every flash (C16Q: 51 to
  53 drawn of 54 to 68 alive), but at 600× on R1 (C21Q) 1,444 to 1,575 flashes are alive, so about
  930 to 1,060 of them draw nothing (`quality-low.jpg`): on `low`, replay speed removes flashes,
  against ADR 0030 point 1. The cap is #399's: without it the points outside the sample cost 2.4 ms
  more at 3600×.

Tuning: none. Within their bands (sprite 0.1 to 0.2, sharpen 1 to 1.5, cloud light level 0.3 to 0.4,
volume boost 1.5 to 2.5, `VEIL.trace` 0.2 to 0.35), the variants only scaled the lit share without
changing the look: on the first build sharpen 1 doubled it at 600×, 1.5 halved it, level 0.3 and boost
1.5 dimmed it by 10 to 25 %, trace 0.35 changed nothing measurable; on the review build sprite 0.2,
level 0.4 and boost 2.5 each raised it by 0 to 50 % at 60× and all bright ends together 2.3 to 3.7
times (`tuning-variants.jpg`, `variants` in `measurements.json`). `cgHeightScale` is already at its
bound; every value stays at its design value ([ADR 0033](adr/0033-lightning-looks-and-density.md)),
and whether the night at 60× should be brighter than the bands allow is the maintainer's call.

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
reference afterglow, `--speed` plays at another replay speed than 60×, `--no-clouds` hides the
clouds, `--warm` measures a second visit and `--network 4g` or `slow4g` throttles the page. Active flashes count those started within a second of wall clock time, or within the
afterglow window.

In the page, `window.__app.lightning.stats` reads the storm view sample of the current frame
([flash profile](flash-profile.md#overlaps-in-a-storm-view)), counted from the flashes loaded when
it is read: `alive`, the detections within their flicker or fade; `drawn`, those of them in the
sample (all of them when `share` is 1); `load`, the estimate of `alive` over the last 0.4 s of wall
clock time the share is sized by; `share`, the applied share of the lots, and `target`, the flashes
it aims at (Infinity at 1×); `channels`, the flashes holding a channel slot, which includes those
fading out at the share's edge and merges a flash seen by two instruments.

`web/scripts/capture.mjs` captures a storm view while it plays, for looks rather than cost: a few
frames of one storm, time, speed and view, with the share of near white (every channel over 235),
lit (luminance over 90) and lit 8 × 8 blocks over the central 84 % × 76 % of the frame, and with
`--stats`, `lightning.stats` on each frame. `--no-clouds` hides the cloud layer so day frames measure
the lightning alone, `--reduced-motion` emulates `prefers-reduced-motion`, `--quality` sets the tier,
`--profile mobile` emulates the phone, and `--step 50` freezes the page's wall clock and moves it
50 ms per frame, so leader frames are exactly that far apart; with `--at <ISO>` the first of them
shows that scene time, to follow a given flash.

```sh
node web/scripts/capture.mjs --base http://localhost:4321 --storm 2026-10-27-basse-kotto \
  --time 2026-10-27T12:00:00Z --speed 600 --view 4.3,19.9,500,45 --stats --out captures/ --prefix C5
```

The capture matrix of the lightning look (C0 to C21, [Lightning look validation](#lightning-look-validation))
runs it against a dev server on production data.

Limits: memory is what the page asks WebGL for, not what the driver uses. Frame cost with
synchronization is an upper bound (CPU and GPU no longer overlap). Frame intervals follow the
display refresh. `--profile mobile` emulates a phone viewport on the desktop GPU and does not
replace a real phone. `--gl swiftshader` only checks that the script runs.

## Attribution

Reference images show NASA Blue Marble and Black Marble (credit NASA Earth Observatory), clouds from
NOAA NESDIS GMGSI (contains EUMETSAT Meteosat and JMA Himawari data), lightning from NOAA GOES GLM
and EUMETSAT MTG Lightning Imager (CC BY 4.0).
