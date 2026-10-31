# Real lightning as a reference for Scintille's procedural model

> Research notes of the lightning look rework ([#398](https://github.com/pierregc/scintille/issues/398)),
> kept as written on 2026-10-31 except for a few long quotations turned into paraphrases. Line numbers
> refer to `main` at b1b35cf; `<scratchpad>` is the rework's working folder, not in the repository.

Phase 1 research, 2026-10-31. Written for the designers who will redesign the channels, timing and
density of the lightning renderer in `web/src/globe/lightning/` (brief:
`<scratchpad>/brief.md`).

How to read the numbers. Each value carries a confidence tag:

- `[obs]` measured in a cited study (the citation follows).
- `[text]` textbook value (Rakov & Uman, *Lightning: Physics and Effects*, 2003) confirmed today through a
  secondary source (lecture summaries, papers quoting it).
- `[mem]` textbook value recalled from Rakov & Uman or the AMS glossary, not re-verified online today.
  Treat as "order of magnitude certain, last digit uncertain".
- `[est]` my inference from the sources (a computation or a reading of photographs); the reasoning is given.
- `[art]` a suggested artistic choice, to be named in the methodology (ADR 0030).

Every "For Scintille" paragraph separates **physics** (what the observations fix), **license** (what nothing
observes, so the renderer chooses), and **bound** (the number to name in `docs/immersive-view.md`,
`docs/flash-profile.md` and `web/src/pages/methodology.astro`). File references point at the renderer on
`main` today: `web/src/globe/lightning/skeleton.ts`, `profile.ts`, `channel.ts`, `index.ts`.

## 0. Numbers at a glance

| Quantity | Value | Tag, source |
|---|---|---|
| IC:CG ratio, continental mean | 2.6 to 2.9 (SD 1.1 to 1.3); regions from 1 or less to 8 or 9 | [obs] Boccippio et al. 2001 |
| IC fraction, climatological range | 0.3 to above 0.9 (factor 10 variation); typical 0.6 to 0.8 | [obs] Medici et al. 2017 |
| Share of CG flashes that are positive | 5 to 15 % by region (CONUS annual about 10 %); 3 % summer to 25 % winter; above 50 % in some winter storms; up to 90 % in a severe supercell | [obs] Medici 2017; Holle & Cummins; ALDIS; Wiens et al. 2005 |
| First CG after first IC | about 6 min later in 98 % of 46 storms; 2 h in one supercell | [obs] Mattos et al. 2017; Wiens 2005 |
| Negative charge region | -10 to -25 °C, i.e. 5 to 6 km MSL (Florida), 6 to 9 km (Colombia), 7.5 km (Kansas) | [obs] balloon soundings, LMA studies |
| Upper positive region | 8 to 10 km (Florida), 9.5 to 12 km (Kansas supercell) | [obs] LMA |
| Flash initiation height | CG below 6.8 km, IC above 7.5 km (Florida) | [obs] Stolzenburg et al. 2017 |
| Cloud base | 0.6 to 1.2 km in humid regions, up to 4.5 km in arid ones | [obs] LCL climatology |
| Stepped leader speed, step, duration | 2 × 10^5 m/s (1 to 3 × 10^5; accelerates near the ground), steps 4 to 30 m low, ~200 m at 11 km, 20 to 50 µs between steps; 20 to 40 ms for 5 to 8 km (35 ms typical) | [text] Rakov & Uman; [obs] Jiang 2017, Edens 2011 |
| Preliminary breakdown to first stroke | geometric mean 10 to 32 ms, means 27 to 51 ms | [obs] several field studies |
| Return stroke speed | 1 to 2 × 10^8 m/s (c/3 to c/2): 6 km in 30 to 60 µs | [text] AMS glossary, Rakov & Uman |
| Stroke luminosity rise and fall | rise in a few µs, falls over tens of µs, channel faintly lit for about a millisecond | [text]/[mem] Jordan & Uman 1983 |
| Strokes per negative flash | mean 3.4 to 4.6, max 26; single-stroke 17 to 38 % | [obs] Poelman 2021, Medeiros & Saba, Cooray & Perez |
| Interstroke interval | geometric mean 57 to 60 ms, arithmetic mean 85 ms, 99th percentile 470 ms, max about 0.9 s | [obs] Poelman 2021 |
| Positive flashes | 81 % single-stroke, 1.2 strokes, interstroke GM 94 ms, 75 % with long continuing current | [obs] Saba et al. 2010 |
| Dart leader | 10^7 m/s (2 to 23 × 10^6), about 1 ms, no new branches; light 10 × below the stroke | [text] Rakov & Uman |
| Dart-stepped leader | in more than a third of subsequent leaders, about 15 ms, leaves the old channel some km up; 85 % along an old branch | [text]; [obs] Stolzenburg et al. |
| Ground contacts per flash | 1.56 to 1.74 (max 5 to 6); about 40 to 50 % of flashes have more than one | [obs] Poelman 2021; Rakov & Uman |
| Continuing current | any CC after 53 to 58 % of strokes; long CC (> 40 ms) in 24 to 50 % of negative flashes; mean 45 ms, median 10 ms, 80 % of long ones > 80 ms, max 0.7 to 0.9 s; 10 to 200 A | [obs] Medeiros & Saba; Poelman 2021; Shindo & Uman |
| M-components | 0.9 ms, every 2.1 ms (GM), 100 to 200 A, rise 300 to 500 µs; 5.5 per CC | [obs] Thottappillil 1990, Tilles summary |
| K-changes | 0.7 to 1 ms, GM interval 12.5 ms (4.8 ms mean in one IC study); recoil leaders 10^6 to 10^7 m/s | [obs] Thottappillil 1990; Shao & Krehbiel 1996 |
| IC initial leader | upward 10 to 20 ms at 1.5 to 3 × 10^5 m/s (a 2 to 4 km climb), then horizontal spreading at 10^4 to 10^5 m/s | [obs] Shao & Krehbiel 1996 |
| Flash horizontal length (LMA) | median 14 to 15 km, mean 440 ms duration (Spain) | [obs] López et al. 2016 |
| Spider lightning / anvil crawlers | negative leaders at 2 to 4 × 10^5 m/s near the cloud base, lit for tens to hundreds of ms, decaying stage; tens of km, megaflash ≥ 100 km, record 768 km | [obs] Mazur et al. 1998; WMO |
| Flash duration, negative CG | multi-stroke mean 371 ms, median 313 ms, 95 % < 926 ms, max 1.38 s | [obs] Poelman 2021 |
| Flash duration, optical (GLM) | mean 301 ms, median 240 ms, 90th 626 ms, 99th 1170 ms | [obs] Rudlosky et al. 2018 |
| GLM flash area | mean 454 km², median 291 km², 90th 965, 99th 2570 km² (equivalent diameters 24, 19, 35, 57 km); one pixel 64 km² | [obs] Rudlosky 2018 |
| GLM groups per flash | mean 16.4, median 10; group area mean 180, median 135 km²; events per group 2.6 | [obs] Rudlosky 2018 |
| LIS footprint growth | an average bright pulse lights 40 % of the footprint and lasts 1 % of the flash; 63 % of pulses last 2 to 3 frames (4 to 6 ms); only 3 to 4 % of pulses light the whole footprint | [obs] Peterson et al. 2017 |
| Lateral development from orbit | 10^4 to 10^6 m/s; 65 % of propagating groups move out from the origin, 22 % extend the flash, 3 to 5 % re-light a branch | [obs] Peterson et al. 2018 |
| Flash rates | ordinary storms 1 to 10 per minute; severe never below 60; 300 to 500 per minute in extremes, 800 reported; jumps of 20 to 100+ per minute per minute | [obs] Williams et al. 1999 and later |
| Daylight from orbit | flash signal 100 × weaker than the sunlit cloud even in a 1 nm band at 777.4 nm | [obs] GLM design papers |
| Human eye | fusion at about 60 Hz (bright, central), 15 Hz (rods); persistence 100 to 200 ms | [obs] |

## 1. Cloud-to-ground versus in-cloud shares

### Physics

**Global and by latitude.** Satellites (OTD, LIS, GLM) count total lightning; ground networks count CG.
Combining them over the contiguous United States for four years, Boccippio et al. (2001) found a mean
IC:CG ratio Z of **2.64 to 2.94** with a standard deviation of 1.1 to 1.3, falling to **1.0 or less** over
the Rocky and Appalachian mountains and rising to **8 to 9** in the central and upper Great Plains [obs].
Medici et al. (2017), with 19 years of NLDN and OTD/LIS data, confirm "factor-of-10 variations", an IC
fraction between **0.3 and more than 0.9**, no clear land versus coastal ocean difference, and six regional
means [obs]:

| Region (CONUS) | Z = IC:CG | IC fraction | Positive CG share |
|---|---|---|---|
| South-central | 2.5 | 0.71 | 6.4 % |
| Coastal California | 4.6 | 0.81 | 15.4 % |
| Northwest inland | 6.3 | 0.85 | 11.9 % |
| Great Plains | 4.1 | 0.79 | 14.9 % |
| Central Rockies | 1.6 | 0.60 | 5.3 % |
| North-central | 1.5 | 0.56 | 7.0 % |

In the tropics, Mackerras & Darveniza (1994) report Z from 0.5 to 3.4 with a weighted mean of **2.3** for
0 to 20° latitude, and an Australian study found Z ≈ 2 with little dependence on latitude [obs, via
secondary sources]. The older Prentice & Mackerras (1977) fit, from 29 datasets in 13 countries, is
Z = 4.16 + 2.16 cos(3λ) for λ < 60° (about 6 at the equator, 4 at 30°, 2 at 60°) [mem]; the modern
satellite climatologies show a much weaker latitude dependence than that formula and a much stronger
dependence on storm type and terrain. **Working value: 25 to 35 % of flashes reach the ground; 15 to 40 %
is the realistic band; below 10 % in severe convective cores and above 40 % only in a few mountainous
regions.** The IC fraction correlates positively with the share of positive CG flashes (Medici 2017).

**By storm stage.** The first discharges of a cell are in-cloud, between the main negative and the upper
positive region. In 46 compact Brazilian storms, **98 % of first CG flashes were preceded by IC flashes, by
about 6 minutes** (Mattos et al. 2017) [obs]. In the 29 June 2000 STEPS supercell the first 20 minutes had
only 1 to 2 IC flashes per minute and the first (positive) CG came **two hours** after the first IC flash
(Wiens et al. 2005) [obs]. Textbook life cycle (NRC "The Earth's Electrical Environment", Rakov & Uman):
developing stage IC only; mature stage both, with the CG share at its highest; dissipating stage mostly
horizontal IC between the remaining cells and the decaying parts, plus positive CG from the anvil and
stratiform regions [text]. Flash initiation points in young and mature small storms cluster in a region
covering only **10 to 30 %** of the radar echo area (Stolzenburg et al. 2017) [obs].

**By storm type.** Ordinary (air-mass, multicell) storms: Z ≈ 2 to 3. Supercells and severe hailstorms:
"totally dominated by IC flashes with rates up to hundreds of flashes per minute", nearly 90 % of their CG
flashes positive (Wiens 2005) [obs]; storms with IC:CG above 40 are documented (Ryan & Rutledge, cited by
Medici) [obs]; many intense Plains storms are marked by a lack of negative CG rather than by positive CG
(Lang & Rutledge 2002) [obs]. Mesoscale convective systems: a convective line with ordinary ratios and a
trailing stratiform region with few, very large, slow flashes and positive CG (spider lightning, section
3). Winter storms: few flashes, high positive share. Oceanic storms: lower rates, flashes about 30 % larger
and 17 % longer than over land in GLM data (Rudlosky 2018) [obs].

**Positive CG.** Less than 10 % of CG flashes globally [text]; CONUS regions 5 to 15 % (table above), under
2 % over Florida and above 25 % off the West Coast and Alaska (Orville & Huffines) [obs]; monthly share
from about 3 % in summer to about 25 % in winter (Holle & Cummins) [obs]; above 50 % in some European
winter storms (ALDIS) [obs]. Positive flashes originate in the upper positive charge, often travel
horizontally in the cloud for tens of kilometres before descending, strike far from the core, are **81 %
single-stroke** with a mean multiplicity of 1.2 and interstroke GM of 94 ms, and **75 %** carry a long
continuing current ≥ 40 ms (Saba et al. 2010) [obs]. They are most common in the dissipating stage and in
anvil and stratiform regions (NWS TA 86-18) [obs].

**Bolt from the blue (BFB).** Edens (2011, 59 flashes in New Mexico): a CG flash that starts as a normal IC
flash between mid-level negative and upper positive charge, **negative polarity**, mean initiation height
**7.7 ± 0.7 km MSL**, leader exiting the cloud **at 8 km or higher**, horizontal offset of the ground
leader from the initiation region **1 to 17 km, mean 6.5 ± 2.6 km**, preference for the upwind side, mean
flash duration **451 ± 173 ms**, first stroke **221 ± 87 ms** after the start, **2.1 strokes** on average
(49 % multi-stroke); negative leaders at 0.8 to 2 × 10^5 m/s, profusely branched below 5 km and almost
unbranched at high altitude; step length about 200 m at 11 km and 16 m at 3 km [obs]. The NWS documents
cases more than 25 miles from the storm and a Florida flash covering 40 km in under a second [obs]. No
frequency statistic exists; they are rare (a few percent of CG at most) [est].

**Cloud-to-air.** The AMS "air discharge": a channel leaving a cloud charge centre into clear air and ending
there; "less common than IC or CG", no number [obs]. Visually: branches that poke out of the side or top
of the cloud and stop.

### For Scintille

- **Physics.** The population is IC-dominated (about 70 to 75 %). Within a cell's life the CG share starts at
  zero for the first 5 to 10 minutes, peaks at maturity (30 to 40 %), and falls in decay (more positive CG,
  more horizontal IC). Severe cores produce almost only IC at hundreds per minute.
- **License.** The satellites do not classify. `CHANNEL.groundShare = 0.25` (`channel.ts:8`) is a rendering
  choice and must stay named as such. The maintainer's wish for "mostly vertical and oblique channels" is
  compatible with an IC-dominated population because **what is drawn as a channel is not the population**:
  an IC flash is mostly hidden in the cloud (the veil already does this), while a CG channel below the
  cloud base is the one thing a camera resolves. Say so in the methodology: "channels drawn ≠ flash classes".
- **Bound to name.** A flash-look taxonomy with fixed procedural shares, for example: negative CG
  multi-stroke 20 %, negative CG single-stroke 8 %, positive CG (from the anvil, single stroke, long
  continuing current, oblique and far from the core) 3 %, bolt from the blue 1 %, IC with a vertical trunk
  then a fan 55 %, IC crawler (slow, horizontal, large) 10 %, cloud-to-air 3 %. Total CG 32 %, inside the
  observed 25 to 35 % band. Optional and honest: modulate the CG share by the cell's age read from the
  catalog track (0 to 10 % in the first 10 minutes, 35 % at the rate peak, 20 % after it) and pick the
  crawler look from observed quantities (area above ~1,000 km² or duration above ~600 ms are the GLM
  signatures of stratiform flashes, Rudlosky 2018 and Peterson 2017), which is derived from data rather than
  styled. State "CG share 30 ± 5 %, observed range 15 to 40 %" and "positive CG 10 % of CG" in the table.

## 2. Geometry of a cloud-to-ground flash

### Physics

**Vertical layout.** Cloud base from 0.6 to 1.2 km in humid regions (Florida about 1 km) to 4.5 km in arid
ones [obs]. Main negative charge at -10 to -25 °C whatever the storm [obs]: 5 to 6 km MSL in Florida, 6 to
9 km in Colombia, 7.5 km MSL in Kansas (ground at 1.1 km) [obs]. CG flashes initiate **below 6.8 km**,
beside or atop the radar core (Florida) [obs]. So a negative CG channel runs from 5 to 7 km (6 to 8 km in
deep tropical storms such as Basse-Kotto [est]) down to the ground: **5 to 8 km long**, of which 1 to 3 km
below the cloud base are in clear air and the rest inside the cloud.

**The in-cloud part.** A CG flash begins with 10 to 50 ms of in-cloud breakdown (preliminary breakdown to
first stroke: geometric means 10 to 32 ms, arithmetic means 27 to 51 ms, several sites) [obs] during which
the negative leader travels sideways in the negative charge region before one branch turns down. The
horizontal extent of this start is a few kilometres: CG initiations sit 7 to 9 km from the towers they
later strike in Oklahoma [obs]; in some flashes the horizontal in-cloud segments are longer than the
vertical part below the cloud [obs]; bolts from the blue have offsets of 1 to 17 km, mean 6.5 km [obs].
**Working value: the strike point lies 2 to 8 km from the in-cloud origin, 1 to 17 km in extreme cases.**
Since the GLM/LI position is the radiance-weighted centroid of the lit area (section 5), the strike point
is typically several kilometres from the reported position, inside the footprint.

**Obliqueness of the clear-air part.** No population statistic of channel inclination was found; models of
lightning-induced voltages treat it as a parameter from 0 to 45°. From photographs and from the step
statistics below, the sub-cloud channel of a normal negative flash is mostly within **about 30° of
vertical**, with excursions to 45° and more, and only bolts from the blue run tens of kilometres sideways
[est]. Triggered flashes that start vertical turn horizontal at 3 to 6 km, near the 0 °C level [obs]: the
in-cloud part is where channels go sideways, not the clear-air part.

**Tortuosity by scale.**
- Steps (metres): negative stepped leader steps of **1.3 to 8.6 m (geometric mean 4.4 m)** at a few hundred
  metres above ground, 5.2 m (Hill), 5 to 8 m (Biagi), 8 to 20 m (Chen); at 6 km altitude 15 to 30 m, at
  11 km about 200 m [obs: Jiang et al. 2017; Edens 2011]. Step direction relative to the advancing
  direction is "quite random", maximum about 90°, **more than 50 % of steps within ±30°** [obs].
- Segments (5 to 100 m): the mean absolute direction change between successive segments is about **16 to
  17°**, roughly Gaussian, as measured by Hill (1968) and used by LeVine & Meneghini (1978) and later channel
  models [text, via a 2017 PIER-B model paper]; long laboratory sparks give a Gaussian with SD 15.3° and a
  mean absolute change of 11.8°, and the value depends on the segment length used [obs].
- Nodes (hundreds of metres): the distance between successive forking points along a channel is roughly
  exponentially distributed with a **mean of 415 to 510 m** (photographic analysis, arXiv 1602.02496) [obs].
- Whole channel: the fractal dimension of projected photographs is **1.34** (Tsonis & Elsner 1987),
  reproduced by 3-D discharge simulations; the projected dimension depends on the viewing angle [obs].
  Large-scale shape: one or two broad bends over the 5 to 8 km, never a regular zigzag.

**Branching.**
- Only the **first stroke** of a flash branches; later strokes follow the dart leader along the existing
  trunk without new branches (section 4). In more than a third of subsequent strokes a dart-stepped leader
  leaves the old channel "some kilometres above ground", **85 % of the time along an old branch**, and makes a
  new ground contact [text]/[obs].
- Branches of a downward negative leader point **down and outward**. Deflection angles of strong branches
  (those that become part of the main channel) follow a lognormal with means of **22 to 36°**; weak branches
  deflect about **60°**; the angle between sister branches is about **40°** (Atmosphere 2022, 13(8):1217, from
  its abstract) [obs]. In laboratory positive leaders more than 80 % of branching happens within ±30° of the
  advance [obs]. Branches form when several space leaders connect to the tip almost at once; "integrated
  images show many tiny branches; most extinguish shortly after forming and do not propagate far" (Jiang
  2017) [obs]. Branching is **profuse at low altitude (below 5 km) and nearly absent at high altitude** (Edens)
  [obs]. There is no "preferred side": branches leave on both sides of the trunk.
- Counts and lengths: no clean statistic for natural CG. Photographs typically show a handful to about
  twenty branches longer than 100 m, most 5 to 20 % of the trunk length, a few reaching 50 %, fading toward
  their tips [est]. Extreme stratiform flashes seen by LIS have 100 to 234 branches longer than 5 km
  (Peterson 2018) [obs], but those are in-cloud networks, not CG trees.
- Ground contacts: **1.56 to 1.74 per flash**, max 5 to 6, about 40 to 50 % of flashes with more than one;
  these come from successive strokes, not from one forked stroke. Forked strokes (two simultaneous ground
  contacts) are rare: **2.5 % of strokes, 8.3 % of flashes** (Poelman 2021) [obs].

### For Scintille

- **Physics.** A CG channel is 5 to 8 km long, starts inside the cloud at 5 to 7 km (not at 9.5 to 10.5 km as
  `skeleton.ts:214` sets the origin, and not at the 8 to 11.5 km of `SKELETON.cloudBottomKm/cloudTopKm`,
  `skeleton.ts:21-22`), runs sideways 2 to 8 km inside the cloud (the `feed` of 0.2 to 0.8 r at
  `skeleton.ts:219` is right in size for r of 5 to 10 km), then drops within about 30° of vertical. The
  strike offset of (0.15 to 0.35) × 2.2 × min(r, 8) = 2.6 to 6.2 km (`skeleton.ts:221`) is physical and can
  widen to 1 to 12 km. The midpoint roughness of 0.18 to 0.34 of the segment length (`SKELETON.roughness`,
  `skeleton.ts:30`, i.e. 10 to 19° per split) matches the 16 to 17° per segment of real channels; the decay
  of 0.88 per level keeps it self-similar as photographs are. Branch angles 20 to 70° with 15 % near 90°
  (`skeleton.ts:167`) are a little wide: real strong branches deflect 22 to 36°, weak ones about 60°.
  Branch ends 0.3 to 2.3 km above ground (`skeleton.ts:184`) are right (branches die in the air); the
  one-sided `lean` of 65 to 95 % (`skeleton.ts:159`) has no physical basis and reads as a style.
- **License.** The heights of the in-cloud start, the exact offset, the number of branches (3 to 12 major
  ones is a fair photographic range) and the look families are free. The tilt of the framing is the real
  lever: at the storm frame tilt of 20° a 7 km vertical drop projects to 2.4 km on screen, at 45° to 4.9 km,
  at 60° to 6.1 km. No vertical exaggeration is needed physically (ADR 0020 allows ≤ 2.5 ×); if used, name it.
- **Bound to name.** "CG channels: origin 5 to 7 km (tropics 6 to 8 km), in-cloud run 0.3 to 0.8 r, strike
  point 2 to 8 km from the origin and inside the observed footprint, sub-cloud inclination ≤ 30° for 80 % of
  flashes and ≤ 45° otherwise (bolts from the blue: exit at ≥ 8 km, 5 to 17 km sideways, ≤ 1 % of flashes);
  segment direction changes about 16° (Hill 1968); 3 to 12 major branches pointing down and out at 20 to
  40°, 0.1 to 0.5 of the trunk, on both sides; a second ground contact in 40 % of multi-stroke flashes, by a
  later stroke along an old branch; forked strokes 8 %."

## 3. Geometry of an in-cloud flash

### Physics

**The vertical trunk.** A normal IC flash starts in or just above the main negative region and climbs into
the upper positive one: Shao & Krehbiel (1996, VHF interferometry in Florida and New Mexico) found an
initial breakdown that "lasted 10 to 20 ms and propagated upward at 1.5 to 3 × 10^5 m/s", giving a
**bilevel structure connected by a single upward channel** [obs]. That is a climb of **1.5 to 6 km, typically
2 to 4 km**, for example 6 to 8 km up to 9 to 11 km (Florida IC initiations are above 7.5 km; in the Kansas
supercell the upper flashes ran between 10 to 12 km and 9.5 km, the early ones between 7.5 and 5 km) [obs].
Recent 3-D imaging reports primary initial channels that are "upward but significantly tilted" with a mean
3-D step length of **295 m** [obs]: the trunk is oblique, not plumb. A 2022 study splits the negative IC
leader into ascending, transition and horizontal stages [obs].

**The horizontal spread.** On reaching the upper positive region the leader fans out horizontally; later
breakdowns from the lower level extend the upper channels; the flash has an **active stage and a final stage
of about equal length**, the final one dominated by fast K-streamers at **10^6 to 10^7 m/s** running back
along existing channels toward the origin (Shao & Krehbiel) [obs]. Horizontal leaders advance at 10^4 to
10^5 m/s: LIS/GLM flashes develop "at speeds ranging from 10^4 to 10^6 m/s" (Peterson 2018) [obs]. Extent:
LMA flashes have a median horizontal length of **14 to 15 km** and mean duration 440 ms (Spain) [obs]; GLM
footprints have a median equivalent diameter of 19 km (section 5); the smallest flashes, 1 to 3 km, occur in
strong updrafts and the largest in stratiform cloud (Bruning & MacGorman 2013) [obs]. Durations: 0.2 to
0.6 s typically; an IC flash of 15 km at 10^5 m/s needs 150 ms of leader travel, at 3 × 10^4 m/s half a
second [est].

**Spider lightning and anvil crawlers.** visible channels layered horizontally that spread far near the cloud
base as a storm decays; they are **negative leaders similar to
stepped leaders, at 2 to 4 × 10^5 m/s**, with continuous luminosity sustained by continuing current "for
tens to hundreds of milliseconds" and pulsing tips; they belong to IC flashes and to positive CG flashes
before and during the end-of-storm oscillation (Mazur, Shao & Krehbiel 1998) [obs]. The AMS glossary puts
them beneath the stratiform anvil of mesoscale convective systems, often associated with positive ground
flashes [obs]. Extent: tens of kilometres from the reflectivity cores in horizontal layers (a supercell
anvil study) [obs]; megaflashes are ≥ 100 km and typically longer than 5 s; the WMO record is 768 km (GLM,
29 April 2020, LMA sources clustered near 6 km MSL, "commonly observed with MCS stratiform lightning"), a
later analysis gives 829 km [obs]. LIS extreme flashes: maximum group separation 135 km, groups up to 80 km
long, footprints to 10,604 km², durations 4.3 s (entirely stratiform) to 7.4 s (convective to stratiform)
(Peterson 2018) [obs]. The slowness is what makes them visible as a moving front: 50 km at 3 × 10^5 m/s is
170 ms, at 10^5 m/s half a second [est]. They happen late in the storm, in the trailing stratiform or anvil
region, not in the convective core; they can light mammatus from above and are often hidden from the
ground by lower cloud [obs].

**Cloud-to-air.** A branch of an IC flash leaving the cloud side or top into clear air and stopping (AMS
"air discharge"); no rate [obs].

### For Scintille

- **Physics.** An IC flash is a trunk of 2 to 4 km climbing at 1.5 to 3 × 10^5 m/s in 10 to 20 ms, then a
  fan of 5 to 20 km at 10^4 to 10^5 m/s over 100 to 500 ms, then re-illuminations along the same channels
  (K-streamers). Today's in-cloud skeleton (`skeleton.ts:244-260`) has no trunk: one to three leaders spread
  sideways from the origin at 8 to 11.5 km with lateral offsets flattened by `v[2] *= 0.3` (`skeleton.ts:77`)
  and heights clamped by `clampHeight` (`skeleton.ts:153`). The spreading speed implied by
  `PROFILE.cloudSpread = 0.8` (`profile.ts:26`) is physical: 2.2 r = 22 km covered in 80 % of a 300 ms
  flicker is 9 × 10^4 m/s.
- **License.** The trunk height, its obliqueness, how many fans, how far: nothing observes them, except the
  footprint area which the fan must respect (within 2.2 r is already the rule). Crawlers: the observed area
  and duration can pick them (section 1); their height (anvil base, 5 to 7 km MSL) is assumed.
- **Bound to name.** "IC channels: an oblique trunk from 6 to 8 km up to 9 to 11 km, then horizontal
  leaders within the footprint at 10^4 to 10^5 m/s; crawlers (large, long flashes) at 6 to 8 km, up to
  2.2 r, at 2 to 4 × 10^5 m/s; cloud-to-air: a branch ending in clear air, ≤ 3 % of flashes; heights not
  exaggerated (or ≤ 2.5 ×, named)."

## 4. Timing

### Physics

**Stepped leader.** Average **2 × 10^5 m/s** (1 to 3 × 10^5; the geometric mean near the ground is 2.5 to
3 × 10^5, and 91 % of 107 leaders in Utah sped up by 69 % on average near the ground) [text]/[obs]; steps of
tens of metres every 20 to 50 µs, each step lasting about 1 µs [text]; a 5 to 8 km channel takes **20 to
40 ms** (35 ms is the textbook typical value) [text]. The leader is faint: its optical intensity is about
ten times below the return stroke's (stated for dart leaders) and it is seen only on high-speed video or
long exposures [text]. From initial breakdown to first stroke: 10 to 50 ms (section 2).

**Return stroke.** Upward at **1 to 2 × 10^8 m/s** (c/3 to c/2), slower at the top [text]: a 6 km channel is
lit in 30 to 60 µs, instantaneous to any camera. Current rises in a few microseconds (about 12 µs to peak
for first strokes, 5 to 8 µs for subsequent ones) and halves in 10 to 30 µs [obs, from current waveforms];
the luminosity peaks within microseconds, falls over tens of microseconds and the channel stays faintly
luminous for about a millisecond [mem, Jordan & Uman 1983]. Peak current about 30 kA for first strokes,
10 to 15 kA for subsequent ones [text]; the first stroke is usually the brightest.

**Strokes per flash.** Negative flashes: mean **3.4 to 4.6** (Sweden 3.4; Austria 3.1; multi-region 3.67;
Brazil 4.6 to 5.1; Florida 4.4), maximum **26** (in a 1.06 s flash); **single-stroke flashes 17 to 38 %**
(Brazil 17 to 23 %, Sweden 18 %, Austria 29 %, South Africa 38 %, overall 32 %) [obs]. Positive flashes:
81 % single-stroke, mean 1.2 [obs].

**Interstroke intervals.** Geometric mean **57 ms** (3,128 intervals; 48 ms in Sweden; 60 ms is the textbook
value), arithmetic mean 85 ms, 99th percentile **470 ms**, maxima 0.5 to 0.9 s; intervals before a stroke
that makes a new ground contact are about 18 % longer [obs]. Flicker frequency 2 to 100 Hz, typically
**15 to 20 Hz**.

**Dart leaders.** **10^7 m/s** (2 to 23 × 10^6), about **1 ms** for the channel, "appears to move smoothly
along the path of previous leader activity": they re-illuminate the trunk only, no new branches; the old
branches of the first stroke stay dark [text]. Dart-stepped leaders (more than a third of subsequent
leaders): leave the previous path some kilometres above ground and step to a new termination in about
15 ms, 85 % of the time along an old branch [text]/[obs]. Subsequent leaders get longer with stroke order.

**Continuing current.** After 53 to 58 % of strokes some current (> 3 ms) persists; **long continuing current
(> 40 ms) follows 7 % of strokes and occurs in roughly a quarter to a half of negative flashes** (Shindo &
Uman 24 %; textbook 30 to 50 %; Brazil: 15 % of single-stroke and most multi-stroke flashes have at least a
short one; 51 % of 1,096 flashes had CC > 10 ms) [obs]. Durations: mean 44.5 ms, median 10 ms, **80 % of long
CCs exceed 80 ms**, longest 714 to 929 ms; 0.33 % of strokes are followed by a CC over 500 ms [obs].
Current 10 to 200 A, i.e. about 0.1 to 1 % of a stroke's peak; a high-current CC (> 50 A) tends to end the
flash, a weak one to be followed by more strokes in the same channel. First strokes rarely develop a long
CC; the fifth stroke has the highest probability [obs]. To the eye the CC is the steady glow that keeps a
channel lit for a tenth to half a second ("hot lightning").

**M-components.** Short brightenings riding on the continuing current: duration GM **0.9 ms**, interval GM
**2.1 ms** (Florida), 100 to 200 A, 10 to 90 % rise time 300 to 500 µs, about 5.5 per CC in negative flashes
and 9 in positive ones; the mean time from the stroke to the first M-component is about 71 ms in one study
[obs]. Visually a slight shimmer of the CC glow, mostly above the flicker fusion rate.

**K-changes (in-cloud recoil).** Duration GM **0.7 ms**, interval GM **12.5 ms** in Florida ground flashes
(Kitagawa's New Mexico median about 6 ms; one 14-flash IC study gives a mean interval of 4.8 ms); recoil
leaders at **10^6 to 10^7 m/s** retrace existing channels; they dominate the final stage of IC flashes and
occur more than 140 ms after the start [obs]. They are weak compared with return strokes: a stutter of the
in-cloud glow at 5 to 30 ms, not blinks.

**Flash durations.** Negative CG multi-stroke flashes: mean **371 ms, median 313 ms, 95 % under 926 ms,
longest 1,379 ms** (six strokes) [obs]; single-stroke flashes last the stroke plus any CC, i.e. a few to a
few hundred ms. Bolts from the blue: 451 ± 173 ms [obs]. Optical durations from orbit (all classes): GLM mean
**301 ms, median 240 ms, 90th percentile 626 ms, 99th 1,170 ms**; ocean flashes 345 ms versus 293 ms over land
[obs]. LMA (all classes): median 0.3 to 0.35 s, log-normal, mean 440 ms [obs]. IC flashes: 0.2 to 0.6 s
typical, the active and final stages each about half [obs]/[est]. Stratiform flashes: 1 to 7 s [obs].

**What flicker looks like to the eye.** Flicker fusion is about **60 Hz** for bright central vision and
**15 Hz** for rods; persistence of vision 100 to 200 ms [obs]. Hence:
- A single stroke is one blink that the eye holds for about a tenth of a second whatever its real
  sub-millisecond duration.
- A multi-stroke flash (65 to 80 % of negative CG) is **2 to 10 distinct blinks at 20 to 200 ms gaps over 0.2
  to 1 s**: this is the flicker of a "normal" bolt. Gaps shorter than about 20 ms blur into one blink.
- A long continuing current is a **steady glow** of 0.1 to 0.5 s after a blink, slightly rippled by
  M-components; positive flashes are typically one blink plus a long steady glow.
- An IC flash is a dim glow rising over 10 to 20 ms (the trunk), one to three brighter pulses (recoil
  leaders lighting large channels), and a stuttering tail: "sheet lightning". From orbit, LIS shows that
  **20 % of flashes have no bright pulse at all** (nearly constant dim light), **47 % exactly one**, 33 % two
  or more (1-sigma threshold, Peterson 2017) [obs]; GLM flashes hold a median of **10 groups** over 240 ms,
  most of them dim and lighting a few pixels, a few lighting the whole footprint at once [obs].
- Single-stroke CG flashes (a quarter of negative ones, most positive ones) and the one-pulse IC flashes
  **do not flicker**: together about half of all flashes are one blink, possibly with a tail.

### For Scintille

- **Physics.** `PROFILE` (`profile.ts:2-41`) is close on the gaps (log-triangular 10 to 200 ms, median 60 ms:
  real GM 57 ms, 99th percentile 470 ms, so allow rare gaps to 400 ms), on the stroke count (≤ 12: real 95 %
  are ≤ 8 to 10, max 26), on `currentShare = 0.4` (real 25 to 50 %), on `currentDuration` 75 to 250 ms (real
  median 10 ms but 80 % of long ones > 80 ms, max 0.9 s) and on later strokes at 0.3 to 0.9 of the first.
  Three things differ from physics: (1) a stroke's light does not decay over 15 to 60 ms (`minTau`,
  `maxTau`); it is gone in well under a millisecond, and only the eye's persistence and the 1/60 s shutter
  justify showing it for one to a few frames; a 60 ms tail reads as glow, which is where some of the
  "Christmas tree" comes from at 600 ×; (2) the stepped leader takes 20 to 40 ms, not 20 ms flat
  (`groundLeader = 0.02`, `profile.ts:27`); (3) there is no single-stroke class: today every CG flash longer
  than 60 ms pulses, whereas a quarter of real negative flashes and 80 % of positive ones are one blink.
  The in-cloud profile (glow 15 to 25 % between pulses, leaders over 80 % of the flicker) matches the
  active and final stages well; K-stutters could replace some of the equal pulses.
- **License.** Which flash gets which pattern (seeded today, could also use the observed duration: a flash
  under 100 ms is physically one blink; over 600 ms it is multi-stroke or stratiform), the visible descent of
  the leader (physics gives 20 to 40 ms, 1 to 2 frames; a 100 to 150 ms descent is a 3 to 5 × slow-down
  that must be named), the level of the continuing current on screen (0.2 to 0.3 is a perceptual choice;
  the physical ratio of currents is 0.1 to 1 %, but the stroke is shown through a shutter average).
- **Bound to name.** "Strokes: 1 for 25 % of CG flashes (80 % of positive ones), otherwise 2 to 12, GM gap
  57 ms (10 to 400 ms); each stroke lit for one frame plus a tail ≤ 40 ms; leader descent 20 to 40 ms real,
  shown ≤ 150 ms (slowed ≤ 4 ×); dart strokes re-light the trunk only, branches at the first stroke only, a
  new contact along an old branch in 40 % of multi-stroke flashes; continuing current in 30 to 50 % of CG
  flashes after strokes 2 to 5, 40 to 300 ms at 20 to 30 % of the first stroke, with a 2 ms shimmer
  optional; IC: 10 to 20 ms rise, 1 to 3 bright pulses, K-stutters every 5 to 30 ms at ≤ 30 %; flicker
  clamp raised from 1 s to 2 s so stratiform flashes keep their observed length."

## 5. Seen from above

### Physics

**What GLM and LI record.** GLM pixels are about 8 km at nadir (14 km at the edge of the field), LI pixels
about 4.5 km; an event is one pixel above the background threshold in one ~2 ms frame; a group is the
adjacent events of one frame; a flash is the groups within 330 ms and 16.5 km [obs]. Per flash (GOES-16,
first year): area **mean 454 km², median 291 km², 90th percentile 965 km², 99th 2,570 km²** (equivalent
diameters 24, 19, 35 and 57 km; the smallest possible flash is one pixel, about 64 km²); duration mean
301 ms, median 240 ms; **groups per flash mean 16.4, median 10**; events per flash mean 42; events per group
2.6; **group area mean 180 km², median 135 km²** (one to three pixels); energy mean 261 fJ, median 90 fJ
(Rudlosky 2018) [obs]. Ocean flashes are 31 % larger, 17 % longer and 73 % brighter than land flashes
[obs]. The TRMM LIS flash footprint averages 303 km² (σ 318 km²) with its 4 to 5 km pixels; most LIS groups
are confined to under 100 km² (about 5 pixels) [obs]. GLM detection efficiency is 70 to 90 % overall and
about 64 % by day (44 to 88 % between storms) [obs]; it rises with flash duration and is highest for CG
flashes; it is about 40 % for small flashes and lower for flashes shorter than 200 ms (Zhang & Cummins) [obs].

**How the footprint follows the channel.** The footprint is the area over which the flash's light, scattered by the nearby cloud, is still bright
enough to be detected (Peterson 2018). The pulses are of two kinds [obs, Peterson 2017]:
- **dim groups** (the large majority) light a few pixels around the active leader tip; "the flash
  illumination is not a random flickering": the lit patch moves along the developing channel, outward
  from the origin in 65 % of propagating groups, extending the flash in 22 %, re-lighting a branch in 3 to
  5 % [obs]; a typical flash's "footprint does not extend far beyond its group centroid skeleton", i.e. the
  lit corridor is a few pixels (10 to 25 km) wide along the channel [obs];
- **bright groups** (return strokes, big recoil leaders): "a select few groups were bright enough to
  illuminate nearly the entire flash footprint at once"; an average bright pulse ("series") lights 40 % of
  the footprint, carries 20 % of the light, and lasts 1 % of the flash (3 to 6 ms, 63 % of them 2 to 3
  frames); only the top 3 to 4 % of pulses light the whole footprint [obs]. Six bright groups of a 90 ms
  example flash carried 80 % of its energy and lit more cloud than its 24 dim groups together [obs].

Scattering sets the size: thicker clouds spread the light into wider halos (lidar), and the brightest
pulses of extreme flashes scatter over 100 km (the largest LIS footprint, 10,604 km² and 162 km across,
came from a flash whose channels occupied a 17 km wide strip) [obs]. Light also **escapes the side** of a
storm: a flash near the edge of the storm lets light out of the side of the
cloud onto neighbouring cloud (Peterson 2017), and GLM products warn of "side and low cloud illumination"
[obs]. Stratiform flashes make large, slow, dendritic footprints with 100 to 234 visible branches that fan
out from one point (Peterson 2018) [obs].

**What the ISS cameras show at night.** Astronaut photographs show lightning as **diffuse white to
blue-white patches lighting the cloud tops from inside**, tens of kilometres across, with the brightest
part a few kilometres wide and the cloud texture (overshooting tops, updraft knots) revealed by the flash
("two distinct flash areas", "the flash's brief light reveals these textures from above", NASA Earth
Observatory, Türkiye 2023; "this is what lightning looks like from the top down", McClain 2019) [obs]. Pettit's
120 frames per second sequences show the patches pulsing a few times per flash; time-lapses (Peake: 10 to
12 minutes in 30 s) show "dozens of flashes" as blinking patches across a storm system [obs]. Colours are
white to pale blue, purple in some long exposures; any red is airglow or sprites above the storm, not the
lightning. Channels are rarely resolved: a bolt is seen only where it runs in clear air outside the cloud
(bolts from the blue exit at 8 km or more "and can be observed visually", Edens) or where light leaks
through the thin edge of an anvil; in the core the channel is buried under 5 to 10 km of cloud [obs]/[est].

**By day.** Nothing is visible to a broadband camera or to the eye: sunlit cloud tops reflect with an albedo
close to one, and even in the GLM's 1 nm band at 777.4 nm "the lightning in a pixel is two orders of
magnitude weaker than the background"; GLM only sees it by subtracting a running background per pixel
and keeping 2 ms pulses [obs]. Daytime detection still drops to about 64 % [obs].

**Where a CG channel is visible from above.** Only its clear-air part, and only outside an opaque core:
under thin anvil edges (optical depth of a few), beside the storm when the camera is tilted and the channel
hangs under the overhanging anvil, or far from the storm for bolts from the blue. From straight above a
deep core, no channel is visible, only the glow [est, consistent with Peterson and Edens].

### For Scintille

- **Physics.** The footprint is observed and is the one thing the picture must honour: light on the cloud
  within about r of the position (the current `2 r` window of the light map and the `1 to 2 r` glow near the
  floor are already within it). Inside it, physics says a **corridor** along the channel for the dim phases
  and the **whole footprint** for one to three bright pulses: the disc-shaped splat of `light-map.glsl.ts` is
  only right during those pulses. The "ball" at 600 × and 3,600 × is what a 10-minute or 1-hour exposure of a
  storm looks like from orbit (time-lapses do show a continuous glow), so it is not false, but it carries no
  flash-level information.
- **License.** Drawing a channel at all from above is a license: physics shows glows. The current rules
  (veil in the cloud, hidden below it by `(1 - opacity)^2`, channels over sunlit cloud kept at
  `CHANNEL.dayLevel = 0.3`, `channel.ts:17`) are already named; physics would put the day level at zero.
- **Bound to name.** "Cloud light follows the procedural channel within the observed footprint (corridor
  2 to 4 km wide, 0.5 to 1 r along it); the full footprint lights only during bright pulses (1 to 3 per
  flash); overlapping flashes combine by maximum, never by sum, in a storm view; channels show through
  cloud only where the observed opacity allows (unchanged); 30 % of a channel over sunlit cloud is a styled
  trace (physics: 0 %)."

