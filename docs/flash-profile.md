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

1. **Strokes and pulses.** The flicker lasts the observed flash duration, clamped to 60 ms to 2 s, and
   each [flash kind](#flash-kinds) fills it with its own pattern, in wall clock time (table below). A
   cloud-to-ground flash first shows its leader coming down at 12 % of the first stroke, then strikes:
   strokes rise at once, dark in between, the first at full level and decaying with a time constant of
   20 to 30 ms, later ones at 0.3 to 0.9 of it, decaying over 10 to 30 ms. Gaps between strokes are
   log-triangular, 57 ms in geometric mean (94 ms for positive flashes), from 10 to 400 ms; a
   multi-stroke flash holds as many strokes as its flicker does, 2 to 12, its gaps spread when twelve
   would end early (they span 0.86 s on average), and strokes a flash must hold are brought closer to fit
   in. A continuing current holds a steady 20 to 30 % for 40 to 300 ms past its stroke's own tail (two
   decay times), within the flicker. An in-cloud flash rises with its trunk, glows at 15 to 25 % while
   its leaders spread, and carries none, one, or two to three bright pulses (at least 60 ms apart, later
   ones at 0.75 to 0.9, decaying over 20 to 60 ms): the first comes after the trunk and before 90 % of
   the flicker, mostly early; without one, the glow swells once to 35 to 50 %. The glow of in-cloud
   flashes without a bright pulse or with several stutters over the last half of the flicker, as
   K-changes do: 12.5 ms steps, 40 % of them lit 0.15 to 0.3 above the glow, never above 0.5. In-cloud
   light fades 80 ms after the flicker. The patterns are procedural and seeded by the flash position: only
   the start, duration, energy and footprint are observed.
2. **Shutter.** Each frame shows a pulse averaged over the last 1/60 s, like a camera shutter, so a pulse
   is never lost between two frames and its light reaches the screen whatever the frame rate.
3. **Fade.** A dim glow (12 % of the first pulse) rises over the flicker, then decays exponentially to
   exactly zero at the end of the flash life: 1 s, or the flicker plus 0.5 s for long flashes. At
   afterglow 0, the flash then leaves no trace.

