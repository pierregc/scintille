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
- **In-cloud** flashes glow between their pulses (15 to 25 % of the first pulse) while their leaders
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

A storm view shows at most the 500 newest flashes; older ones fade out within 150 ms of wall clock
time. At 60× this hardly applies (about 360 at once in the busiest reference storm). At 600× it
shortens each flash to its first pulses, at 3600× to a frame or two: the cost stays bounded, but near
the floor the image still whitens at those speeds.

## Channel

While a flash flickers, its channel shows: a skeleton of segments built once per flash
(`skeleton.ts`), drawn as screen-space ribbons. Its shape is procedural and drawn from a seed of the
event time and position, so a flash keeps its shape when revisited. Satellites only see the light: none
of this shape is observed.

**Silhouette.** A seed picks about 25 % cloud-to-ground looks; the rest are in-cloud.

- *Ground*: a short leader in the cloud, at 8 to 11.5 km, feeds a channel that drops to the ground
  2 to 9 km away horizontally, mostly vertical, heights not exaggerated. It is a lone filament (30 %),
  branched (40 %), forked into two comparable channels (20 %), or strikes the ground at two points (10 %).
  Its branches go down and out and end in the air.
- *In-cloud*: one to three leaders spread both ways from where the flash starts, at 8 to 11.5 km, like
  the roots of a tree, up to 2.2 flash radii away. It is a filament (20 %), branched (30 %) or a wide
  network without a dominant trunk (50 %).

**Path.** Each path has one or two broad bends (an elbow or an S), then its midpoints are displaced
sideways at uneven places, by about the same share of their length at every scale, down to segments of
a 48th of the flash extent. Segment lengths vary, turns are sharp or soft, and the path never zigzags
regularly. Branches leave at uneven places, mostly at 20 to 70 degrees, a few almost square, most of
them on one side; some are short splinters, some as long as the trunk, and they branch again down to
three levels, coarser as they get finer.

**Thickness and light.** The main channel is 1.4 to 2 CSS px wide and keeps its width and light down to
the ground. Branches are about 60 % as wide and fainter, sub-branches thinner still, down to hairlines
(drawn a pixel wide with their light scaled down), and they dim and thin towards their tips. A branch
in seven is as bright as the trunk. The core is white; the halo around ground channels is pale blue,
sometimes lavender-rose or warm.

**Timing.** Leaders light the path as they go: in-cloud ones crawl over 80 % of the flicker, ground ones
reach the ground within 20 ms. Branches light once, when the leader reaches them, then fade (60 ms for
ground flashes, 120 ms in-cloud); later pulses light the main channels again, as return strokes follow
an established path. The channel fades over 150 ms after the flicker, leaving the round glow. A channel
appears as it gets readable: its opacity rises while its half length grows from 6 to 18 CSS px.

**Through the cloud.** The observed cloud layer decides what of a channel shows (`veil.ts`). For each
segment, the renderer follows the line of sight from its middle up to the camera and reads the cloud
opacity where it leaves the 10 km cloud shell: seen at a slant, a channel under the edge of a storm can
show beside it.

- *In the cloud* (segments above the 7 km base): light scatters around the channel. It spreads over
  0.5 km just under the 11.5 km top to 4 km at the base, times the opacity, keeps the same light over
  that width and loses up to half of it, with no halo. In clear air it stays crisp.
- *Below the cloud*: the cloud hides it. `(1 - opacity)^2` of its light comes through from straight
  above, less at a slant, as the cloud layer thickens towards the limb: a thick storm (opacity 0.92)
  lets through less than 1 %, a thin veil (0.3) about half.

While the cloud layer is hidden or has no frame for the scene, channels in the cloud are veiled as if
by an opacity of 0.6 and those below it stay crisp. Over sunlit clouds, which outshine a thin channel
seen from orbit, channels keep 30 % of their light.

**One flash, two instruments.** Where GLM and MTG LI detections fall within 400 ms and 0.15 degree of
each other, they are one flash: both keep their glow, only the newest gets a channel.

**Drawing.** Cores add to what is behind them, so they stay visible over a lit cloud; their segments
overlap half a width at each joint and cross-fade there, so they never bead. While a channel shows, the
round glow steps back: to 40 % for a ground flash (10 % with its halo), to 25 % for an in-cloud one,
scaled by the channel opacity. A ground flash steps back only as much as the cloud above it lets its
channel through, so a flash hidden under a storm keeps its glow. Near the floor the round glow is drawn at 40 %, as the lit cloud and the
channel carry the flash.

**Budget.** Channels are built only when the camera is close enough for one to be readable (under about
9 km per CSS px), for the 384 newest flickering flashes, at most 24 new ones per frame, each with up to
256 segments. All flashes keep their glow and cloud light.

## Channel halo

A second, soft ribbon follows the main channel of ground flashes in clear air: eight times wider, at
30 % of the core level, sharing its opacity, profile, growth and fade, keeping the brightest light where
it overlaps. It fades with camera distance from 1,500 to 6,000 km. Above 256 channels it fades out over
250 ms, which bounds its cost during bursts.

## Cloud light

Flashes also light the clouds from inside, through a light map: a 1024 × 512 equirectangular window
around the point the camera looks at, 3 times the camera height in half height, up to the whole globe
from about 3,300 km. Near the floor its texels are 4.7 km and each flash lights about 2 radii around it;
from afar, 150 km at least, as on the globe; near the floor it is drawn at 45 %, so channels read over
it. In-cloud flashes light it where their light has drifted.
The cloud adds the light scaled by how dark it is, so sunlit tops barely change.

## Reduced motion

With `prefers-reduced-motion: reduce`, there is no flicker: one soft fade, rising over 60 ms, falling with
a 250 ms time constant, then following the same glow. Light does not drift and channels show whole.
