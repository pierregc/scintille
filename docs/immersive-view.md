# Immersive storm view

Targets for the M5 dive from the globe into a storm ([ADR 0020](adr/0020-immersive-storm-view.md)):
reference storms and poses, scale, visual rules and budgets. M5 PRs that touch the scene compare
against this page and the baseline below.

## Reference storms

<!-- REFERENCE_STORMS -->

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

Heading is north. The storm centre is the track point closest to the reference time.

## Scale

1 world unit is the Earth radius, 6,371 km (`kmToWorld`). The vertical field of view is 35°, so
at a range `d` one CSS pixel of a 1080 px tall view covers `d × 0.000584` km at the centre; with a
tilt, that is across the view, and `1 / cos(tilt)` times more along it.

| Pose | km per CSS px | GLM pixel (8 km) | LI pixel (4.5 km) | Earth 4k texel (9.8 km) | Cloud 2k texel (19.6 km) | Glow, r = 8 km | Channel half length |
|---|---|---|---|---|---|---|---|
| `globe` (20,000 km) | 11.7 | 0.7 px | 0.4 px | 0.8 px | 1.7 px | 2.7 px | 1.5 px, floor 3 px |
| `regional` (1,500 km) | 0.88 | 9 px | 5 px | 11 px | 22 px | 36 px | 20 px |
| `close` (250 km) | 0.15 | 55 px | 31 px | 67 px | 134 px | 219 px | 120 px |
| `deck` (100 km) | 0.058 | 137 px | 77 px | 168 px | 336 px | 548 px | 301 px |

Glow radius is 4 times the observed radius `r = √(area / π)` at mid intensity (0.6 to 1.4 times
with intensity), at least 5 physical px. Channel half length is 2.2 `r`, at least 6 physical px.
At DPR 2, a physical px is half a CSS px.

What the table says:

- At `globe`, every source is at or below one pixel: flashes are points, compensation is required.
- From `regional` down, every source is magnified. At `close`, one GLM pixel is about 55 px and
  one Earth texel about 67 px: the 4k Earth and 2k clouds are soft blocks, and the glow (4 times
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

<!-- BUDGETS -->

## Baseline

<!-- BASELINE -->

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
cost with the GPU synchronized each frame), active flashes, draw calls, the largest instance counts
per draw, and the GPU memory the page allocated (textures, buffers, render buffers, drawing buffer).

Limits: memory is what the page asks WebGL for, not what the driver uses. Frame cost with
synchronization is an upper bound (CPU and GPU no longer overlap). Frame intervals follow the
display refresh. `--profile mobile` emulates a phone viewport on the desktop GPU and does not
replace a real phone. `--gl swiftshader` only checks that the script runs.

## Attribution

Reference images show NASA Blue Marble and Black Marble (credit NASA Earth Observatory), clouds from
NOAA NESDIS GMGSI (contains EUMETSAT Meteosat and JMA Himawari data), lightning from NOAA GOES GLM
and EUMETSAT MTG Lightning Imager (CC BY 4.0).