## 6. Rates and simultaneity

### Physics

**Flash rates.** Florida climatology (Williams et al. 1999): the most likely peak rate of the abundant small
storms is **1 to 10 flashes per minute**; no severe storm had a peak rate under **60 per minute**; severe
storms reached 300 to 500 per minute; lightning jumps of 20 to more than 100 flashes per minute per minute
precede the peak by 5 to 15 min [obs]. The STEPS supercell ran at "hundreds of flashes per minute" (1 to 2
per minute in its first 20 minutes) [obs]; "over 800 flashes per minute" is reported for an Alabama storm
(secondary source) [obs]; an Indian storm reached 84 per minute with no severe weather [obs]. Rates are per
storm cell or per storm system depending on the study; GLM detects 70 to 90 % of flashes and may split long
flashes, so a GLM count of 600 per minute (Basse-Kotto at 12:00 UTC) is an exceptional storm system, not
necessarily one cell [est].

**How many flashes are lit at once in real time.** With a mean optical duration D of 0.3 s (GLM; 0.24 s
median), the mean number of flashes lit at a given instant is N = rate × D and the count is Poisson:

| Rate (per minute) | Storm class | Mean lit at once | Share of time with ≥ 1 lit |
|---|---|---|---|
| 5 | ordinary | 0.025 | 2 % |
| 10 | ordinary, strong | 0.05 | 5 % |
| 60 | severe threshold | 0.3 | 26 % |
| 300 | severe | 1.5 | 78 % |
| 600 | exceptional (Basse-Kotto peak) | 3 | 95 % (rarely above 7) |
| 1,000 | extreme | 5 | 99 % |

