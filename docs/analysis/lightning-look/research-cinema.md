# Cinematic and rendering references for an ambient, ethereal look of lightning seen from orbit

> Research notes of the lightning look rework ([#398](https://github.com/pierregc/scintille/issues/398)),
> kept as written on 2026-10-31 except for a few long quotations turned into paraphrases. Line numbers
> refer to `main` at b1b35cf; `<scratchpad>` is the rework's working folder, not in the repository.

Phase 1 research, 2026-10-31. Read-only pass over the repository (`web/src/globe/lightning/`,
`docs/flash-profile.md`, `docs/immersive-view.md`, ADR 0020, ADR 0030, `docs/visual-direction.md`)
and the web. Line numbers refer to `main` as read today. Numbers from the web carry their source in
brackets; the source list is at the end. Anything I could not verify is marked as such.

## 0. The findings that matter for the redesign

1. **From orbit a flash is a lit patch of cloud, not a line.** GLM flashes have a median footprint of
   291 km² (radius 9.6 km), mean 454 km², 90th percentile 965 km² (r 17.5 km), 99th 2,570 km² (r 29 km)
   [Rudlosky 2018]. Intense convective cores produce frequent *small* flashes (< 300 km²), weakening
   and stratiform regions produce *large* ones (> 600 km²) [GLM quick guides]. Astronaut photos show
   the flash revealing the cloud-top texture (updraft towers brighter and darker) rather than a flat
   disc [NASA EO Türkiye]. At night the light also spills onto low clouds some distance from the
   convection ("low-cloud illumination by nearby deep convection") [GLM quick guides]. Channels are
   almost never seen from orbit through cloud tops; what GLM's total optical energy shows inside a
   large flash is a *brighter ridge* along the channel, not a thread [GLM quick guides, TOE page].
   Today's light map splats a structureless disc `exp(-4 r²)` (`light-map.glsl.ts:73`) drawn at 45 %
   near the floor: that disc is the "ball".
2. **A real flash is discrete pulses separated by darkness, then a long dim tail.** A 0.4 s GLM flash
   "produces discrete optical emissions separated by periods of darkness" [GLM quick guides]; median
   flash duration 0.52 s globally [Wikipedia, LIS/OTD]; GLM mean durations 293 ms on land, 345 ms over
   the ocean [Rudlosky 2019]; exceptional flashes last 3.7 s over 86 km, megaflashes 17.1 s and
   768 km [GLM quick guides; WMO 2022]. Scintille's profile (`profile.ts:2-41`) already matches the
   pulse structure. What it lacks is *variety of kind*: every flash flickers the same way.
3. **Time compression is the whole problem, and it is a perception problem, not a data problem.**
   Basse-Kotto peaks at 600 flashes a minute, 10 a second in real time. At 60× that is 600 flashes
   started per wall second, at 600× 6,000, at 3600× 36,000. The eye registers at most about 2 to 3
   *distinct* events a second (attentional blink 200 to 500 ms [PMC2848898]) and tracks 3 to 4
   simultaneous objects (up to 8 when they move slowly) [MOT, Pylyshyn & Storm; Alvarez & Franconeri].
   Observers call 16 to 40 flashes a minute (0.3 to 0.7 a second) at Catatumbo "a continuous
   lightning" [Wikipedia Catatumbo]. So a storm reads as a storm from about 0.3 visible flashes a
   second; above about 3 distinct events a second it reads as noise unless the events merge into a
   single moving glow, which is the "light bulb that moves" at 3600×. The `STORM_VIEW_FLASHES = 500`
   cap (`index.ts:105`) does not help legibility: at 600× it cuts every flash to its first 83 ms, at
   3600× to 14 ms (500 ÷ 36,000 per second), so no flash gets to be *a* flash.
4. **Screen blending saturates; photographers and satellite dashboards use max.** Screen of N glows
   at level a gives `1 - (1 - a)^N`: 100 overlapping glows at 0.05 reach 0.99. Lightning stackers use
   Photoshop *Lighten* (per-pixel max), explicitly rejecting Screen and Add because they double up the
   sky [Willmore, CreativeLive]. Scintille already max-blends the light map in a storm view
   (`index.ts:425`) but screen-blends the round glows (`index.ts:318`): near the floor the glows, not
   the light map, build the ball.
5. **Every serious lightning visualisation with time compression bins or samples and says so.**
   EUMETSAT's animations show one minute of flashes per frame (2023), two hours coloured by age from
   white (≤ 20 min) to dark red (100 to 120 min) (2024), or one hour in 10-minute bands (2025) [ESA
   2023; EUMETSAT 2024; EUMETSAT 2025]. GLM dashboards grid flashes into 2 × 2 km cells per 1 and
   5 minutes (flash extent density), sum optical energy (TOE, "like watching a light bulb brighten and
   dim") and average flash area [GLM quick guides]. Blitzortung shows the last 60 minutes coloured by
   age with a one-minute red ring for new strikes. Dot-density cartography states "one dot = N" in
   the legend, keeps a fixed random seed, and aims for the densest cluster to still show texture
   rather than a solid fill [MapAtlas]. The honest form for Scintille is the same: name the sample
   ("one flash in N drawn with its channel, every flash lights the cloud"), choose it deterministically
   from the flash seed (`channel.ts:31`), keep every flash in the cloud light so none is removed (ADR
   0030 point 1), and show the rest as a diffuse, max-blended, decaying light.
6. **Most vertical channels are not cloud-to-ground.** Globally about 25 % of flashes are CG, but in
   the tropics only about 10 % [Wikipedia, citing LIS/OTD studies]; Basse-Kotto is at 3.4° N. The
   in-cloud flash, however, *starts vertical*: an initial ascending leader between the mid-level
   negative and upper positive charge, then a transition, then horizontal spread [Duke dissertation;
   LMA studies]. So the maintainer's wish for mostly vertical and oblique channels can be met honestly
   by giving in-cloud flashes a vertical trunk (3 to 5 km of climb) before their horizontal spread,
   while keeping the CG share near the observed 10 to 25 %. Today both in-cloud leaders and the first
   segment of ground flashes are flattened (`skeleton.ts:77` `v[2] *= 0.3`, `:153` heights clamped to
   8 to 11.5 km, `:226` horizontal feed leader), and the 20° framing tilt (`replay/framing.ts:8`)
   foreshortens anything vertical to a third of its length.
7. **Real timings, then stretch them once, for every flash alike.** Stepped leaders descend at 1 to
   14 × 10⁵ m/s (average 4.4 × 10⁵) [Wikipedia, UF], so 5 km takes 4 to 50 ms, typically about 11; in
   Warner's 7,207 fps footage the leader is visible about 15 ms before attachment [APOD 2012]. The
   return stroke runs at about 10⁸ m/s (70 µs) and most negative CG flashes carry 3 to 4 strokes
   40 to 50 ms apart; dart leaders follow the old channel in about 1 ms; continuing current lasts tens
   to hundreds of ms [Wikipedia; Rakov & Uman summary]. Game and film practice stretches these so
   they read: a leader that visibly crawls over 100 to 300 ms, a return stroke that fills in one frame
   from the ground up, strokes 60 to 120 ms apart, branches that die before the trunk ("the small
   fragments should drop out first and the main bolt should linger a few frames longer") [realtimevfx],
   and a total of about 3× the real duration for a hero bolt [Roblox thread, informal]. Scintille's
   ground leader reaches the ground within 20 ms (`profile.ts:27`, `ribbon.glsl.ts:75`), one frame:
   the descent, the one thing everyone recognises as lightning, is not visible.
8. **The ambient language is restraint and cadence, not emptiness.** Eno's *77 Million Paintings*
   changes every few seconds by cross-fade and he calls it "ambient music for the eyes" [Cyclic
   Defrost 2006]; slow cinema averages minutes per shot where television forbids a shot over six
   seconds [Bordwell; indiecinema]; Norwegian slow TV sells "the feeling of being present in real
   time and space" with no commentary [NRK via Wikipedia]; Olbinski's storm time-lapses are 1 to 4 s
   intervals, 600 to 800 frames per clip, often black and white [NatGeo; Colossal]. Ikeda's *test
   pattern* is the counter-example on purpose: data at the limit of perception [YCAM]. For lightning
   this translates into: few hero events (one every 0.5 to 3 s), each allowed to unfold completely,
   over a slowly breathing field of light; long decays; low saturation; negative space around the cell;
   the camera still.

## 1. ISS and satellite footage of lightning at night

### 1.1 What the eye and the camera see from the ISS

- **Lit areas, not bolts.** The NASA Earth Observatory image of a storm over western Türkiye
  (ISS070-E-21172, Nikon D5, 85 mm, 4 Nov 2023) shows "two separate lightning flash areas" within one
  storm system; the brief flashes "revealed the cloud tops of cumulonimbus clouds", with dark and light
  patches inside the lit area showing the updrafts [NASA EO Türkiye]. The lit patch is structured by
  the cloud: towers catch the light, gaps stay dark. A ring-shaped flash over the Gulf of Thailand was
  "illuminated in blue" [Yahoo/NASA photo round-up]. Astronauts use the camera's time-lapse mode with a
  shutter long enough to catch a flash; Don Pettit's high-speed series ran at 120 frames a second with a
  flash filling one frame [Starlust; Interesting Engineering].
- **How large relative to the storm.** With an 85 mm lens from 400 km the frame is a few hundred km
  wide and each lit patch is a small fraction of the storm complex: the GLM statistics above (median
  radius 9.6 km, 90th percentile 17.5 km) are the right scale, and match Scintille's observed 5 to 19 km
  radii. Night-time flashes look larger than identical daytime ones because of the dark background and
  because nocturnal storms, grown into mesoscale systems, produce larger flashes [GLM quick guides].
- **How often channels show.** Essentially never through an anvil. Thin filaments appear only at the
  edge of a storm, under thin cloud, or in gaps; cloud cover "hides the lightning activity from the
  astronauts above" [Interesting Engineering]. From geostationary orbit the channel appears only as the
  brighter ridge of total optical energy inside an extensive stratiform flash [GLM quick guides].
- **Colour.** Pale blue-white on the cloud tops, warmer only where city lights or dust are in the
  frame; the red of sprites sits far above (50 to 85 km) [NASA EO Sprites]. Scintille's `#E4EBFF`
  (`index.ts:180`) is consistent with the photographs.
- **Time-lapses from the ISS.** Alexander Gerst's 21,000-image ESA time-lapse is shown at 12.5× real
  time and shows "numerous flashes of lightning during night time" [DLR]: at 12.5× every active cell
  twinkles almost every frame, which is the look the maintainer calls "a lit Christmas tree". The NASA
  sprite sequence of 26 June 2024 (Nikon Z9, 28 mm) was stitched at 25 to 29 fps from "short intervals"
  [NASA EO Sprites]. Pettit's 25- and 30-minute single exposures show an hour of lightning as
  "sequential points of light" under star trails, not as a wall: the integration of a whole storm is a
  scatter of small bright points because each flash lights only its patch [Starlust; Pettit via
  Starlust]. Matthew Dominick's 2024 Crew Dragon time-lapses show "numerous flashes of lightning over a
  wide area" with fishing-boat and city lights [Digital Trends].

### 1.2 What GLM and the MTG Lightning Imager see

- **Instrument.** GLM compares each 2 ms frame to a running background; an *event* is one pixel above
  threshold in one frame, a *group* adjacent events in one frame, a *flash* groups within 330 ms and
  16.5 km. Pixels are 8 km at nadir to 14 km at the limb; the LI records 1,000 frames a second with
  four cameras, pixels about 4.5 km [GLM quick guides; ESA 2023; brief].
- **Flash structure.** "The GLM maps the extent of the cloud illuminated by individual lightning
  flashes", and flash skeletons built from groups show one flash growing across tens of km with
  "discrete optical emissions separated by periods of darkness" [GLM quick guides, p. 2]. Two
  exceptional flashes seen by GOES-East and -West: 784 and 1,018 groups, 4,667 and 6,106 events, 3.73
  and 3.74 s, 85.9 km across.
- **Sizes and energies.** Mean 454 km², median 291 km², p90 965, p99 2,570 km²; median group area
  135 km²; median 22 events per flash [Rudlosky 2018]. Ocean flashes are larger (570 km²), longer
  (345 ms) and brighter (420 fJ) than land flashes (431 km², 293 ms, 230 fJ) [Rudlosky 2019]. Average
  flash area runs from one pixel (about 64 km²) to thousands of km² in stratiform regions; the most intense convection makes frequent small flashes (< 300 km²) and
weakening storms larger ones (> 600 km²) [GLM quick guides]. The flash position is a radiance-weighted centroid
  that "may not always fall along the lightning channel, but will always fall within the flash
  footprint" [GLM quick guides, p. 1]: the "exact point" the maintainer sees at 60× is an artefact of
  drawing the centroid as the origin of everything.
- **Continuing current from space.** rebound events, spikes stretching south of strong flashes, mostly at night,
point to flashes with continuing current [GLM quick guides]: a detector-level hint that a share of night flashes hold a long steady glow.

### 1.3 How the official visualisations handle time compression and dense storms

| Visualisation | Unit drawn | Time compression and decay | Density handling |
|---|---|---|---|
| NASA Earth Matters GLM clip, Texas, 14 Feb 2017 | GLM observations over ABI cloud imagery, rendered to "simulate what the eye might see from above the clouds" | Rendered at 25 fps from 500 fps data; compression not stated | Flashes drawn as lit patches on the cloud, no symbols [NASA Earth Matters] |
| NASA SVS 10936, Alabama, 2 Sep 2012 | Ground-mapped flashes over GOES-14 1-minute clouds, proof of concept for GOES-R | 1080p30 | Points of light on clouds [SVS 10936] |
| ESA / EUMETSAT MTG-LI first animations, July 2023 | One minute of lightning per frame over a single LI image of the Earth | Each frame = 1 min of flashes | Accumulation per frame, white on grey [ESA 2023] |
| EUMETSAT data debut, July 2024 | Flashes of the past two hours in every frame | Colour by age: white ≤ 20 min, dark red 100 to 120 min | Age replaces decay; the storm's history is its shape [EUMETSAT 2024, via search] |
| EUMETSAT "More than half a billion flashes", 2025 | Lightning *groups* (lit pixel clusters per 1 ms frame) in 10-minute bands over the last hour; accumulated flash area over FCI GeoColor | White (≤ 10 min) to dark red (50 to 60 min); near-real-time megaflash sequence coloured over several seconds | Accumulated flash area "shows the whole electrically active cloud system rather than isolated strike points" [EUMETSAT 2025] |
| GLM gridded products (AWIPS, CIRA SLIDER) | Flash extent density per 2 × 2 km cell, 1-min and 5-min windows; total optical energy (sum); average flash area; NASA SPoRT 30-minute density where "single large flashes stay 30 minutes" | Windowed counts, updated every minute | Colour tables, warm colours for convective cores; TOE "like watching a light bulb brighten/dim as the storms grow/decay" [GLM quick guides; NTRS 20180006726] |

What these have in common: at compression they never draw every flash as an individual event. They
bin (per minute, per cell), sum (TOE), or encode age in colour, and the picture of a dense storm is a
*map of where light has been* rather than a swarm. Scintille's "a window, not a control room" rules out
colour-by-age and legends, but the underlying move (recent light bright and sharp, older light dim and
diffuse, every flash counted once, nothing piling up) can be done photographically with a max-blended
light map that decays.

### 1.4 Other satellites

Himawari-8/9 carry no lightning imager (JMA relies on ground networks); FY-4 carries a Lightning
Mapping Imager over Asia (not verified in this pass). The relevant visual references for Asia remain
ISS photography and ground time-lapses.

## 2. Storm time-lapse cinematography from the ground and from planes

### 2.1 Compression ratios in practice

- Mike Olbinski shoots 600 to 800 exposures per clip at 1 to 4 s intervals, "every second, every two
  seconds, every three seconds, whatever I'm out there trying to do", and pauses the intervalometer to
  adjust shutter speed when lightning starts [NatGeo; PBS; Shuttermuse]. Played at 24 to 30 fps that is
  24× to 120× real time, with 60× in the middle of the range: Scintille's default speed is the
  photographers' speed. His 60,000-frame *Vorticity* became six minutes [PetaPixel 2016].
- ISS time-lapses run at about 12.5× (Gerst) to the 25 to 29 fps stitched sequences of NASA's 2024
  clips [DLR; NASA EO Sprites].
- Above about 100×, storm time-lapses stop showing individual flashes; what remains is the cloud
  structure pulsing. Nobody publishes storm time-lapses at 600× or 3600× as *lightning* films; at those
  speeds the subject is the cloud's motion (anvils spreading, cells advancing, outflow), with lightning
  as a flicker inside. That is the strongest argument for making the cell's motion and the cloud light
  the subject at 600× and 3600×, and the hero flashes rare.

### 2.2 How many flashes a second read as a storm, not as noise

- **Physics.** Severe storms run 60 to 100 flashes a minute (1 to 2 a second), hundreds a minute in
  the most intense hailstorms [NASA SPoRT studies via search; EUMETSAT lightning-jump notes]. Catatumbo's
  16 to 40 flashes a minute were called "a continuous lightning" in 1841 and still are
  [Wikipedia Catatumbo]. Basse-Kotto at 10 a second is far beyond what a human observer resolves even
  at 1×.
- **Perception.** The attentional blink: a second target within 200 to 500 ms of the first is usually
  missed [PMC2848898]; so about 2 to 3 distinct events a second at *different places* is the ceiling for
  reading them as separate flashes. Multiple-object tracking: 3 to 4 simultaneous objects, up to 8 when
  slow and well spaced [Wikipedia MOT; Alvarez & Franconeri 2007]. Bloch's law: brightness integrates
  over about 100 ms, so a 15 ms pulse reads at its energy, not its peak [Webvision; FAA AM70-15].
- **Working numbers.** A storm reads as a storm from about 0.3 visible flashes a second (one every
  three seconds), reads as "active" at 1 a second, and turns into noise above about 3 distinct events a
  second unless they are allowed to merge into one slow glow. Within a second, pulses closer than
  100 ms belong to the same flash to the eye.

### 2.3 Stacks and long exposures: a wall of light, and the honesty debate

- Stacking is a fixed camera, many 20 to 30 s frames, blended with *Lighten*, which keeps the brighter pixel of the frames, where Screen would add the
sky's brightness to the light under it and double it [Willmore, CreativeLive]. The sky stays as dark as in one frame; each bolt keeps its own peak. Dan Robinson notes
  a single exposure would have had to run about 20 minutes to catch every strike of his Lexington set,
  and that stacking is "the same outcome as one long exposure" [Storm Highway via search].
- The honesty argument: Robinson holds that viewers do not assume simultaneity and every strike did
  happen; Olbinski long felt stacks "took away from the beauty of a single strike"; a Turkish
  photographer found viewers believed all bolts struck at once *despite* the composite label
  [PetaPixel 2023 via search]. A text label is not enough: the picture itself must say "not at once"
  (hence age fading, a cadence, a few events at a time).
- Pettit's 25-minute ISS exposure is the orbital version of a stack: sequential points of light, each
  a patch, none a wall [Starlust].

### 2.4 The look of a channel in long exposure

- The main channel saturates to white; fainter branches show "a combination of the blue-white thermal
  continuum and the purple output of ionized nitrogen" [Storm Highway, via search snippet]. The violet
  halo of photographs is largely N₂⁺ emission plus sensor blooming and white balance; to the eye the bolt
  is "purplish to blue but usually so bright that it appears just white" [Weerwoord thread, physicist's
  reply, via search]. Film reciprocity pushed slide film blue and print film orange [Storm Highway].
- Distance and medium: far lightning on the horizon goes yellow, orange, red by Rayleigh scattering,
  dust makes it brownish, large raindrops and hail scatter neutrally so rain keeps it white; water vapour
  can add a pink cast [WSLS; Weerwoord; forum sources, weak]. Volcanic ash makes it orange-red.
- Structure: a bright trunk that keeps its width to the ground; branches thinner and dimmer, dying out
  in the air; a soft glow that scales with the trunk's brightness [Reis & Fernandes rendering notes;
  photographs]. In high-speed footage the return stroke fills the whole channel in one frame even at
  1,000 fps ("some bolts... only lasted for one frame") [Farrell via PetaPixel 2017], while the stepped
  leader before it crawls and forks for about 15 ms [APOD 2012, Warner].
- Scintille's ribbon already has the right ingredients: white core mixed half with the flash colour
  (`ribbon.glsl.ts:172`), cool, rosy or warm halo tints (`:148`), halo 8 widths at 30 % (`:137`, `:166`),
  hairlines drawn at 0.75 px with their light scaled down (`:120-123`). The missing pieces are the
  descent, the stroke-by-stroke re-illumination of the *same* path, and width and brightness that
  differ between flashes by more than the 0.85 to 1.25 `widthScale` of `skeleton.ts:212`.

## 3. Real-time and VFX techniques for lightning

### 3.1 Procedural shape

| Method | What it gives | Cost and control | Reference |
|---|---|---|---|
| Random line segments / midpoint displacement | Branches deviate about 16° on average from the parent, angles normally distributed; cheap, fully seeded | Microseconds per path; no physics of where branches go | Reed & Wyvill 1994 [SIGGRAPH history]; Kim & Lin's summary of it. Scintille's `wander()` (`skeleton.ts:87-117`) is this family, with bends plus roughness 0.18 to 0.34 decaying by 0.88 per level |
| Dielectric breakdown model (DBM) | Laplacian growth on a grid; η controls branchiness (η = 1 dense, higher sparser, η ≥ 4 a one-dimensional curve); the main channel is the path to ground, the secondary channel the longest side tree; charge fields attract or repel the bolt | Seconds per bolt on a grid in 2004; the KAIST approximation is 20× faster in 2D and 320× in 3D; Matsuyama's GPU solve reaches real time with 2 to 4 CG iterations | Kim & Lin 2004 [UNC]; Kim & Lin 2007 adaptive grid [UNC Fast]; Yun et al. [KAIST] |
| Space colonisation | Growth toward attractors in an envelope; a weighted goal direction (half the growth) keeps it from looping; branch roots sampled by probability; branch inclination 30° to 135° from the parent, wide near the cloud "sometimes even growing upwards", narrower near the ground; fallback to Reed & Wyvill's 16° steps | Milliseconds; natural tapering and competition for space | Reis & Fernandes 2022 [Minho]; Runions et al. 2007 [algorithmicbotany]; Tanaka et al. 2021 field-guided variant |
| L-systems | Grammar-driven branching; rarely used for lightning because the result reads as a plant | Trivial | No dedicated lightning L-system found in this pass |

For Scintille the midpoint family is the right cost for 24 builds per frame and 256 segments
(`channel-pool.ts:10-12`, `skeleton.ts:5`). What the DBM and space-colonisation papers add is *policy*,
not a solver: a dominant trunk chosen first, one long secondary channel, side channels ending in the
air, branch angles wide at the top and narrow near the ground, and the downward bias of a goal
direction. These are cheap to fold into `branch()` (`skeleton.ts:156-196`) and `wander()`.

### 3.2 Animating a flash: real timings and how they are stretched

Real values [Wikipedia Lightning; Rakov & Uman summary; APOD 2012; Scientific Reports 2022]:

| Phase | Real duration or speed | Stretched for readability (practice) |
|---|---|---|
| Stepped leader descent, 5 km | 4 to 50 ms (1 to 14 × 10⁵ m/s, average 4.4 × 10⁵); steps of about 45 m with 20 to 50 µs pauses; visible about 15 ms before attachment in 7,207 fps footage | 100 to 300 ms crawl, forking as it goes, dim (a tenth of the stroke) |
| Return stroke | About 10⁸ m/s: 5 km in 50 to 70 µs; the channel then "pulses with charges moving back and forth" | One frame, from the ground up, full brightness; branches lit at once and dying first |
| Interstroke gap | 40 to 50 ms typical; 3 to 4 strokes per negative CG, up to 30 | 60 to 120 ms; 1 to 5 strokes |
| Dart leader | About 10⁷ m/s, 1 ms, little branching, same path | A faint streak down the old path over 2 to 4 frames |
| Continuing current | Tens to hundreds of ms, a share of flashes (GLM: "rebound events") | A steady 20 to 30 % hold, 100 to 400 ms |
| In-cloud flash | Ascending leader, transition, horizontal spread; VHF breakdown at 7.4 to 9.0 km; median 0.5 s total; megaflashes 5 to 17 s over 100 to 800 km | A vertical climb of 3 to 5 km over the first 100 to 200 ms, then horizontal crawl at a pace that shows (a few km per 100 ms), pulsing while it spreads |

Practice notes from effects artists: vary the hold ("sometimes it freezes in the sky and sometimes it's a
quick flash") [Adobe Animate tutorial]; do not fade the whole bolt uniformly, drop the fragments first
and let the trunk linger; insert an in-between frame between the flash and the fade [realtimevfx];
start the bloom at full strength on impact and fade it [Roblox thread]; a hero bolt totals about three
seconds where reality takes one [same, informal]. Reis & Fernandes animate the strobe as chained
"waxing and waning" phase pairs and grow the geometry node by node "as if a stepped leader... propagating
through the air" [Minho].

Scintille today: in-cloud leaders crawl over 80 % of the flicker (`profile.ts:26`, `cloudSpread`), which
is right; ground leaders reach the ground within 20 ms (`profile.ts:27`), which hides the descent;
branches light once per flash (`ribbon.glsl.ts:77-83`) and the trunk relights on each pulse, which is
right; there is no dart-leader streak, no distinction between a one-stroke and a five-stroke flash in
the *channel* (only in the glow), and every ground flash forks the same way.

### 3.3 Bloom and HDR with many emitters

- Jimenez (Call of Duty: Advanced Warfare, SIGGRAPH 2014): no threshold; the blurred layer is mixed
  at a low weight (about 0.04) so "only very bright pixels will bloom noticeably"; a mip pyramid with
  3 × 3 tent upsampling for stability; fireflies killed at the first downsample by a weighted average
  with weights `1 / (1 + luma)` (Karis average), renormalised; exposure applied after bloom is
  equivalent to before [iryoku]. Unity: threshold near 1 for HDR scenes, a soft knee from 0 (hard) to 1
  (fully gradual), and a clamp on how much a pixel can bloom [Unity docs].
- Applied to many emitters: the Karis average is per-pixel exposure normalisation by count; a max or
  soft-max (log-sum-exp) accumulation bounds the input to the bloom to the brightest single emitter; a
  low bloom weight makes the halo a property of the few brightest flashes, not of the crowd.
- Scintille: `BLOOM = { strength: 0.9, radius: 0.55, threshold: 0 }` (`post.ts:22`), strength scaled by
  `0.15 + 0.85 f` (`zoom.ts:44-46`), exposure 1.6 (`index.ts:179`), screen-blended over the frame
  (`post.ts:76`). Near the floor bloom is already small; the whitening comes from the glow and light-map
  accumulation, so the lever is the blend equation and the per-flash level, not the bloom.

### 3.4 Ribbon quality: anti-aliasing, width, keeping a thin channel readable

- Screen-space quads with per-fragment distance to the skeleton and a smoothstep edge; derivative-based
  widths (`fwidth`) keep a line about one pixel at any distance [Evan Wallace; forum sources]. A fade
  band of 90 to 110 % of the half width is a common choice. Hairlines below a pixel should be drawn one
  pixel wide and dimmed, never thinned, or they dash (Scintille does this, `ribbon.glsl.ts:120-123`).
- Cartography makes thin lines legible over variable backgrounds with *casing* (a contrasting outline)
  or a halo; the QGIS advice is a halo darker than a light line, blended in "darken" mode so it shows
  only where it is darker than the background, lightly blurred [QGIS Planet; ArcGIS]. Scintille's
  photographic rule forbids outlines (ADR 0030 point 4), so the equivalents are: dip the local glow while
  the channel shows (already `vDip`, `lightning.glsl.ts:63`), keep the light map at 45 % near the floor
  (`LIGHT_WINDOW.nearLevel`), and make the channel's core brighter than anything the cloud light can
  reach (max-blended cloud light caps the background at one flash's level; the core adds on top).
- Width by distance: trunk 1.4 to 2 CSS px, branches 60 %, halo 8 widths are reasonable for a channel
  99 px long at `iss`; what reads as "thin and electric" in photographs is the *contrast* between the
  trunk and its branches (a factor 3 to 10 in brightness) more than absolute width.

### 3.5 Lighting clouds from inside

Guerrilla's Nubis Evolved (Horizon Forbidden West) added "internal lighting and lightning flashes" to
its volumetric superstorms [GDC Vault 1027688; Guerrilla]: the flash is a light *inside* the volume,
and each ray-march sample receives it attenuated by the cloud between the sample and the flash, so the
lit region takes the shape of the cloud (towers bright, hollows dark, edges glowing) rather than a
disc projected onto the top. (The slide deck exceeded the fetch limit; the mechanism is the standard one
for a point light in a participating medium and is described in the talk abstracts.) Scintille's volume
already marches with the flash light map (`volume.glsl.ts` around line 372, Gaussian around 8.5 km,
gain 5, × 2.5): replacing the disc splat by a per-flash position fed to the march, attenuated by the
baked opacity, is the closest real-time equivalent, and it is what the ISS photographs show.

## 4. Density policies in data visualisations with time compression

### 4.1 Catalogue

| Map | Data | Window and decay | Density | Honesty device |
|---|---|---|---|---|
| Blitzortung live maps | Ground network strokes | Last 60 min; new strike a red ring shrinking over 1 min; colour from yellow (or white in older legends) darkening to dark brown near 60 min; "reload after" countdown re-ages the colours | Every stroke drawn as a dot; at high zoom an expanding translucent white "thunder front" ring at the speed of sound | Age encoded in colour; nothing hidden [Blitzortung forum; discoverairdrie] |
| lightningmaps.org | Same network | Same scheme, legend not always shown | Same | Same |
| Windy, thunderstorm layer | ECMWF *forecast* flash density (per km² per day or 3 h, disputed) | Hourly to 6-hourly steps | A continuous field, no strokes | A forecast shown as a field, not as events [Windy community] |
| Windy, weather radar layer | Real-time strokes | Up to 6 h, "past impacts as a colored area from yellow to deep brown" | Area, not points | Age colour [Windy community] |
| Ventusky | Blitzortung strokes plus forecast icons 24 h ahead | Real time | Dots on the radar | Observed and forecast drawn differently [letemsvetemapplem] |
| earth.nullschool.net | Wind (no lightning) | Particles aged up to 100 frames (4 s at 40 ms); each frame the previous trails are kept at alpha 0.97 (0.95 on Firefox), a half-life of about 0.9 s | 7 particles per pixel of width (about 13,000 at 1920 px), 1 px lines, colour by speed bucket, overlay at 0.4 alpha | Constant density whatever the data; motion is the signal [cambecc/earth source] |
| GLM dashboards (AWIPS, SLIDER, SPoRT) | GLM flashes | 1-min and 5-min FED, 30-min density | Counts per 2 × 2 km cell; TOE sums energy; AFA | Units in the colour bar; single large flashes persist their full window [GLM quick guides; NTRS] |
| EUMETSAT LI animations | Groups and flashes | 1 min per frame (2023); 2 h window white to dark red (2024); 1 h in 10-min bands (2025) | Accumulated flash area for the active system | Age in colour; "not for operational use" caveat [ESA; EUMETSAT] |
| Dot density maps | Aggregates | Static | One dot = N, fixed seed, dasymetric placement; densest cluster must still show texture | Legend states the dot value with the prominence of a scale bar [MapAtlas] |

### 4.2 Honest ways to show "one in N"

What the catalogue and the stacking debate say together:

1. **Name it where the eye is.** The legend of a dot map, the colour bar of FED, the "composite"
   label of a stack. For Scintille, the methodology page and the storm's own caption ("Showing one flash
   in 12 with its channel; every flash lights the cloud") are the places; the HUD rule of no legend
   leaves the caption.
2. **Make the picture say it too.** Composites labelled as such were still read as simultaneous
   [PetaPixel 2023]. A cadence (one hero event at a time), decays, and a diffuse layer that visibly
   carries "the rest" are what stop the misreading.
3. **Sample deterministically.** Fixed seed in dot maps; `flashSeed` (`channel.ts:31`) in Scintille, so
   a revisit shows the same hero flashes and a shared URL shows the same picture.
4. **Sample by a stated rule.** "Strongest first" is defensible because energy is observed and the
   brightest flashes are the ones a camera would catch; "one in N by seed" is the dot-map rule; a mix
   (strongest always, then one in N) is also nameable. What is not honest is adaptive thinning that
   depends on frame rate or screen size without saying so.
5. **Never remove a flash from the data layer.** ADR 0030 point 1: no styling removes a flash. A
   density policy that keeps every flash in the cloud light (max-blended, decaying) and draws only a
   sample as glow sprites and channels removes nothing: each flash still lights the cloud at its
   observed time, position, footprint and energy. This needs its own ADR (the density policy by replay
   speed is a choice that affects several tickets; the next free number is 0033, since 0032 is the free
   camera tilt).
6. **Keep the compressed window visible as texture, not as brightness.** FED and the EUMETSAT age
   colours keep *where* light has been without adding it up. Photographically: a light-map decay of
   seconds of wall time (nullschool's 0.9 s half-life is a good first value; up to 2 to 3 s at 3600×) at
   a level that never exceeds one flash's, so the advancing front reads as a wave and never as a bulb.

### 4.3 What this suggests for 60×, 600× and 3600×

Working proposal derived from the perception numbers and the catalogue, for the tickets to settle
(numbers to be tuned on Basse-Kotto and R1 captures):

| | 60× (default) | 600× | 3600× |
|---|---|---|---|
| Flashes started per wall second at Basse-Kotto's peak | 600 | 6,000 | 36,000 |
| Hero flashes (full flicker, channel, glow) | 2 to 3 new per wall second, at most about 6 to 8 lit at once; strongest first, then one in N by seed | about 1 to 2 per second, at most 4 to 6 lit; one in N with N about 10× larger | about 0.5 to 1 per second, at most 2 to 4 lit; N 10× larger again |
| Everyone else | Cloud light only, max-blended, decaying over about 1 s | Cloud light, decay about 1.5 s: the front reads as a wave | Cloud light, decay about 2 to 3 s: a sweeping front that moves with the cell (tens of km per second on screen) |
| Round glow sprites | Hero flashes only near the floor; max-blended; from afar every flash as a point (visual rule 1) | Same | Same |
| What differs visibly between the speeds | Individual flashes can be followed | Flashes are rarer and the storm's shape breathes | The cell *moves*; lightning is the texture of a travelling glow with occasional hero strikes |

The 500-newest cap can stay as a cost bound (it kept 3600× at 10 to 15 ms, `docs/immersive-view.md`)
but should stop being the *legibility* policy: it truncates every flash instead of choosing a few.

## 5. The ambient / drone / ethereal visual language

### 5.1 What the references do

- **Brian Eno, *77 Million Paintings* (2006).** 300 to 550 hand-made layers recombined by software;
  "changes occurring every few seconds as one piece is faded into another"; Eno: "ambient music... that
  approached the condition of painting... now I am doing the obverse" [Cyclic Defrost; Hot Press]. The
  method is cross-fade, slow cadence, no narrative, no event louder than the field. Pacing lesson: one
  change every few seconds is enough to feel alive.
- **Ryoji Ikeda, *test pattern* / *datamatics*.** Data converted to barcode patterns at "the limits of
  human perception", explicitly a "response test for audience perception" [ISEA; YCAM; ilikethisart].
  The counter-example: density as the subject. Scintille at 3600× today is accidentally Ikeda.
- **Refik Anadol, *Unsupervised* (MoMA 2022).** Continuous morphing; visitors lingered "thirty minutes
  or more" against a museum average under 20 seconds, though critics found "no emotional text" in the
  endless animation [Feral File; Artnet]. Lesson: slow continuous change holds attention; it needs
  events to mean something.
- **Slow cinema and slow TV.** Tarr's *Sátántangó* averages about 2.5 minutes per shot against 2.3 s
  for *Armageddon*; television editors consider a shot over six seconds inadmissible [Bordwell;
  indiecinema]. NRK's *Bergensbanen* and *Hurtigruten*: "the feeling of being present in real time and
  space", minimal commentary, "the mundane instead of the thrilling" [Wikipedia Slow television]. Lesson:
  a still camera and real duration are themselves the content; cuts and jumps are what break the
  spell. Scintille's still camera while a storm is open (`docs/immersive-view.md`, "Still camera") is
  already in this tradition.
- **Storm time-lapse auteurs.** Olbinski's *Breathe* in black and white, slow pans, 1 to 4 s intervals
  [Colossal; NatGeo]; Farrell's *Transient* at 1,000 fps where each bolt unfolds for seconds [PetaPixel
  2017]; Warner's 7,207 fps research footage [APOD]. Lesson: either stretch one event so it can be
  watched, or compress the cloud and let lightning be its pulse; never both at once.
- **Koyaanisqatsi / Baraka / Timescapes.** Time-lapse paired with drone-like scores; the storms in
  them are cloud motion with flicker, graded cool and desaturated (not re-verified in this pass; cited
  as a shared cultural reference).

### 5.2 Translation into pacing and density rules

1. **A few strong events rather than many weak ones.** Hero flashes get the full treatment (visible
   descent, return stroke, re-strikes, branches dying first, a long dim tail); the field gets light
   without edges.
2. **Cadence, not rate.** Target one hero event every 0.5 to 3 s of wall time whatever the replay
   speed, with gaps that vary (log-triangular like the pulse gaps, `profile.ts:77-82`), so the storm
   breathes instead of ticking.
3. **Long decays, soft falloff.** Light leaves slowly: the glow tail and the light-map decay are the
   "reverb" of the picture. Nothing cuts to black within a frame except the return stroke's rise.
4. **Negative space.** Keep dark cloud around the lit cell: the lit area stays within the observed
   footprint (visual rule 5) and the light map does not spill the whole anvil at once; the cell
   advancing into darkness is the composition.
5. **Desaturated, photographic.** Blue-white core, warmth only from cloud or dust, never a scale; the
   grade of ISS photographs and of *Breathe*.
6. **The camera does nothing.** No auto-framing of hero flashes, no zoom pulses; the storm comes to the
   viewer.
7. **Speed changes the subject, not the style.** 60×: flashes; 600×: the breathing storm; 3600×: the
   travelling cell. The same few hero events per second at each speed, drawn from ever larger N, and the
   same decays stretched slightly, give three different pictures from one rule.

## 6. Reference images and videos

Each with one line on what to take from it.

1. NASA Earth Observatory, *Lightning Storm over Türkiye* (ISS070-E-21172):
   https://science.nasa.gov/earth/earth-observatory/lightning-storm-over-turkiye-153092 — the lit patch
   has the cloud's texture; two flash areas in one storm; pale blue-white against orange city light.
2. NASA Earth Observatory, *Sprites, Camera, Action!* (ISS071, June 2024, with video):
   https://science.nasa.gov/earth/earth-observatory/sprites-camera-action-153422 — ISS time-lapse at
   25 to 29 fps: how a storm system pulses when every frame is a second or more.
3. Pettit's 25-minute ISS exposure: https://starlust.org/nasa-astronaut-shares-mind-boggling-time-exposure-image-of-lightning-from-the-iss
   — an hour of lightning integrated is a scatter of small points, not a wall.
4. ESA/DLR, Gerst time-lapse at 12.5×: https://www.dlr.de/de/next/medien/videos/time-lapse-from-space-earth
   — the "Christmas tree" look of even mild compression; what to avoid at 60×.
5. NASA Earth Matters, GLM over ABI, Texas 2017: https://science.nasa.gov/blogs/earth-matters/2017/03/09/the-surreal-beauty-of-lightning-seen-from-space
   — lightning drawn as light on the cloud, "what the eye might see from above the clouds".
6. NASA SVS 10936, Alabama 2012: https://svs.gsfc.nasa.gov/10936/ — points of light over 1-minute
   clouds; restrained, no symbols.
7. ESA, MTG-LI first animations (July 2023): https://www.esa.int/ESA_Multimedia/Videos/2023/09/MTG_Lightning_Imager_animations_-_July_2023
   — one minute per frame over a single Earth image; how binning reads.
8. EUMETSAT, *More than half a billion flashes* (2025): https://www-cdn.eumetsat.int/files/features/1bn-lightning-flashes/index.html
   — groups coloured by 10-minute age, accumulated flash area, a megaflash unfolding over seconds.
9. GLM quick guides (NOAA/CIRA, 2019): https://goes.noaa.gov/documents/GLM_Quick_Guides_May_2019.pdf
   — flash skeletons, "discrete emissions separated by darkness", FED/TOE/AFA, nocturnal spill.
10. Rudlosky, GLM flash statistics: https://star.nesdis.noaa.gov/data/star_docs/seminardocs/2018/20181115_Rudlosky.pdf
    — the footprint distribution the glow and light map should respect.
11. Warner, lightning at 7,207 fps (APOD): https://apod.nasa.gov/apod/ap120723.html — the leader
    crawling for 15 ms, then the channel pulsing: the shape of a hero strike's animation.
12. Farrell, *Transient* (1,000 fps): https://petapixel.com/2017/12/04/epic-4k-film-captures-beauty-lightning-1000fps/
    — what stretched time does to a bolt: leaders fork, the stroke fills at once, branches die first.
13. Olbinski, *Breathe* (black and white): https://www.thisiscolossal.com/2018/01/breathe-a-stunning-black-white-timelapse-of-thunderstorms-across-the-central-plains/
    and the NatGeo piece on his intervals: https://www.nationalgeographic.com/travel/article/spellbinding-storm-tornado-supercell-videos
    — restraint, 1 to 4 s intervals, the cloud as the subject at 60× to 120×.
14. Stacking: https://petapixel.com/2010/12/16/stack-lightning-shots-for-crazy-storms/ and Willmore's
    Lighten lesson: https://site.creativelive.com/class/layer-blending-modes-in-adobe-photoshop-2020-ben-willmore/lessons/screen-mode
    — max, not screen; the wall-of-light look and why viewers misread it.
15. Storm Highway, *What color is lightning?*: https://www.stormhighway.com/what_color_is_lightning.php
    — saturated white core, blue-white continuum plus violet nitrogen in branches, warm through dust.
16. Kim & Lin, *Physically Based Animation and Rendering of Lightning*: https://gamma.cs.unc.edu/LIGHTNING
    and the fast version https://gamma.cs.unc.edu/FAST_LIGHTNING — trunk, longest secondary, side
    channels; glow as an atmospheric point-spread convolution; the bleaching problem without tone
    mapping.
17. Reis & Fernandes, space colonisation for lightning (2022): https://repositorium.uminho.pt/handle/1822/90396
    — branch angles 30° to 135°, wide at the top, narrow near the ground; strobing as waxing/waning pairs;
    growth drawn node by node.
18. Runions et al., space colonisation: https://www.algorithmicbotany.org/papers/colonization.egwnp2007.pdf
    — the attractor idea if de-clustering strike points over the footprint is wanted.
19. Jimenez, *Next Generation Post Processing in Call of Duty: Advanced Warfare*: https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare/
    — thresholdless bloom at low weight, Karis average against fireflies, tent upsampling.
20. Evan Wallace, anti-aliased grid shader: https://madebyevan.com/shaders/grid — derivative-based
    line width and edge for ribbons.
21. Guerrilla, *Nubis Evolved* and the GDC superstorms talk: https://www.guerrilla-games.com/read/nubis-evolved,
    https://www.gdcvault.com/play/1027688/The-Real-Time-Volumetric-Superstorms — lightning as a light
    inside the cloud volume.
22. realtimevfx, elemental effects critique: https://realtimevfx.com/t/elemental-effects/5094 —
    fragments die first, trunk lingers, an in-between frame before the fade.
23. earth.nullschool source: https://github.com/cambecc/earth (`public/libs/earth/1.0.0/earth.js`) —
    the 0.97 per-frame trail fade and constant particle density; the reference the visual direction
    already names.
24. Blitzortung legend thread: https://forum.blitzortung.org/showthread.php?tid=709 — age colours and
    the one-minute ring; what Scintille should not look like, and the one idea worth keeping (a brief
    marker for the newest events).
25. Eno, *77 Million Paintings* review: https://www.cyclicdefrost.com/2006/10/brian-eno-77-million-paintings-ryko-stomp/
    — "ambient music for the eyes": cross-fades every few seconds.
26. Ikeda, *test pattern*: https://special.ycam.jp/datamatics/en/testpattern.html — density at the
    limit of perception; the look to steer away from at 3600×.
27. Anadol, *Unsupervised*: https://feralfile.substack.com/p/modern-dreams-refik-anadols-unsupervised
    — continuous slow change holds attention for half an hour.
28. Bordwell on Tarr: https://www.davidbordwell.net/blog/2006/10/22/tango-marathon/ — the still
    camera and real duration as content.
29. Slow television: https://en.wikipedia.org/wiki/Slow_television — "being present in real time and
    space", no commentary.
30. NASA JSC Gateway to Astronaut Photography: https://eol.jsc.nasa.gov/ — the archive to pull more
    night storm frames from (search "lightning"); the visual direction's first reference.

## 7. Sources

Satellites and the ISS
- NASA Earth Observatory, Lightning Storm over Türkiye: https://science.nasa.gov/earth/earth-observatory/lightning-storm-over-turkiye-153092
- NASA Earth Observatory, Sprites, Camera, Action!: https://science.nasa.gov/earth/earth-observatory/sprites-camera-action-153422
- NASA Earth Matters, The surreal beauty of lightning seen from space (2017): https://science.nasa.gov/blogs/earth-matters/2017/03/09/the-surreal-beauty-of-lightning-seen-from-space
- NASA SVS 10936: https://svs.gsfc.nasa.gov/10936/
- Starlust on Pettit's 25-minute exposure: https://starlust.org/nasa-astronaut-shares-mind-boggling-time-exposure-image-of-lightning-from-the-iss
- Interesting Engineering, astronaut captures lightning event: https://interestingengineering.com/science/astronaut-captures-lightning-event-iss
- Yahoo/NASA round-up of lightning from the ISS: https://www.yahoo.com/news/does-lightning-look-space-see-195633580.html
- DLR, Time Lapse from Space (Gerst, 12.5×): https://www.dlr.de/de/next/medien/videos/time-lapse-from-space-earth
- Digital Trends on Dominick's 2024 time-lapses: https://digitaltrends.com/?p=3710384
- ESA, MTG Lightning Imager animations, July 2023: https://www.esa.int/ESA_Multimedia/Videos/2023/09/MTG_Lightning_Imager_animations_-_July_2023
- ESA press release, Striking lightning captured by Europe's first Lightning Imager: https://www.esa.int/Newsroom/Press_Releases/Striking_lightning_captured_by_Europe_s_first_Lightning_Imager
- EUMETSAT, Lightning Imager's data debut (2024; host blocked fetching, content via search): https://eumetsat.int/node/4195
- EUMETSAT, More than half a billion flashes (2025): https://www-cdn.eumetsat.int/files/features/1bn-lightning-flashes/index.html
- NOAA GLM quick guides (Rudlosky, May 2019): https://goes.noaa.gov/documents/GLM_Quick_Guides_May_2019.pdf
- Rudlosky, STAR seminar 2018 (flash statistics): https://star.nesdis.noaa.gov/data/star_docs/seminardocs/2018/20181115_Rudlosky.pdf
- Rudlosky et al. 2019, Initial GLM observations (land vs ocean): https://ntrs.nasa.gov/citations/20190031962
- NASA SPoRT, GLM lightning safety density animation: https://ntrs.nasa.gov/api/citations/20180006726/downloads/20180006726.pdf
- UMD GLM gridded products training (host unreachable today): https://lightning.umd.edu/documents/glm/training/2018/GLM_Training_Description_Gridded_Products.pdf

Physics and perception
- Wikipedia, Lightning: https://en.wikipedia.org/wiki/Lightning
- Wikipedia, Catatumbo lightning: https://en.wikipedia.org/wiki/Catatumbo_lightning
- Rakov & Uman chapter summary (dart leaders, interstroke): https://birkeland.uib.no/wp-content/uploads/2019/05/rakov_4.7_4.12_tilles.pdf
- Scientific Reports 2022, dart leader speeds: https://link.springer.com/article/10.1038/s41598-022-10366-x
- Duke dissertation, in-cloud lightning development stages: https://dukespace.lib.duke.edu/items/1c39705c-7b55-4ed9-ae2f-257de1c6ffa4
- NSF PAR, early development of negative intracloud leaders (7.4 to 9.0 km): https://par.nsf.gov/biblio/10448562-transition-optical-radio-features-during-early-development-negative-intracloud-leader
- WMO megaflash records (phys.org): https://phys.org/news/2022-02-longest-lightning-miles-states.html
- APOD, lightning at 7,207 images per second (Warner): https://apod.nasa.gov/apod/ap120723.html
- Attentional blink review: https://pmc.ncbi.nlm.nih.gov/articles/PMC2848898
- Multiple object tracking: https://en.wikipedia.org/wiki/Multiple_object_tracking and Alvarez & Franconeri 2007: https://visualcognition.psych.northwestern.edu/publications/AlvarezTracking2007.pdf
- Bloch's law, Webvision: https://webvision.med.utah.edu/?p=159 and FAA AM70-15: https://www.faa.gov/sites/faa.gov/files/data_research/research/med_humanfacs/oamtechreports/AM70-15.pdf

Cinematography and photography
- NatGeo on Olbinski's intervals: https://www.nationalgeographic.com/travel/article/spellbinding-storm-tornado-supercell-videos
- PBS NewsHour interview: https://www.pbs.org/newshour/show/photographer-following-storm-produces-awe-inspiring-results
- Shuttermuse interview: https://shuttermuse.com/mike-olbinski-interview/
- PetaPixel, Vorticity: https://petapixel.com/2016/07/13/vorticity-time-lapse-photographer-chases-tornadoes-20000-miles/
- Colossal, Breathe: https://www.thisiscolossal.com/2018/01/breathe-a-stunning-black-white-timelapse-of-thunderstorms-across-the-central-plains/
- PetaPixel, Transient (Farrell, 1,000 fps): https://petapixel.com/2017/12/04/epic-4k-film-captures-beauty-lightning-1000fps/
- PetaPixel, Stack lightning shots (2010): https://petapixel.com/2010/12/16/stack-lightning-shots-for-crazy-storms/
- PetaPixel, 30-photo composite (2023; host blocked fetching): https://petapixel.com/2023/07/26/photographer-combines-30-photos-for-stupendous-lightning-image
- Storm Highway, stacking post (2012): https://stormhighway.com/blog2012/august1612a.php
- Storm Highway, What color is lightning?: https://www.stormhighway.com/what_color_is_lightning.php
- CreativeLive, Willmore on Lighten for lightning: https://site.creativelive.com/class/layer-blending-modes-in-adobe-photoshop-2020-ben-willmore/lessons/screen-mode
- WSLS, what causes the different colors of lightning: https://wsls.com/weather/what-causes-the-different-color-of-lightning
- Weerwoord thread on lightning colour: https://www.weerwoord.be/m/195924

Rendering and VFX
- Reed & Wyvill 1994, Visual simulation of lightning: https://history.siggraph.org/?p=119719
- Kim & Lin 2004: https://gamma.cs.unc.edu/LIGHTNING (PDF https://gamma.cs.unc.edu/LIGHTNING/lightning.pdf)
- Kim & Lin 2007, Fast animation of lightning using an adaptive mesh: https://gamma.cs.unc.edu/FAST_LIGHTNING
- KAIST, physically inspired interactive lightning generation: https://sgga.kaist.ac.kr/paper/physically_inspired_interactive_lightning_generation.pdf
- Reis & Fernandes 2022, space colonization for lightning: https://repositorium.uminho.pt/handle/1822/90396
- Runions et al. 2007: https://www.algorithmicbotany.org/papers/colonization.egwnp2007.pdf
- Jimenez 2014, post processing in Call of Duty: Advanced Warfare: https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare/
- Unity bloom manual (threshold, soft knee, clamp): https://docs.unity.cn/Packages/com.unity.postprocessing@3.2/manual/Bloom.html
- Evan Wallace, anti-aliased grid: https://madebyevan.com/shaders/grid
- ArcGIS, make lines legible with casing: https://www.esri.com/arcgis-blog/products/arcgis-pro/mapping/make-lines-legible-and-pop-with-casing
- Guerrilla, Nubis Evolved: https://www.guerrilla-games.com/read/nubis-evolved; GDC, The Real-Time Volumetric Superstorms: https://www.gdcvault.com/play/1027688/The-Real-Time-Volumetric-Superstorms
- realtimevfx, elemental effects: https://realtimevfx.com/t/elemental-effects/5094
- Roblox devforum, lightning effect timing: https://devforum.roblox.com/t/lightning-effect/458550

Maps and density
- Blitzortung forum, map icon definitions: https://forum.blitzortung.org/showthread.php?tid=709
- Discover Airdrie on the Blitzortung legend: https://discoverairdrie.com/articles/this-storm-app-is-electrifying-
- Windy community, description of overlays: https://community.windy.com/topic/3361/description-of-weather-overlays/146; lightning in the radar layer: https://community.windy.com/topic/28746/lightning
- Ventusky real-time lightning (2023): https://www.letemsvetemapplem.eu/en/2023/07/12/aplikace-ventusky-nove-zobrazuje-blesky-v-realnem-case/
- earth.nullschool source: https://github.com/cambecc/earth
- MapAtlas, dot density maps: https://mapatlas.eu/fr/blog/dot-density-map

Ambient language
- Cyclic Defrost on 77 Million Paintings: https://www.cyclicdefrost.com/2006/10/brian-eno-77-million-paintings-ryko-stomp/
- Hot Press on 77 Million Paintings: https://hotpress.com/culture/brian-enos-77-million-paintings-launches-next-week-22764403
- YCAM, test pattern: https://special.ycam.jp/datamatics/en/testpattern.html; ISEA archive: https://isea-archives.siggraph.org/?p=49063
- Feral File on Unsupervised: https://feralfile.substack.com/p/modern-dreams-refik-anadols-unsupervised
- Bordwell, Tango marathon: https://www.davidbordwell.net/blog/2006/10/22/tango-marathon/
- indiecinema, the duration of the shot: https://blog.indiecinema.co/?p=895051
- Wikipedia, Slow television: https://en.wikipedia.org/wiki/Slow_television