The result is the brightest of the three. About half of all flashes do not flicker: a single stroke is
one blink, a one-pulse in-cloud flash one burst over its glow, a crawler a steady light (52 % of flashes
drawn with the shares of the kinds, durations and areas spread like GLM's); a multi-stroke flash crackles
for its whole duration.

## Flash kinds

Each flash is drawn in one of seven procedural looks ([ADR 0033](adr/0033-lightning-looks-and-density.md)),
picked by its seed (`flashKind` in `channel.ts`) and, for crawlers, by its observed duration and area.
Satellites classify nothing: the looks drawn are not the flash population, and the shares below are a
rendering choice.

| Kind | Share | Origin, trunk top | Run, strike | Inclination from the vertical | Leader, fan speed (m/s) | Branches |
|---|---|---|---|---|---|---|
| Negative cloud-to-ground, multi-stroke (`CgMulti`) | 19 % | 6-8 km | feed 0.3-0.8 r, strike 2-8 km away inside r | 0-30° for 80 %, 30-45° otherwise | 1 × 10^5 | 3-12 |
| Negative cloud-to-ground, single-stroke (`CgSingle`) | 7 % | 6-8 km | as above | as above | 1 × 10^5 | 1-3 |
| Positive cloud-to-ground (`CgPositive`) | 3 % | 9-11 km | run 0.8-2.2 r, drop 5-11 km across, strike at 0.6-1.0 r from the position, inside r | 30-45° | 1 × 10^5 | 0-3 |
| Bolt from the blue (`BoltFromBlue`) | 1 % | trunk from 7.0-8.4 km to 9-10 km, exit 8-9 km | run 0.5-1 r, strike 5-12 km from the exit inside max(r, 8 km) | 45-60° | 1.5 × 10^5 | 3-8 |
| In-cloud trunk and fan (`IcTrunkFan`) | the rest, 55-60 % | 6-8 km to 9-11 km | fans 0.8-2.2 r | 15-40° | 2 × 10^5, fans 8 × 10^4 | 0-9 |
| In-cloud crawler (`IcCrawler`) | flashes observed ≥ 600 ms or ≥ 1,500 km² | 6-8 km, no trunk | 1.76-2.2 r | horizontal | 1 × 10^5 | 0-3 |
| Cloud-to-air (`CloudToAir`) | 3 % | as the trunk and fan | as the trunk and fan, one branch leaving the cloud | 15-40° | as the trunk and fan | 0-9 |

Cloud-to-ground kinds are 30 % of the seeds (observed band 15 to 40 %). Each flash runs its leaders at
the kind's speed times a pace drawn once per flash, 0.75 to 1.35: `leaderSeconds` is the time down a
cloud-to-ground drop (clamped to 50 to 150 ms) or up an in-cloud trunk (10 to 20 ms); for a bolt from
the blue it covers the whole path, up its trunk, 0.75 r across the cloud and down (clamped to 150 to
250 ms, so most bolts under 10 km of radius sit at 150 ms). `spreadSeconds` is the time the fans take to
cover 2.2 r (within 80 % of the flicker; the whole flicker for crawlers). The table is the contract of
the geometry (#401) and timing (#402) tickets; until #401 lands, the four cloud-to-ground kinds are drawn
with the cloud-to-ground silhouette below, and the three in-cloud kinds with the in-cloud one.

Each kind keeps its own timing within the observed duration (`flashProfile`, see
[flicker](#flicker-then-fade)); the leader of a cloud-to-ground flash takes at most half its flicker:

| Kind | Before the first stroke or pulse | Strokes or bright pulses | Steady light |
|---|---|---|---|
| Multi-stroke | leader at 12 %, 50-150 ms | 2-12 strokes, 10-400 ms apart (57 ms in geometric mean) | continuing current in 40 %, after one of strokes 2 to 5 |
| Single-stroke | leader at 12 %, 50-150 ms | 1 stroke | in-cloud activity at 12-18 % to the end of the flicker; continuing current in 15 % |
| Positive | leader at 12 %, 50-150 ms | 1 stroke (81 %) or 2, 94 ms apart in geometric mean | long continuing current in 75 % |
| Bolt from the blue | leader at 12 %, 150-250 ms | 1, 2 or 3 strokes (25 / 40 / 35 %, 2.1 on average) | continuing current in 30 % |
| Trunk and fan, cloud-to-air | trunk rising in 10-20 ms, glow 15-25 % while the fans spread | none (25 %, a swell to 35-50 %), 1 (45 %) or 2-3 (30 %) | stutters in the last half of flashes with none or several |
| Crawler | none | none | 25-35 % for the whole flicker, the leader's tip at full |

Leaders light the channel as they go (`spread`): cloud-to-ground ones come down over their leader time
and in-cloud ones cover their path over `spreadSeconds`, both slowing down (`1 - (1 - t)²`); crawlers walk
at a steady pace. The light of in-cloud flashes drifts along the channel from 0.6 radius on one side of
the observed position to 0.6 radius on the other, so it stays within the observed footprint and averages
back to the observed position.

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

**Silhouette.** The [flash kind](#flash-kinds) picks it: the four cloud-to-ground kinds (30 %) are drawn
as *Ground*, the three in-cloud kinds as *In-cloud*.

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

**Timing.** Leaders light the path as they go. A cloud-to-ground channel grows down with its leader at
12 %, its branches lit as it passes; the first stroke then fills it from the ground up in 33 ms, two
frames (a real return stroke takes microseconds). Branches die first, over 60 ms from the first stroke,
while the trunk lingers; before each later stroke a dart leader runs down the trunk in 40 ms at 30 %, and
the stroke lights the trunk again, as later strokes follow an established path. A second ground contact
stays dark until the stroke that takes it: the first in 20 % of flashes, the second, third or fourth
otherwise. In-cloud branches light once, when the leader reaches them, then fade over 120 ms; main
channels light again with every pulse. Along a crawler, the tip of the leader shines at full over the
last tenth of its path while the rest holds the steady glow. The channel fades over 150 ms after the
flicker, leaving the round glow. A channel appears as it gets readable: its opacity rises while its half
length grows from 6 to 18 CSS px.

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
a 250 ms time constant, then following the same glow, whatever the kind. Light does not drift and
channels show whole: no leader, no return stroke sweeping up, no dart, no stutter.