So even the worst storm on Earth, seen in real time from one vantage point, shows **one to about six
flashes at a time**, each a blink of 0.1 to 1 s, and most minutes of an ordinary storm show nothing.

**Scintille's clocks.** A flash lives max(1 s, flicker + 0.5 s) of wall time (`PROFILE.life`, `tail`,
`profile.ts:31-32`), so the mean number lit is rate × speed × 1 to 1.5 s:

| Replay speed | Scene time per wall second | Lit at once, 60 per minute storm | Lit at once, 600 per minute storm |
|---|---|---|---|
| 1 × | 1 s | 1 to 1.5 | 10 to 15 |
| 60 × | 1 min | 60 to 90 | 600 to 900 (capped at 500 by `STORM_VIEW_FLASHES`, `index.ts:106`) |
| 600 × | 10 min | 600 to 900 (capped) | 6,000 to 9,000 (capped) |
| 3,600 × | 1 h | 3,600 to 5,400 (capped) | 36,000 to 54,000 (capped; each flash shown about one frame) |

The advancing front the maintainer likes at 600 × is physical: a cell moving at 10 to 15 m/s covers 6 to
9 km per 10 minutes, about one footprint radius per wall second, so the lit area visibly walks.

### For Scintille

- **Physics.** Real time means ≤ 6 flashes lit. 60 × already shows sixty times more; the honest statement is
  "N flashes of the last minute (ten minutes, hour) are on screen", and ADR 0030 forbids removing any of
  them. What can change honestly is **what each flash contributes**: its channel and flicker (styled) or its
  light on the cloud (observed footprint and energy).
