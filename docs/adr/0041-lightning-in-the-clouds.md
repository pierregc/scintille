# 0041 · Lightning in the clouds: a fine cloud light, an exposure by load, a veil from the clouds as drawn

- Status: accepted
- Date: 2026-11-21
- Amends the field and the cloud light of [ADR 0033](0033-lightning-looks-and-density.md) and the
  veil of [ADR 0035](0035-lightning-inside-clouds.md), under the bounded license of
  [ADR 0030](0030-bounded-aesthetic-license.md)

## Context

Maintainer QA of 2026-11-21, on storm replays: the halo is not pleasant at 60×, shows "small blurred
squares that blink" at 600× and "a living animal" at 3600×; at the steepest tilt a flash reads as the
cloud, then a bolt, then a flat halo over it, "an extra storey above the clouds". The brief: a
contemplative, slightly artistic view where lightning crosses clouds that are a little translucent
and have some thickness, never tops out above them, with no visible gap under the layer; the twinkle
of flashes seen from afar and the afterglow stay as they are.

Measured on Boquerón (2026-11-19, level 5, at night), at `c781017`:

- The cloud light is one 1024 × 512 map over a window of three camera heights. At the storm framing
  (camera 1,100 km up) a texel spans 17 km and no flash is splatted under 34 km of radius: magnified on
  screen, blurred squares.
- 200, 2,000 and 9,000 to 11,000 flashes are within their flicker at once at 60×, 600× and 3600×. All
  of them light the cloud at full level with their real-time flicker, keeping the brightest at each
  point: a plateau whose outline boils.
- The volume lights a band 3 km under each top, so on the skin of a 15 km storm, while channels stop
  at 11.5 km and a tangent disc glows at 12 km. Channels are drawn over the clouds, veiled from an
  opacity read where the line of sight leaves a 13 km shell. Seen from the side: a bolt, and a flat
  patch floating over it.

## Options

- **Tune the constants** (a lower splat floor, a lower level). The texels stay, and the patch stays
  above the bolt.
- **A 2048 × 1024 map.** Still 8.5 km per texel at the storm framing, for 6 MB that ADR 0033 already
  gave back to the memory budget.
- **March the channels as light sources inside the volume.** The right physics; a rewrite of the
  march and of its cost.
- **A second, fine map near the view, an exposure by load, and a fit and a veil taken from what the
  clouds draw** (chosen). Every piece reuses a pass that exists.

## Decision

1. **A fine light map.** A square of ground of 0.8 camera heights of half extent (at least 250 km)
   around the ground seen at screen height -0.3, 1024² texels (512² on phones), snapped to its texels:
   0.6 km per texel at the floor, 1.7 km at the storm framing. Flashes are splatted at their footprint
   (1.3 `r`) with a floor of 1.5 texels; from 2,000 km of camera height the splats widen to the wide
   map's, which takes over between 5,000 and 6,500 km and is unchanged from afar. Both maps add up.
2. **The cloud lights along the channel.** The main path of each flash drawn in full is splatted
   into the fine map as a soft tube, 6 km either side, at 1.6 times the footprint's level, keeping the
   brightest; its footprint keeps half its light there.
3. **An exposure by load.** In a storm view the flashes outside the sample light the cloud at
   `min(1, 25 / load)`, `load` being the flashes within their flicker at once, so a storm at 3600×
   lights as much cloud as at 60×; and a share of them, from none at an applied share of 0.3 to all at
   0.02, light it in a soft fade (60 ms up, 250 ms down) instead of their flicker. The sample keeps
   its level and its real-time profile, and grows to the top of its bands at speed: 30 flashes at
   600× and 12 at 3600× (20 and 8 before), so fewer flashes go without their channel. Every flash still lights the cloud at its observed time, place
   and footprint: none is moved, added or removed.
4. **No disc up close.** While a flash is lit, where a cloud light shows, its round glow is drawn
   only from afar (farness 0.7 to 1, about 1.3 to 3 km per px), as the points outside the sample are.
   It stays for the afterglow and where no cloud light shows.
5. **Channels fitted to the drawn top.** The part of a channel in the cloud ends 0.5 km under the top
   drawn over each end of each segment: compressed under a low top as before, stretched up to 1.7
   times under a tall one, and nothing passes that ceiling (12.5 km under the flat layer), not even a
   cloud-to-air branch. The lit band of a column sits a quarter of its top's height under that top
   (1 to 3 km), narrower under low tops.
6. **A veil from the clouds as drawn.** Where the volume draws the clouds, each pixel of a channel
   reads their cover and the depths at which its ray enters them and meets them on average. A point
   `d` km behind their near side is hidden by `cover × (1 - exp(-3 d / (mean - entry)))`; hidden, a
   core keeps `0.75 exp(-d / 20)` of its light (at least 0.12, and the 0.3 trace of ADR 0033 under the
   base), 0.2 of that at a slant (paths 1.2 to 2.5), its clear air halo goes, and the cloud scatters
   the light of main paths around them: a soft tube 4 km (from above) to 9 km (at a slant) either
   side, at 0.2 to 0.9 of the channel's light. The flat layer keeps the estimate of ADR 0035.
7. **A lit cloud reads thick.** In the volume the flashes' light meets 0.3 of the clouds' extinction,
   so it shows from deep inside, past the point where the clouds turn opaque; the lit band reaches
   down the body of the cloud (9 km of half width under its centre), and the air under a lit cloud
   glows with it down to 0.5 km, as rain and haze would (extinction 0.06 per km, styled).
8. **Seen from above.** The dimming of #479 stays on the disc; the cloud light, reduced here, is no
   longer dimmed with it.

## Consequences

- At 600× and 3600× the picture is a calm field, brighter where the storm is denser, under the 30 or
  12 flashes drawn in full; nothing blinks in blocks. From above a flash is a channel in a tight glow;
  at the steepest tilt it is a soft light inside the layer, and nothing stands above the clouds.
  Before and after on Boquerón, the same instants: [captures](../immersive/lightning-in-clouds/0041-before-after.jpg).
- The globe from afar and the afterglow are unchanged: captures at 14,000 km with 0, 1 and 30 minutes
  of afterglow differ by the HUD only, and at 9,000 km by 168 pixels of at most 4 levels out of 255.
- ADR 0033's "every flash lights the cloud with its real-time profile at full level, at every replay
  speed" now holds for the sample; the field keeps the time, the place and the footprint.
- 2 MB more GPU memory on desktop, 0.5 MB on phones; one more draw of the flashes and one of the
  channel segments into the fine map, one more ribbon pass, two texture reads per ribbon pixel. On a
  GPU shared with another render, interleaved runs of `main` and of this set on Boquerón showed no
  difference above their own spread at the storm framing (60×, 600×) or at the steepest tilt; to be
  measured again on a free machine.
- By day at a slant, channels under a sunlit deck nearly vanish, as the physics has it.
- Phones and the `low` tier keep the flat layer: they get the fine map (phones) and the disc rule,
  not the veil from the volume.
- Twins to keep in step: `fieldLevel`, `calmShare`, `fineWindow`, `fineShare`, `bandCentre`,
  `bandWidth`, `reliefLift`, `behindLight`, `slantShare`, `slantCore`, `scatterLight`.
