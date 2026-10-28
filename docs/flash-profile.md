# Flash profile

How bright a flash is on screen over time. Implemented in `web/src/globe/lightning/profile.ts` (TypeScript
reference, unit-tested) and its GLSL twin used by the shaders. Sizes, channels and halos by zoom are in
[immersive view](immersive-view.md#lightning-scale).

## Two clocks

A flash starts at its observed time, in scene time. Its flicker then plays in **wall clock time**, whatever
the replay speed ([ADR 0020](adr/0020-immersive-storm-view.md)): replay speed compresses the gaps between
flashes, never a flash. At 60×, a minute of storm plays in a second, and each of its flashes still lasts
its observed duration on screen. At 1× and in live, both clocks are the same.

Wall clock age is scene age divided by the replay speed (`playback.ts`). When the speed changes during
play, flashes already lit keep the pace they started with. Pausing freezes both clocks, so a paused
frame shows the flashes of the last second of play at their current stage. Offline renders keep 1×.

## Flicker, then fade

1. **Pulses.** The flicker lasts the observed flash duration, clamped to 60 ms to 1 s. It holds pulses
   timed like return strokes: about 60 ms apart (log-triangular gaps from 10 to 200 ms, median 60 ms),
   as many as fit in the duration, at most 12. The first pulse has the full level; each later one is
   picked between 0.3 and 0.9 of it. Each pulse rises at once and decays with a time constant picked
   between 15 and 60 ms. The pattern is procedural and seeded by the flash position: only the start,
   duration, energy and footprint are observed.
2. **Shutter.** Each frame shows a pulse averaged over the last 1/60 s, like a camera shutter, so a pulse
   is never lost between two frames and its light reaches the screen whatever the frame rate.
3. **Fade.** A dim glow (12 % of the first pulse) rises over the flicker, then decays exponentially to
   exactly zero at the end of the flash life: 1 s, or the flicker plus 0.5 s for long flashes. At
   afterglow 0, the flash then leaves no trace.

The result is the brightest of the three. A short flash is one or two blinks; a long one crackles for its
whole duration before fading.

## Cloud-to-ground and in-cloud

A seed picks about 25 % cloud-to-ground looks (see [Channel](#channel)); the rest are in-cloud. Satellites
cannot tell them apart, so this split, like the patterns below, is procedural.

- **Cloud-to-ground** flashes flash in distinct strokes and go dark in between, as return strokes do. In
  40 % of them, the first or second subsequent stroke holds a continuing current: a steady 20 to 30 %
  glow for up to 250 ms, within the observed duration.
- **In-cloud** flashes glow between their pulses (21 to 35 % of the first pulse) while their leaders
  spread, and fade 80 ms after the observed duration.

Leaders light the channel as they go. In-cloud ones start from a fifth of the path and cover it by
80 % of the flicker, slowing down (`1 - (1 - t)²`); their light drifts along the channel from 0.6 radius
on one side of the observed position to 0.6 radius on the other, so it stays within the observed
footprint and averages back to the observed position. Ground leaders reach the ground within 20 ms.

## Afterglow

The HUD offers an afterglow of 0, 1 or 30 minutes of **scene time** (0 by default, saved in
`localStorage`). After the flash life, a glow stays and decays with a time constant of a quarter of the
window, shifted to reach exactly zero at its end. Its level is 12 % of the first pulse up to 5 minutes,
then `0.12 × 5 / minutes`, so the light on screen at 30 minutes stays that of 5 minutes.

A storm view (a storm open in replay) forces the afterglow to 0 without changing the saved choice; the
HUD shows 0 and greys the other choices. The 1 and 30 minute afterglows stay for the globe overview.

## Overlaps in a storm view

At 60×, a storm view shows about a minute of flashes at once. Glows there use screen blending
(`1 - (1 - a)(1 - b)`): neighbours brighten each other without piling up into white, and a flash still
shows over sunlit clouds without whitening them. The cloud light keeps the brightest flash at each point.
On the globe overview, flashes keep adding up, so active regions glow brighter.

## Channel

While a flash flickers, a screen-space ribbon follows a 3D random walk. The vertex shader generates its
main channel and three branches from a seed derived from the event time and location. Revisiting a flash
or rebasing GPU times preserves its shape.

The channel half length is always physical, 2.2 flash radii, with a 1.6 CSS px width; it has no pixel
floor. Its opacity rises from 0 to 1 while that half length grows from 6 to 18 CSS px, so distant flashes
are points and channels appear as they get readable. Branches light once, when the leader reaches them,
then fade (60 ms for ground flashes, 120 ms in-cloud); later pulses follow the main channel. The channel
fades over 150 ms after the flicker, leaving the round glow.

In-cloud channels run inside the cloud, 0.5 to 4 km below its top, so they are seen through it: their
core widens to at least 2 km and keeps 60 % of its light, scaled down as it widens, and they have no
halo. Ground channels stay sharp.

While a channel shows, the round glow steps back so the lit cloud does not wash it out: to 40 % for a
ground flash (10 % with its halo), to 75 % for an in-cloud one, scaled by the channel opacity.

A seed selects about 25 % cloud-to-ground looks: a downward channel from a nominal 7 km cloud base to the
surface, with downward branches. Its height alone is exaggerated by 2.5× (17.5 km on screen), so it reads
in a grazing view. The other 75 % spread horizontally at 8 to 11.5 km, just below the 12 km cloud tops;
those heights are not exaggerated. Both use the same horizontal walk, width, energy and timing, preserving
their footprint from above. Satellites cannot classify these two kinds: their allocation and exaggerated
drops are rendering choices, not measurements.

Only flashes still in that phase enter the channel buffer, capped at 2,048 instances. If a burst exceeds
this budget, the newest channels remain; all flashes retain their glow and cloud lighting.

## Channel halo

A second, soft ribbon follows the main channel of ground flashes only, sampling every other core vertex
(8 segments instead of 16). Branches retain their thin core. The halo is eight times wider and at 30 % of
the core level, and shares the channel opacity, profile, growth and fade. It fades with camera distance
from 1,500 to 6,000 km.

The halo pass is omitted above 512 active channels, fading out and back in over 250 ms, which bounds its
instance and fill cost during bursts.

## Cloud light

Flashes also light the clouds from inside, through a light map: a 1024 × 512 equirectangular window
around the point the camera looks at, 3 times the camera height in half height, up to the whole globe
from about 3,300 km. Near the floor its texels are 4.7 km and each flash lights about 2 radii around it;
from afar, 150 km at least, as on the globe. In-cloud flashes light it where their light has drifted.
The cloud adds the light scaled by how dark it is, so sunlit tops barely change.

## Reduced motion

With `prefers-reduced-motion: reduce`, there is no flicker: one soft fade, rising over 60 ms, falling with
a 250 ms time constant, then following the same glow.