- **License.** A channel-and-flicker budget per speed, with every flash still adding its cloud light by
  maximum blend (so density reads as rate, not as brightness). Suggested targets, to be tuned on captures:
  at 60 × all flashes get channels (≤ 500 to 900 at the peak of the worst storm; ordinary storms 1 to 90);
  at 600 × channels and flicker for about 1 flash in 20 to 50 (so 100 to 300 of a 6,000 flash window), chosen
  deterministically by seed and weighted by energy, the rest as cloud light only; at 3,600 × about 1 in 300
  to 600 (60 to 120 of a 36,000 window). The visible difference between 600 × and 3,600 × then comes from
  the front moving six times faster and from the number of lit footprints, not from more channels.
- **Bound to name.** "Replay speed never removes a flash: every flash lights the cloud for its observed
  duration and energy. Channels and flicker are drawn for all flashes at 1 × and 60 ×, for one flash in
  20 to 50 at 600 × and one in 300 to 600 at 3,600 ×, picked by a fixed seed weighted by energy; the
  selection is a rendering budget, not a classification."

## 7. Point-by-point "for Scintille" summary

1. **Shares (section 1).** Physics: 25 to 35 % CG, IC first in a cell's life, positive CG 5 to 15 % of CG,
   bolts from the blue rare. License: the look taxonomy and its shares; stage modulation from the track.
   Bound: CG 30 ± 5 %; positive 10 % of CG; BFB ≤ 1 %; crawlers 10 % (or picked by observed area and
   duration); cloud-to-air ≤ 3 %.
