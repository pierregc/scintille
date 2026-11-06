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
   strokes rise at once, dark in between, the first at full level and decaying with a time constant of 20
   to 30 ms, later ones at 0.3 to 0.9 of it, decaying over 10 to 30 ms. Gaps between strokes are drawn
   log-triangular, 57 ms in geometric mean (94 ms for positive flashes), from 10 to 400 ms; a
   multi-stroke flash holds as many strokes as its flicker does, 2 to 12, its gaps spread when twelve
   would end early (they span 0.86 s on average, so gaps widen up to 2.3 times in flashes over about
   0.9 s), and strokes a flash must hold come within 80 % of the flicker left. The gaps shown keep 57 ms
   in geometric mean in flashes of 0.6 to 1 s; a brief flicker only holds the shorter ones (44 ms under
   0.4 s, 51 ms over durations spread like GLM's), and flashes near 2 s show 120 ms. A continuing current
   holds a steady 20 to 30 % for 40 to 300 ms past its stroke's own tail (two decay times), within the
   flicker. An in-cloud flash rises with its trunk, glows at 15 to 25 % while its leaders spread, and
   carries none, one, or two to three bright pulses (at least 60 ms apart, later ones at 0.75 to 0.9,
   decaying over 20 to 60 ms): the first comes after the trunk and before 90 % of the flicker, mostly
   early; without one, the glow swells once to 35 to 50 % over 40 ms, decaying over 120 ms. The glow of
   in-cloud flashes without a bright pulse or with several stutters over the last half of the flicker, as
   K-changes do: 12.5 ms steps, 40 % of them lit 0.15 to 0.3 above the glow, never above 0.5. In-cloud
   light fades 80 ms after the flicker. The patterns are procedural and seeded by the flash position:
   only the start, duration, energy and footprint are observed.
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
The kind and its timing (leader and spread seconds) are drawn once per flash on the CPU and carried to
the shaders with the flash (`flashLook`), so the glow, the cloud light and the channel follow the
skeleton's kind. The strokes and pulses themselves are drawn on the GPU, alike in every pass.
Satellites classify nothing: the looks drawn are not the flash population, and the shares below are a
rendering choice.

| Kind | Share | Origin, trunk top | Run, strike | Inclination from the vertical | Leader, fan speed (m/s) | Branches |
|---|---|---|---|---|---|---|
| Negative cloud-to-ground, multi-stroke (`CgMulti`) | 19 % | 6-8 km | feed 0.2-0.5 r, strike 2-8 km away inside r | 0-25° for 85 %, 25-40° otherwise | 1 × 10^5 | 3-12 |
| Negative cloud-to-ground, single-stroke (`CgSingle`) | 7 % | 6-8 km | as above | as above | 1 × 10^5 | 1-3 |
| Positive cloud-to-ground (`CgPositive`) | 3 % | 9-11 km | run 0.8-2.2 r, drop 5-11 km across, strike at 0.6-1.0 r from the position, inside r | 30-45° | 1 × 10^5 | 0-3 |
| Bolt from the blue (`BoltFromBlue`) | 1 % | trunk from 7.0-8.4 km to 9-10 km, exit 8-9 km | run 0.5-1 r, strike 5-12 km from the exit inside max(r, 8 km) | 45-60° | 1.5 × 10^5 | 3-8 |
| In-cloud trunk and fan (`IcTrunkFan`) | the rest, 55-60 % | 5-7 km to 9-11 km | fans 0.6-1.4 r | 5-25° | 2 × 10^5, fans 8 × 10^4 | 0-5 |
| In-cloud crawler (`IcCrawler`) | flashes observed ≥ 600 ms or ≥ 1,500 km² | 6-8 km, no trunk | 0.8-1.1 r each way | horizontal | 1 × 10^5 | 0-3 |
| Cloud-to-air (`CloudToAir`) | 3 % | as the trunk and fan | as the trunk and fan, one branch leaving the cloud | 5-25° | as the trunk and fan | 0-5 |

Cloud-to-ground kinds are 30 % of the seeds (observed band 15 to 40 %); their heights in this table are
drawn 1.5 times as tall, the stem kept under 11 km ([Channel](#channel)). Each flash runs its leaders at
the kind's speed times a pace drawn once per flash, 0.75 to 1.35: `leaderSeconds` is the time down a
cloud-to-ground drop (clamped to 50 to 150 ms) or up an in-cloud trunk (10 to 20 ms); for a bolt from
the blue it covers the whole path, up its trunk, 0.75 r across the cloud and down (clamped to 150 to
250 ms, so most bolts under 10 km of radius sit at 150 ms). `spreadSeconds` is the time the fans take to
cover 1.4 r, a crawler's leaders 1.1 r (within 80 % of the flicker; the whole flicker for crawlers). The table is the contract of
the geometry ([Channel](#channel)) and the timing (the table below) of each kind.

Each kind keeps its own timing within the observed duration (`flashProfile`, see
[flicker](#flicker-then-fade)); the leader of a cloud-to-ground flash takes at most half its flicker:

| Kind | Before the first stroke or pulse | Strokes or bright pulses | Steady light |
|---|---|---|---|
| Multi-stroke | leader at 12 %, 50-150 ms | 2-12 strokes, 10-400 ms apart (57 ms in geometric mean) | continuing current in 40 %, after one of strokes 2 to 5 |
| Single-stroke | leader at 12 %, 50-150 ms | 1 stroke | in-cloud activity at 12-18 % to the end of the flicker, in the glow and the channel in the cloud only; continuing current in 15 % |
| Positive | leader at 12 %, 50-150 ms | 1 stroke (81 %) or 2, 94 ms apart in geometric mean | long continuing current in 75 % |
| Bolt from the blue | leader at 12 %, 150-250 ms | 1, 2 or 3 strokes (25 / 40 / 35 %, 2.1 on average) | continuing current in 30 % |
| Trunk and fan, cloud-to-air | trunk rising in 10-20 ms, glow 15-25 % while the fans spread | none (25 %, a swell to 35-50 %), 1 (45 %) or 2-3 (30 %) | stutters in the last half of flashes with none or several |
| Crawler | none | none | 25-35 % for the whole flicker, the leader's tip at full |

Leaders light the channel as they go (`spread`): cloud-to-ground ones come down over their leader time
and in-cloud ones cover their path over `spreadSeconds`, both slowing down (`1 - (1 - t)²`); crawlers walk
at a steady pace. The light of in-cloud flashes drifts from 0.6 radius on one side of the observed
position to 0.6 radius on the other along the heading of their first drawn leader
(`channelHash(seed, 1)`), so it follows the leaders, stays within the observed footprint and averages
back to the observed position.

## Afterglow

The HUD offers an afterglow of 0, 1 or 30 minutes of **scene time** (0 by default, saved in
`localStorage`). After the flash life, a glow stays and decays with a time constant of a quarter of the
window, shifted to reach exactly zero at its end. Its level is 12 % of the first pulse up to 5 minutes,
then `0.12 × 5 / minutes`, so the light on screen at 30 minutes stays that of 5 minutes.

A storm view (a storm open in replay) forces the afterglow to 0 without changing the saved choice; the
HUD shows 0 and greys the other choices. The 1 and 30 minute afterglows stay for the globe overview.

## Overlaps in a storm view

At 60×, a storm view shows about a minute of flashes at once. Below 1 km per CSS px, glows there keep
the brightest at each pixel, so a cell never piles up into a white ball; from 1 km per CSS px they use
screen blending (`1 - (1 - a)(1 - b)`): neighbours brighten each other without piling up into white,
and a flash still shows over sunlit clouds without whitening them. From 0.7 to 1 km per CSS px a
screen-blended copy of the glows, weighted from 0 to 1, is drawn under the max-blended ones, so zooming
across never pops and a lone glow keeps its light. The cloud light keeps the brightest flash at each
point. On the globe overview, flashes keep adding up, so active regions glow brighter.

**Replay speed never removes a flash where the cloud light shows.** Every flash lights the cloud at
its observed time, place, footprint and energy, with its full profile and drift, for its observed
duration, at every replay speed (where it cannot show, see the limits below). What a storm view draws in full, with its channel, its near-floor sprite, its halo and its
crackle, is a **sample** sized for the speed (`density.ts`; the policy is recorded in ADR 0033 of the
lightning look rework, #398):

- Each flash holds a fixed lot `seed × mix(1, 0.4, intensity) × k`, `k` being 0.4 for a
  cloud-to-ground kind and 1 otherwise (`DENSITY.groundWeight`), its seed being already a uniform
  hash of its time and place (hashing it again would not survive the GPU's float32, which must pick
  the same flashes as the channel pool and the sound): a revisit or a shared URL shows the same
  flashes, the strongest flash is 2.5 times likelier than the weakest to be drawn, and a ground
  strike 2.5 times likelier than an in-cloud flash, whose channel the cloud mostly hides. About half
  the sample is then cloud-to-ground; every flash keeps its cloud light either way. A flash is
  drawn while its lot is under the applied share, fading out over the next 10 % of the share rather
  than popping at its edge.
- The share aims at a target number of flashes within their flicker at once: **50 at 60×, 20 at
  600×, 8 at 3600×**, every flash at 1× (bands tuned on captures: 30 to 100, 12 to 30, 5 to 12;
  between the speeds the target follows a power law). `share = target / (2.175 × load)`, `load`
  being the flashes within their flicker or fade at once, estimated from those played in the last
  0.4 s of wall clock time, each counting for its flicker and fade over those 0.4 s (2.175 is the
  mean of the inverse lot weights, 1.5 for the energy times 1.45 for the kind; a plain count of the flashes played in the last 0.4 s drew 1.5 times
  the target on R1, whose flashes last longer). On a quiet storm the share is 1 and every flash is drawn.
- The applied share follows the wanted one with a 0.5 s time constant (2 s lagged a storm's rate
  by ten minutes at 600×, halving the drawn count between frames), and jumps to it at once on a
  seek, a speed change or a new storm view. After a speed change during play, it is set to the
  wanted share on every frame until the last 0.4 s hold only flashes played at the new speed: the
  load then tracks the flashes alive frame by frame, while following it over 0.5 s drew up to 4
  times the target for about a second after a speed-up, and a sixth of it after a slow-down.
- Outside the sample, a flash keeps its sprite from afar only, rising from nothing at about 1.3 km
  per px to its full point at 3 km per px ([farness](immersive-view.md#lightning-scale) 0.7 to 1),
  and half a sprite on the frames without a cloud light (clouds hidden or without a frame, a tier
  without the light map; eased over 0.25 s when the cloud light comes or goes), within the 500
  newest flashes (below), so flashes stay points from afar
  ([visual rule 1](immersive-view.md#visual-rules)) while the storm views up to the whole storm
  framing (0.26 to 0.79 km per px on the reference storms at the 45° frame, 1,000 px tall) show the
  cloud light and the sample alone; a ramp over farness 0.5 to 1 let the points of thousands of
  flashes at 3600× merge into one white disc over that framing. The round glow steps back for a channel (below) only in the sample, so a
  flash outside it keeps its full sprite. Limits: where no cloud light shows, a flash outside the
  sample keeps its half sprite only while among the 500 newest (14 ms and a 150 ms fade at the
  Basse-Kotto peak at 3600×; at 600× on R1 on the `low` tier, about 1,000 of the 1,450 to 1,575
  flashes alive draw nothing, C21Q of [Lightning look validation](immersive-view.md#lightning-look-validation)),
  so replay speed does remove flashes there; and the cloud light covers a window of three camera
  heights around what the camera looks at, so in a grazing view a flash beyond it, outside the
  sample and not yet a point, is not drawn.

The 500 newest-flashes cap of a storm view (`STORM_VIEW_FLASHES`, older ones fading within 150 ms
of wall clock time) binds every flash while all are drawn, in practice at 1×, and otherwise only the
points outside the sample: without it, the points of the 15,000 flashes alive at 3600× cost 2.4 ms
more at p95 than `main` from the `globe` pose of R1. The sample and the cloud light never have a cap
(`DENSITY.lightMapCeiling` is Infinity: the bench needed none). The channel pool builds
channels for the sample only, and the sound voices it only. The HUD rate stays the data rate:
`lightning.stats` ([benchmark](immersive-view.md#benchmark)) tells how many flashes are drawn.

## Channel

While a flash flickers, its channel shows: a skeleton of segments built once per flash
(`skeleton.ts`), drawn as screen-space ribbons. Its shape is procedural and drawn from a seed of the
event time and position, so a flash keeps its shape when revisited. Satellites only see the light: none
of this shape is observed.

**Silhouette.** The [flash kind](#flash-kinds) draws it, in km above the ground, around the observed
position, within the bounds of the kinds table (`skeleton.ts`, `SKELETON`, `KIND`; r is the observed
radius, at least 3 km). The heights below are the assumed ones. Cloud-to-ground channels are drawn
1.5 times as tall, about the ground (`SKELETON.cgHeightScale`, the bound of ADR 0033), their stem kept
under 11 km (`SKELETON.maxOriginKm`): a negative channel starting 6 to 8 km up is drawn from 9 to 11 km,
a positive one or a bolt from the blue up to 11 km. At 7 km a drop is only 10 to 30 px tall at the
oblique 45° pose and reads as a stub under the fans; 1.5 times as tall, it reads as a bolt. In-cloud
kinds keep their heights.

- *Negative cloud-to-ground* (multi- and single-stroke): the flash starts 6 to 8 km up, anywhere over a
  disc of half the radius. A feed runs 0.2 to 0.5 r in the cloud along the flash's heading, ending
  within 0.8 r of the position; the channel then drops to a strike 2 to 8 km sideways from the drop's
  top (`KIND.strikeKm`) and within the footprint (r of the position), its straight line within 25° of
  the vertical for 85 % of flashes and 25 to 40° for the rest (never under 14 to 18°, the strike being
  at least 2 km out), heading within 60° of the feed when the footprint allows (otherwise it turns, or
  in the smallest footprints shortens, to stay inside). It bends broadly once or twice. Its branches
  leave the drop between 1.5 and 5 km up, on every side, down and out at 15 to 35° from it (80 %) or 40 to 65°, and at least 35° below the horizontal (`SKELETON.branchDipDeg`), most of them short and a few half as
  long as the drop (0.1 to 0.5 of it), end 0.3 to 2 km above the ground and branch again down to three
  levels: 3 to 12 of them for multi-stroke flashes, 1 to 3 for single-stroke ones, at 30 to 100 % of
  the trunk's light. 40 % of multi-stroke flashes get a second ground contact: a path from a branch 1
  to 3 km up to a strike 1 to 4 km from the first, inside the footprint (level 4, lit from a later
  stroke, see Timing).
- *Positive cloud-to-ground*: from 9 to 11 km a run of 0.8 to 2.2 r along the heading, kept within the
  footprint, then an oblique drop at 30 to 45° from the vertical (5 to 11 km sideways, shorter in the
  smallest footprints) to a strike 0.6 to 1 r from the position (`KIND.strikeR`); 0 to 3 branches.
- *Bolt from the blue*: a trunk climbs from 7 to 8.4 km to 9 to 10 km at 5 to 25° from the vertical,
  crosses 0.5 to 1 r of the cloud and leaves it at 8 to 9 km, then descends 5 to 12 km sideways to a
  strike inside max(r, 8 km); unbranched above 5 km, 3 to 8 branches below.
- *In-cloud trunk and fan*: a steep trunk climbs 3 to 5.5 km, from 5-7 km to 9-11 km (the main negative charge to the upper
  positive one), at 5 to 25° from the vertical and 0.6 of the path roughness, as a ground drop; one to three leaders then spread both ways from its top at 8.5 to 11.5 km, like
  the roots of a tree, as far as `min(1.4 r, 8 × 10^4 m/s × 0.8 × flicker)` allows, near the observed footprint: a fan
  of a short flash stays small. It is a filament (20 %), branched (30 %) or a wide network without a
  dominant leader (50 %), with 0 to 1, 1 to 3 or 2 to 5 branches reaching up to half the fan
  (`SKELETON.fanBranches`, `fanBranchReach`).
- *Cloud-to-air*: a trunk and fan whose first leader leaves the cloud over its outer 30 to 60 % and
  ends 1 to 3 km beyond the fan, at its height or up to 1 km over the 11.5 km top.
- *Crawler*: no trunk; one or two leaders run 0.8 to 1.1 r both ways along the cloud base, across the observed footprint at 6 to
  8 km, with 0 to 3 branches, seen through the whole cloud.

The first leader (the feed, a bolt's trunk, the first fan, a crawler's first leader) runs along the
heading the light drifts on.

**Path.** Each path has one or two broad bends (an elbow or an S), then its midpoints are displaced
sideways at uneven places, by about the same share of their length at every scale (0.18 to 0.34 of a
segment, 0.88 less at each finer level), down to segments of a 48th of the flash extent. A
cloud-to-ground drop, its branches and its second contact keep 0.6 of that roughness
(`SKELETON.dropRoughness`): they turn about 15° from one segment to the next, close to the 16° measured
on photographed channels, and most of their segments are steeper than 60°. Paths deep in the cloud, crawlers and
cloud-to-ground stems, are drawn in segments of at least 1.5 km (`SKELETON.deepMinKm`), about the width
the cloud spreads them to: finer segments would pile their overlapping ends into a saturated tube. Segment
lengths vary, turns are sharp or soft, and the path never zigzags regularly. Fans and crawlers keep to
a layer (30 % and 15 % of their sideways offsets vertical). In-cloud branches leave at uneven places,
mostly at 20 to 70 degrees, a few almost square, most of them on one side; some are short splinters,
some as long as the leader, and they branch again down to three levels, coarser as they get finer.

**Thickness and light.** The main channel is 1.4 to 2 CSS px wide and keeps its width and light down to
the ground. Branches are about 60 % as wide and fainter, sub-branches thinner still, down to hairlines
(drawn no thinner than 1.25 device px, their light scaled down; see Drawing), and they dim and thin
towards their tips. A branch in seven is as bright as the trunk. The core is white; the halo around
ground channels is pale blue.

**Timing.** Leaders light the path as they go. A cloud-to-ground channel grows down with its leader at
12 %, its branches lit as it passes (the stem, a cloud-to-ground feed or an in-cloud trunk, is lit
first, by 15 % of the path's arrival; a drop reaches its strike last, its branches no later than it); the first stroke then fills it from the ground up to 11.5 km in
33 ms, two frames (a real return stroke takes microseconds). Branches die first, over 60 ms from the
first stroke, while the trunk lingers; before each later stroke a dart leader runs down the trunk in
40 ms at 30 %, lighting the 30 % of the path behind its tip, and the stroke lights the trunk again, as
later strokes follow an established path. Below the cloud, a single-stroke channel goes dark after its
stroke: its in-cloud activity lights only the glow and the channel in the cloud. A second ground contact
stays dark until the stroke that takes it: the first in 20 % of flashes, the second, third or fourth
otherwise, or the last stroke when the flash ends first. In-cloud branches light once, when the leader
reaches them, then fade over 120 ms; main channels light again with every pulse. Along a crawler, the tip
of the leader shines at full over the last tenth of its path while the rest holds the steady glow. The
channel fades over 150 ms after the flicker, leaving the round glow. A channel appears as it gets
readable: its opacity rises while its half length grows from 6 to 18 CSS px.

**Through the cloud.** The cloud is assumed from 7 km (its base) to 11.5 km. The observed cloud layer
decides how a channel shows (`veil.ts`): for each segment, the renderer follows the line of sight from
its middle up to the camera and reads the cloud opacity where it leaves the 13 km cloud shell, so a
channel under the edge of a storm can show beside it. Seen from above, a flash meets 55 % of that
opacity: the clouds are slightly transparent over lightning (styled, [ADR 0035](adr/0035-lightning-inside-clouds.md)).
At a slant, the cloud crossed toward the eye thickens the veil and spreads the light up to five times
farther (slant paths 1.5 to 4), so a channel at the steepest tilt reads inside its cloud, not on top
of it (`seenThrough`). Each segment carries a cloud flag from its kind and stage, not from its height
alone:

- *In the cloud* (fans, crawlers, a cloud-to-ground stem whatever its height, the part of a drop above
  the base): light scatters around the channel. It spreads over 0.5 km just under the 11.5 km top to
  4 km at the base, times the opacity, keeps the same light over that width and loses up to half of it,
  with no halo. A segment shorter on screen than that width overlaps its neighbours over it, so it keeps
  only its share, `max(length, core width) / spread width` (`veilOverlap`, styled): without it the
  overlapping ends of a path deep in the cloud add up to a saturated white tube.
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

**Under clouds in relief.** Where the clouds are drawn in relief (ADR 0028, 0031), channels and the
round glow stay half a kilometre under the observed top: the part of a channel above the 7 km base is compressed toward that
top, to no less than 30 % of its height, while a drop under the base keeps its height. Under a top
lower than 8.85 km even that compressed channel would rise over the top, so the whole channel is lowered
with it (to no less than 30 %). The veil reads the channel's own heights, not the lowered ones.

**One flash, two instruments.** Where GLM and MTG LI detections fall within 400 ms and 0.15 degree of
each other, they are one flash: both keep their glow, only the newest gets a channel.

**Drawing.** Cores add to what is behind them, so they stay visible over a lit cloud. Their segments
overlap half a width at each joint and cross-fade there in screen values, after the sRGB conversion, so
the two at a joint add up to one (cross-faded in light, each half was converted on its own and the joint
came out about 1.4 times as bright: a bead). Each segment's cross-fade is scaled to add up to its length
(`lengthShare`), then given back the light its overlaps used to add per unit length (`overlapGain`;
styled, so channels keep the brightness they had when they beaded). For a segment s widths long
(unforeshortened), that is 1 from a width on and about 1 / (6 s) below in the bloom's linear buffer; on
screen it follows the tone (`overlapTone`): nothing where the sRGB conversion is linear, 1 + 1 / (3 s)
from a width on and about 0.39 / s below in mid tones. It is exact from a width on, within 5 % below in
mid and bright tones, up to 16 % over for the dimmest tones of the shortest segments, and stops growing
below s = 1/16 (`RIBBON.minSpan`). Against the old drawing, on paused captures at 1440 × 900, channels
add 92 to 102 % of their old light (C1 to C4 lightning alone, C14, C15, and the whole storm and a window
pose at night; least at the window poses) and trunks keep theirs within 1 % (C20 and C14 at 2400 × 1500).
A segment foreshortened on screen adds light for its screen length only. A chain of uneven segments
shorter than their width still varies along it, less than before (within 23 % of its mean, against up
to 35 %). No core is drawn thinner than 1.25 device px (`RIBBON.hairlinePx`): a thinner one breaks into
dashes on the pixel grid, so it widens to that floor and gives up light in proportion. At a pixel ratio
of 1 this also widens the thinnest stretches of main channels, 0.8 to 1.25 px wide; at 2 and above the
floor is finer than the old 0.75 CSS px. While a channel shows, the
round glow steps back: to 40 % for a ground flash (10 % with its halo), to 25 % for an in-cloud one,
scaled by the channel opacity. A ground flash steps back only as much as the cloud above it lets its
channel through (at least its 30 % trace), so a flash dimmed under a storm keeps most of its glow.
Near the floor the round glow is drawn at 15 % (styled), as the lit cloud and the channel carry the
flash; where the cloud light does not show (the `low` tier, clouds hidden or not loaded yet), it keeps
40 %. Over sunlit clouds it keeps 35 % of that (styled: from orbit, nothing of a flash shows by day).
These are rules of the floor: they ease out from 0.3 to 1 km per CSS px, and from there the glow climbs
from 40 % to full as before, so views from 1 km per CSS px (the globe) keep their points and their day
marks. Since the 45° storm frame (#406) the whole-storm frames of the reference storms sit under 1 km
per CSS px on a 1,000 px tall view: Basse-Kotto's at 0.79 (10 % of the rules of the floor, 75 % of its
glows max-blended; at 20° it was 1.1, screen-blended with the far rules), R2 0.61, R1 0.48, the small
storms 0.26 ([lightning scale](immersive-view.md#lightning-scale)). Phones scale both 15 % and 40 % by 0.6. In a storm view below 1 km per CSS
px, overlapping glows keep the brightest, never add up.

**Budget.** Channels are built only when the camera is close enough for one to be readable (under about
9 km per CSS px), for the flashes of the sample (every flash at 1×) up to the 384 newest flickering
ones, 24 new ones per frame at most, each with up to 256 segments (24 kept for a second ground contact
and 16 for a cloud-to-air leader's way out, `SKELETON.secondSegments` and `airSegments`; a path that
would not fit is drawn coarser). All flashes keep their glow and cloud light.

## Channel halo

A second, soft ribbon follows the main channel of ground flashes in clear air, and the trunks of
in-cloud flashes, drawn as traces: eight times wider than the core (for a trace, than its core width,
not the width the cloud spreads it to), at 30 % of the core level, sharing its opacity, profile, growth
and fade, keeping the brightest light where it overlaps. Its tint is cool only (`vec3(0.86, 0.9, 1.0)`
on the pale blue halo colour): the rose and warm halos of photographs are dust and distance seen from
the ground. It fades with camera distance from 1,500 to 6,000 km. Above 256 channels it fades out over
250 ms, which bounds its cost during bursts.

## Cloud light

Flashes also light the clouds from inside, through a light map: an equirectangular window around the
point the camera looks at, 3 times the camera height in half height, up to the whole globe from about
3,300 km; 1024 × 512 texels on `medium` and `high` (4.7 km at 400 km). A 2048 × 1024 map on `high` (2.3 km)
was kept only within the 384 MB budget, which the lightning look rework crosses on desktop (#408).
`w` is the share of the globe the window covers (0.12 at the 400 km floor, 1 from about 3,300 km).
Each flash lights a patch reaching `(1.3 + 1.7 w) r` around its observed footprint (`CLOUD_LIGHT`): 1.5 `r`
at the floor, with about 9 % of its centre left at `r` (1.3 `r` and 4 % as `w` tends to 0). The
patch is styled, elongated and irregular, drawn per flash: its long axis over its short one from
1.4 to 2.2, its edge lobed by 0.18 (two lobes) and 0.10 (three lobes) of its mean, lying along its
drift or, for ground flashes, along the drawn feed (both `channelHash(seed, 1)`; its aspect and lobes take
draws 7 to 9, which no channel detail reads), and scaled so its farthest
point is at that radius; it is round where the splat floor, not the footprint, sets the size. The
whole patch lights during the flash's pulses (its profile from 0.35, whole from 0.7, whatever its
energy, which sets the level), 0.65 of it between them, where its light has drifted; at least 2
texels, and `150 w²` km from afar, as on the globe. It is drawn at `0.35 + 0.65 w` of its level
(43 % at the floor), so channels read over it; in a storm view the map keeps the brightest flash at
each point, never their sum. The cloud reads the map sharpened, `pow(light, 1.25 - 0.25 w)` (1.22 at
the floor, none over the whole globe), adds `1 - exp(-5 × light)` of the flash colour into its
headroom only, in the flat layer and in the volume alike, and keeps 35 % of it over sunlit cloud (from
a local sun 3° below the horizon to 14.5° above it), a styled trace like the channel's (physics:
nothing of a flash shows by day). Where the clouds are in relief, the volume lights each column in a
band of 3.5 km half width (1/e) centred 3 km under the column's own top where that top rises above
11.5 km and at the assumed flash height of 8.5 km otherwise, read at the two depths that split the
light each crossing sends back into quarters (so a column looks the same whether the march takes it
in one piece or in many), at 1.8 times the flat layer's level: towers glow near their crown, thin
anvils veil, low cloud stays dark, so the lit area takes the cloud's shape (ADR 0031). Reduced motion
keeps the whole patch, its heading set by the seed.

## Reduced motion

With `prefers-reduced-motion: reduce`, there is no flicker: one soft fade, rising over 60 ms, falling with
a 250 ms time constant, then following the same glow, whatever the kind. Light does not drift and
channels show whole, their branches fading first: no leader, no return stroke sweeping up, no dart, no
stutter.
