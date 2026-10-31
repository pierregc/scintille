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
the geometry ([Channel](#channel)) and timing (#402) tickets; until the timing lands, the four
cloud-to-ground kinds flash with the cloud-to-ground profile below and the three in-cloud kinds with the
in-cloud one.

- **Cloud-to-ground** kinds flash in distinct strokes and go dark in between, as return strokes do. In
  40 % of them, the first or second subsequent stroke holds a continuing current: a steady 20 to 30 %
  glow for up to 250 ms, within the observed duration.
- **In-cloud** kinds glow between their pulses (15 to 25 % of the first pulse) while their leaders
  spread, and fade 80 ms after the observed duration.

Leaders light the channel as they go. In-cloud ones start from a fifth of the path and cover it by
80 % of the flicker, slowing down (`1 - (1 - t)²`); their light drifts from 0.6 radius on one side of the
observed position to 0.6 radius on the other along the heading of their first fan, the one drawn
(`channelHash(seed, 1)`), so it follows the leaders, stays within the observed footprint and averages
back to the observed position. Ground leaders reach the ground within 20 ms.

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

**Silhouette.** The [flash kind](#flash-kinds) draws it, in km above the ground, around the observed
position, within the bounds of the kinds table (`skeleton.ts`, `SKELETON`, `KIND`; r is the observed
radius, at least 3 km). Heights are not exaggerated (`SKELETON.cgHeightScale` 1, bound 1.5).

- *Negative cloud-to-ground* (multi- and single-stroke): the flash starts 6 to 8 km up, anywhere over a
  disc of half the radius. A feed runs 0.3 to 0.8 r in the cloud along the flash's heading, ending
  within 0.8 r of the position; the channel then drops to a strike within the footprint (r of the
  position), its straight line within 30° of the vertical for 80 % of flashes and 30 to 45° for the
  rest, heading within 60° of the feed when the footprint allows (otherwise it turns or steepens to stay
  inside). It bends broadly once or twice. Its branches leave the drop between 1.5 and 5 km up, on every
  side, down and out at 20 to 40° from it (70 %) or 45 to 75°, most of them short and a few half as
  long as the drop (0.1 to 0.5 of it), end 0.3 to 2 km above the ground and branch again down to three
  levels: 3 to 12 of them for multi-stroke flashes, 1 to 3 for single-stroke ones, at 30 to 100 % of
  the trunk's light. 40 % of multi-stroke flashes get a second ground contact: a path from a branch 1
  to 3 km up to a strike 1 to 4 km from the first, inside the footprint (level 4, lit by a later stroke
  once #402 lands; until then it shows like a branch).
- *Positive cloud-to-ground*: from 9 to 11 km a run of 0.8 to 2.2 r along the heading, kept within the
  footprint, then an oblique drop at 30 to 45° from the vertical aimed at 0.6 to 1 r from the position,
  inside r; 0 to 3 branches.
- *Bolt from the blue*: a trunk climbs from 7 to 8.4 km to 9 to 10 km at 15 to 40° from the vertical,
  crosses 0.5 to 1 r of the cloud and leaves it at 8 to 9 km, then descends 5 to 12 km sideways to a
  strike inside max(r, 8 km); unbranched above 5 km, 3 to 8 branches below.
- *In-cloud trunk and fan*: an oblique trunk climbs 2 to 4 km, from 6-8 km to 9-11 km, at 15 to 40°
  from the vertical; one to three leaders then spread both ways from its top at 8.5 to 11.5 km, like
  the roots of a tree, as far as `min(2.2 r, 8 × 10^4 m/s × 0.8 × flicker)` allows: a fan of a short
  flash stays small and branches less, in proportion. It is a filament (20 %), branched (30 %) or a
  wide network without a dominant leader (50 %).
- *Cloud-to-air*: a trunk and fan whose first leader leaves the cloud over its outer 30 to 60 % and
  ends 1 to 3 km beyond the fan, at its height or up to 1 km over the 11.5 km top.
- *Crawler*: no trunk; one or two leaders run 1.76 to 2.2 r both ways along the cloud base at 6 to
  8 km, with 0 to 3 branches, at half a fan's light, seen through the whole cloud.

The first leader (the feed, a bolt's trunk, the first fan, a crawler's first leader) runs along the
heading the light drifts on.

**Path.** Each path has one or two broad bends (an elbow or an S), then its midpoints are displaced
sideways at uneven places, by about the same share of their length at every scale (0.18 to 0.34 of a
segment, 0.88 less at each finer level), down to segments of a 48th of the flash extent. Segment
lengths vary, turns are sharp or soft, and the path never zigzags regularly. Fans and crawlers keep to
a layer (30 % and 15 % of their sideways offsets vertical). In-cloud branches leave at uneven places,
mostly at 20 to 70 degrees, a few almost square, most of them on one side; some are short splinters,
some as long as the leader, and they branch again down to three levels, coarser as they get finer.

**Thickness and light.** The main channel is 1.4 to 2 CSS px wide and keeps its width and light down to
the ground. Branches are about 60 % as wide and fainter, sub-branches thinner still, down to hairlines
(drawn a pixel wide with their light scaled down), and they dim and thin towards their tips. A branch
in seven is as bright as the trunk. The core is white; the halo around ground channels is pale blue,
sometimes lavender-rose or warm.

**Timing.** Leaders light the path as they go: in-cloud ones crawl over 80 % of the flicker, ground ones
reach the ground within 20 ms. The stem (a cloud-to-ground feed, an in-cloud trunk) is lit first, by
15 % of the path's arrival; a drop then reaches its strike last, its branches no later than it, as a
stepped leader's branches stop when it strikes; in-cloud fans end their growth together. Branches light
once, when the leader reaches them, then fade (60 ms for ground flashes, 120 ms in-cloud); later pulses
light the main channels again, as return strokes follow an established path. The channel fades over
150 ms after the flicker, leaving the round glow. A channel appears as it gets readable: its opacity
rises while its half length grows from 6 to 18 CSS px.

**Through the cloud.** The cloud is assumed from 7 km (its base) to 11.5 km. The observed cloud layer
decides how a channel shows (`veil.ts`): for each segment, the renderer follows the line of sight from
its middle up to the camera and reads the cloud opacity where it leaves the 10 km cloud shell, so a
channel under the edge of a storm can show beside it. Each segment carries a cloud flag from its kind
and stage, not from its height alone:

- *In the cloud* (fans, crawlers, the part of a cloud-to-ground stem or drop above the base): light
  scatters around the channel. It spreads over 0.5 km just under the 11.5 km top to 4 km at the base,
  times the opacity, keeps the same light over that width and loses up to half of it, with no halo.
  Crawlers, along the base, are the most veiled.
- *A trace in the cloud* (in-cloud trunks): the channel spreads at most to twice its core width and
  keeps at least 30 % of its light, with a halo, so a trunk reads as a crisp, dim stroke inside the
  cloud.
- *In clear air* (a drop under the base, a bolt's descent, the outer part of a cloud-to-air leader):
  `(1 - opacity)^2` of its light comes through the cloud from straight above, less at a slant, as the
  cloud layer thickens towards the limb, but never less than 30 % (`VEIL.trace`): a bolt under a thick
  storm shows as a 30 % trace with its halo. This is styled: from orbit a channel under a storm is not
  seen at all, only in clear air.

While the cloud layer is hidden or has no frame for the scene, channels in the cloud are veiled as if
by an opacity of 0.6 and those below it stay crisp. Over sunlit clouds, which outshine a thin channel
seen from orbit, channels keep 30 % of their light.

**Under clouds in relief.** Where the clouds are drawn in relief (ADR 0028, 0031), channels stay half a
kilometre under the observed top: the part of a channel above the 7 km base is compressed toward that
top, to no less than 30 % of its height, while a drop under the base keeps its height. Under a top
lower than 8.85 km even that compressed channel would rise over the top, so the whole channel is lowered
with it (to no less than 30 %). The veil reads the channel's own heights, not the lowered ones.

**One flash, two instruments.** Where GLM and MTG LI detections fall within 400 ms and 0.15 degree of
each other, they are one flash: both keep their glow, only the newest gets a channel.

**Drawing.** Cores add to what is behind them, so they stay visible over a lit cloud; their segments
overlap half a width at each joint and cross-fade there, so they never bead. While a channel shows, the
round glow steps back: to 40 % for a ground flash (10 % with its halo), to 25 % for an in-cloud one,
scaled by the channel opacity. A ground flash steps back only as much as the cloud above it lets its
channel through (at least its 30 % trace), so a flash dimmed under a storm keeps most of its glow. Near the floor the round glow is drawn at 40 %, as the lit cloud and the
channel carry the flash.

**Budget.** Channels are built only when the camera is close enough for one to be readable (under about
9 km per CSS px), for the 384 newest flickering flashes, at most 24 new ones per frame, each with up to
256 segments. All flashes keep their glow and cloud light.

## Channel halo

A second, soft ribbon follows the main channel of ground flashes in clear air, and the trunks of
in-cloud flashes, drawn as traces: eight times wider, at
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