2. **CG geometry (section 2).** Physics: 5 to 8 km channels from 5 to 7 km, strike 2 to 8 km from the origin
   inside the footprint, ≤ 30° from vertical below the cloud for most, 16° direction changes per segment,
   downward branches at 20 to 40° on both sides, branching only at the first stroke, a second contact along
   an old branch in 40 % of multi-stroke flashes. License: branch count (3 to 12), look families, framing
   tilt, any vertical exaggeration (≤ 2.5 ×). Bound: as listed at the end of section 2.
3. **IC geometry (section 3).** Physics: a 2 to 4 km oblique trunk in 10 to 20 ms, then a 5 to 20 km fan at
   10^4 to 10^5 m/s, recoil re-lighting; crawlers at 2 to 4 × 10^5 m/s, tens of km, late, at the anvil base.
   License: trunk height, fan count, crawler height. Bound: trunk 6 to 8 → 9 to 11 km; fan within 2.2 r;
   crawler speed 2 to 4 × 10^5 m/s.
4. **Timing (section 4).** Physics: leader 20 to 40 ms, stroke under a millisecond, gaps GM 57 ms (10 to 470),
   1 stroke in 25 % of negative and 80 % of positive flashes, 3 to 5 otherwise (max 26), CC in 30 to 50 %
   for 40 to 300 ms after strokes 2 to 5, dart strokes along the trunk only. License: a slowed leader
   (≤ 4 ×), a stroke tail (≤ 40 ms), the CC screen level (20 to 30 %), which flashes get which pattern.
   Bound: as listed at the end of section 4.
5. **Seen from above (section 5).** Physics: glows, not bolts; a corridor along the channel for dim pulses and
   the whole footprint for 1 to 3 bright pulses; light leaks out of storm edges; nothing by day. License:
   drawing channels at all, 30 % over sunlit cloud. Bound: corridor 2 to 4 km wide within the footprint;
   max blend; day level 30 % named as styled.
6. **Rates (section 6).** Physics: ≤ 6 lit at once in real time even at 600 per minute; 60 × shows a minute.
   License: the channel budget per speed. Bound: 1 in 20 to 50 at 600 ×, 1 in 300 to 600 at 3,600 ×, every
   flash keeps its cloud light.
7. **Reduced motion.** Physics has nothing to say; keep the single soft fade.

## 8. Draft rows for the methodology table (ADR 0030 naming)

| Element | Status | Bound |
|---|---|---|
| Flash look (CG negative single or multi-stroke, CG positive, bolt from the blue, IC trunk and fan, IC crawler, cloud-to-air) | Procedural, seeded (crawler optionally from observed area and duration) | CG 30 ± 5 % (observed 15 to 40 %); positive 10 % of CG; BFB ≤ 1 %; crawlers 10 %; cloud-to-air ≤ 3 % |
| CG channel origin, run, strike point | Procedural | origin 5 to 8 km; in-cloud run 0.3 to 0.8 r; strike 2 to 8 km from the origin, inside the footprint; ≤ 30° from vertical below cloud for 80 % of flashes, ≤ 45° otherwise (BFB ≤ 60° and ≤ 17 km) |
| Channel tortuosity and branching | Procedural | about 16° per segment, self-similar; 3 to 12 major branches down and out at 20 to 40°, 0.1 to 0.5 of the trunk; forks 8 %; second contact 40 % of multi-stroke flashes |
| IC trunk and fan | Procedural | trunk 6 to 8 km to 9 to 11 km in 10 to 20 ms; fan within 2.2 r at 10^4 to 10^5 m/s |
| Channel heights | Assumed, not exaggerated (or ≤ 2.5 ×, stated) | as above |
| Stroke pattern | Procedural, seeded, timed like real strokes, wall clock | strokes 1 (25 % of CG) or 2 to 12, GM gap 57 ms (10 to 400 ms); stroke one frame plus ≤ 40 ms tail; CC in 30 to 50 % for 40 to 300 ms at 20 to 30 %; IC rise 10 to 20 ms, 1 to 3 bright pulses, stutters |
| Leader descent on screen | Styled | real 20 to 40 ms, shown ≤ 150 ms (≤ 4 ×) |
| Cloud light shape | Styled within the observed footprint | corridor 2 to 4 km wide along the channel; full footprint during bright pulses; max blend |
| Channel over sunlit cloud | Styled | 30 % of the channel light (physics: 0) |
| Channel and flicker budget by replay speed | Styled | all flashes at 1 × and 60 ×; 1 in 20 to 50 at 600 ×; 1 in 300 to 600 at 3,600 ×; every flash keeps its cloud light |

## 9. Sources

Primary and secondary sources consulted today (web search and fetch), by topic. Where only an abstract or
a secondary summary was readable, the row says so.

**Shares and climatology**
- Boccippio, Cummins, Christian, Goodman (2001), Combined satellite- and surface-based estimation of the
  intracloud–cloud-to-ground lightning ratio over the continental United States, *Mon. Wea. Rev.* 129,
  108–122. Abstract via https://experts.arizona.edu/en/publications/combined-satellite-and-surface-based-estimation-of-the-intracloud/
- Medici, Cummins, Cecil, Koshak, Rudlosky (2017), The intracloud lightning fraction in the contiguous United
  States, *Mon. Wea. Rev.* 145, 4481–4499. Full text: https://repository.library.noaa.gov/view/noaa/43950/noaa_43950_DS1.pdf
- Prentice & Mackerras (1977), The ratio of cloud to cloud-ground lightning flashes in thunderstorms, *J. Appl.
  Meteor.* 16, 545–550 (formula from memory; scope confirmed via https://nap.nationalacademies.org/read/898/chapter/16
  and https://earthref.org/ERR/53163).
- Mattos et al. (2017), Electrification life cycle of incipient thunderstorms, *JGR Atmos.*
  https://repository.library.noaa.gov/view/noaa/54015
- Stolzenburg et al. (2017), Lightning flash initiation locations in four storms over land and ocean, EGU
  2017-3026. https://meetingorganizer.copernicus.org/EGU2017/EGU2017-3026.pdf
- Wiens, Tessendorf, Rutledge (2002), June 29, 2000 STEPS supercell storm, AMS SLS preprint
  https://ams.confex.com/ams/pdfpapers/47135.pdf ; Wiens, Rutledge, Tessendorf (2005), *J. Atmos. Sci.* 62, 4151–4177.
- Lang & Rutledge (2002) and MacGorman et al. (1989), as summarized in
  https://ams.confex.com/ams/pdfpapers/83709.pdf and https://ntrs.nasa.gov/api/citations/19990004337/downloads/19990004337.pdf
- Positive CG: NWS https://www.weather.gov/source/zhu/ZHU_Training_Page/lightning_stuff/lightning2/positive.html ;
  NWS TA 86-18 https://www.weather.gov/media/wrh/online_publications/TAs/ta8618.pdf ; Holle & Cummins seasonal
  distributions https://www.vaisala.com/sites/default/files/documents/Ron%20Holle%20and%20Ken%20Cummins.%20Seasonal%20Lightning%20Distributions%20over%20North%20America.pdf ;
  ALDIS polarity https://aldis.at/en/lightning-statistics/polarity ; Saba et al. (2010), High-speed video
  observations of positive lightning flashes to ground, https://experts.arizona.edu/en/publications/high-speed-video-observations-of-positive-lightning-flashes-to-gr/
- Bolts from the blue: Edens (2011), *Bolts from the Blue*, PhD thesis, New Mexico Tech
  https://aem.eco/wp-content/uploads/2022/10/Edens-BFB.pdf ; Krehbiel et al. (2008), Upward electrical
  discharges from thunderstorms, *Nature Geosci.* https://www.nature.com/articles/ngeo162 ; NWS
  https://www.weather.gov/pub/lightningBoltBlue
- Air discharge: AMS glossary https://glossary.ametsoc.org/wiki/air-discharge/

**CG geometry**
- Jiang et al. (2017), Channel branching and zigzagging in negative cloud-to-ground lightning, *Sci. Rep.* 7,
  3457. https://pmc.ncbi.nlm.nih.gov/articles/PMC5471227/
- Hill (1968), Analysis of irregular paths of lightning channels, *JGR* 73, 1897 (as used in LeVine &
  Meneghini 1978 and in the 2017 PIER-B channel model; lab-spark tortuosity:
  https://archive.cmb.ac.lk/items/20256dc3-2e11-46b3-8dc8-418c64670c7b ).
- Branch angles: *Atmosphere* 13(8), 1217 (2022) https://www.mdpi.com/2073-4433/13/8/1217 (abstract via search);
  laboratory positive leaders, ICLP 2024 https://vde-verlag.de/proceedings-de/456416029.html
- Internode distances: arXiv 1602.02496, About geometry and initial phase of cloud-to-ground lightning
  https://arxiv.org/abs/1602.02496v1
- Fractal dimension 1.34: Tsonis & Elsner (1987), *Beitr. Phys. Atmos.* 60, 187; Sañudo et al. (1995)
  https://npg.copernicus.org/articles/2/101/1995/
- Multiplicity, ground contacts, forks, intervals, durations, CC: Poelman et al. (2021), *NHESS* 21, 1909
  https://nhess.copernicus.org/articles/21/1909/2021/nhess-21-1909-2021.html ; Medeiros & Saba, Presence of
  continuing current in negative cloud-to-ground flashes
  https://www.vaisala.com/sites/default/files/documents/Presence%20of%20Continuing%20Current%20in%20Negative%20Cloud-to-Ground%20Flashes.pdf ;
  Florida 139 flashes https://link.springer.com/article/10.1007/s00703-019-00702-8 ; Cooray & Perez (1994)
  Sweden https://acnpsearch.tweb-dev.unibo.it/singlejournalindex/1356875
- Dart-stepped leaders along old branches: https://par.nsf.gov/servlets/purl/10218014
- Strike offsets: tower study https://reu.caps.ou.edu/reu20/finalpapers/Webb-finalpaper.html ; multi-contact
  flashes https://agu.confex.com/agu/fm15/webprogram/Paper81432.html ; triggered lightning geometry
  https://ntrs.nasa.gov/api/citations/20120015985/downloads/20120015985.pdf
- Cloud base: https://en.wikipedia.org/wiki/Lifting_condensation_level ; charge regions:
  https://birkeland.uib.no/wp-content/uploads/2019/05/rakov_3.1_3.2.3_scechnikova.pdf ,
  https://ams.confex.com/ams/pdfpapers/104464.pdf

**IC geometry**
- Shao & Krehbiel (1996), The spatial and temporal development of intracloud lightning, *JGR* 101,
  26641–26668. Abstract http://earthref.org/ERR/51458/
- Negative IC leader stages (2022) https://par.nsf.gov/servlets/purl/10448562 ; 3-D imaging, 295 m steps
  https://par.nsf.gov/servlets/purl/10328129
- Mazur, Shao, Krehbiel (1998), "Spider" lightning in intracloud and positive cloud-to-ground flashes, *JGR*
  103, 19811–19822. Abstract http://earthref.org/ERR/53697/ ; AMS glossary
  https://glossary.ametsoc.org/wiki/spider-lightning/ ; pecoshank
  https://pecoshank.com/anvil-crawler-lightning-video-and-facts/
- Megaflashes: WMO records https://www.ufa.cas.cz/DATA/publikace/2022_Kolma%C5%A1ov%C3%A1_New%20WMO%20Certified%20Megaflash%20Lightning%20Extremes%20for%20Flash%20Distance%20and%20Duration%20Recorded%20from%20Space.pdf ;
  Los Alamos https://discover.lanl.gov/news/lightning-bolts
- LMA flash sizes: López et al. (2016) via https://www-cdn.eumetsat.int/files/2020-04/pdf_ss_iss_lis_analysis_drp_pres.pdf
  and https://recercat.cat/handle/2117/109693 ; Bruning & MacGorman (2013), *J. Atmos. Sci.* 70, 4012.

**Timing**
- Rakov & Uman (2003), *Lightning: Physics and Effects*, chapters 4.7 to 4.12 as summarized by Tilles
  https://birkeland.uib.no/wp-content/uploads/2019/05/rakov_4.7_4.12_tilles.pdf and chapter 4.1 to 4.6
  summaries on the same site; Rakov, Fundamentals of Lightning, chapter 4 (Cambridge).
- Stepped leader speeds: Campos, Saba, Warner, Krider https://www.vaisala.com/sites/default/files/documents/2.Campos%2C%20Saba%2C%20Warner.pdf ;
  Utah acceleration study https://par.nsf.gov/servlets/purl/10057660
- Preliminary breakdown to stroke intervals: https://www.nssl.noaa.gov/users/mansell/icae2014/preprints/Zhu_323.pdf ,
  https://www.aldis.at/fileadmin/userdaten/aldis/publication/2012/2_GROUND2012_Schumann.pdf
- Return stroke speed: AMS glossary https://glossary.ametsoc.org/wiki/return-stroke/ ; current rise and decay
  times from https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/4198599 ; dart leader range
  https://earthref.org/ERR/45981/
- M-components and K-changes: Thottappillil, Rakov, Uman (1990), *JGR* 95, http://earthref.org/ERR/57836/ ;
  Rakov, Thottappillil, Uman (1992) http://earthref.org/ERR/58419/ ; ICAE 2014
  https://www.nssl.noaa.gov/users/mansell/icae2014/preprints/Zhou_322.pdf ; Fisher et al. (1993)
  https://earthref.org/ERR/54356/ ; Sri Lanka K-changes https://www.mdpi.com/2073-4433/10/3/141
- Continuing current share: Shindo & Uman (1989) via https://repository.library.noaa.gov/view/noaa/49830/noaa_49830_DS1.pdf ;
  LIS continuing current 11.2 % via the same.
- Flicker fusion: https://en.wikipedia.org/wiki/Flicker_fusion_threshold

**Seen from above**
- Rudlosky et al. (2018), Initial GLM observations, NOAA STAR seminar
  https://star.nesdis.noaa.gov/data/star_docs/seminardocs/2018/20181115_Rudlosky.pdf (and *GRL* 46, 2019).
- GLM definitions: https://lightning.umd.edu/documents/glm/training/2018/GLM_Quick_Guide_Detection_Methods_June_2018.pdf ,
  https://goes.noaa.gov/documents/GLM_Quick_Guides_May_2019.pdf
- Peterson, Rudlosky, Deierling (2017), The properties of optical lightning flashes and the clouds they
  illuminate, *JGR Atmos.* https://repository.library.noaa.gov/view/noaa/31841/noaa_31841_DS1.pdf
- Peterson, Rudlosky, Deierling (2017), The evolution and structure of extreme optical lightning flashes,
  *JGR Atmos.* https://repository.library.noaa.gov/view/noaa/31844/noaa_31844_DS1.pdf
- Peterson, Rudlosky, Deierling (2018), Mapping the lateral development of lightning flashes from orbit,
  *JGR Atmos.* 123, 9674. https://repository.library.noaa.gov/view/noaa/25329/noaa_25329_DS1.pdf
- Zhang & Cummins (2020), Time evolution of satellite-based optical properties in lightning flashes, *JGR
  Atmos.* https://repository.arizona.edu/handle/10150/657607 ; Cummins & Zhang EGU 2020
  https://meetingorganizer.copernicus.org/EGU2020/EGU2020-4225.html
- Daylight and GLM design: https://ntrs.nasa.gov/api/citations/20180006164/downloads/20180006164.pdf ;
  https://www.spiedigitallibrary.org/conference-proceedings-of-spie/11180/1118040/Design-calibration-and-on-orbit-testing-of-the-geostationary-lightning/10.1117/12.2536063.pdf ;
  airborne validation https://neurophotonics.spiedigitallibrary.org/journals/journal-of-applied-remote-sensing/volume-14/issue-4/044518/Airborne-radiometric-validation-of-the-geostationary-lightning-mapper-using-the/10.1117/1.JRS.14.044518.full ;
  NESDIS https://www.nesdis.noaa.gov/our-satellites/currently-flying/goes-east-west/geostationary-lightning-mapper-glm
- ISS imagery: NASA Earth Observatory, Lightning storm over Türkiye
  https://science.nasa.gov/earth/earth-observatory/lightning-storm-over-turkiye-153092 ; Anne McClain
  https://www.devx.com/daily-news/anne-mcclain-captures-lightning-from-iss/ ; Tim Peake
  https://www.esa.int/ESA_Multimedia/Images/2016/03/Spooky_lightning and https://wishtv.com/?p=54416 ;
  Pettit 120 fps https://www.yahoo.com/news/does-lightning-look-space-see-195633580.html ; NASA Sensing
  lightning from the space station https://science.nasa.gov/earth/earth-observatory/sensing-lightning-from-the-space-station-83387 ;
  Gateway to Astronaut Photography https://eol.jsc.nasa.gov/

**Rates**
- Williams et al. (1999), The behavior of total lightning activity in severe Florida thunderstorms, *Atmos.
  Res.* 51, 245 (preprint https://archive.ll.mit.edu/mission/aviation/publications/publication-files/ms-papers/Williams_1998_SLS_MS-13121_WW-18698.pdf ;
  figures via https://www.science.gov/topicpages/t/total+flash+rate ).
- Lightning jump studies via https://www.science.gov/topicpages/l/lightning+flash+rate ; Indian 84 per minute
  case https://link.springer.com/article/10.1007/s12040-010-0040-7
