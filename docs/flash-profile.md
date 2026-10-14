# Flash profile

How bright a flash is on screen over time. Implemented in `web/src/globe/lightning/profile.ts` (TypeScript
reference, unit-tested) and its GLSL twin used by the lightning shader. Times are scene time, so replay
speed compresses them.

## Flicker, then afterglow

1. **Flicker phase.** Lasts the measured flash duration, clamped to 60–600 ms (and to 60 % of the display
   time). It holds one pulse per 150 ms, from 1 to 4. Each pulse rises in 4 ms and decays with a time
   constant between 25 and 64 ms, picked per flash; each later pulse is 0.7× the previous one. Pulses after the first are jittered per flash, so
   neighbouring flashes do not blink in step.
2. **Afterglow.** A dim glow rises over the flicker phase, then decays exponentially with a time constant
   of a quarter of the display duration, shifted to reach exactly zero at its end. The eye reads brightness
   on a log scale, so this looks like a steady fade. The display duration is chosen in the HUD
   ("Afterglow": 0, 1 or 30 minutes, 0 by default, saved in `localStorage`). At 0 the flash leaves no
   trace: its flicker, then a 1 s fade.

   Its level is 12 % of the first pulse up to 5 minutes, then `0.12 × 5 / minutes`: a longer window keeps
   more flashes on screen, so each one glows dimmer and the light on screen at 30 minutes stays that of
   5 minutes. New flashes stay visible over the older ones.

The result is the maximum of the two. A short flash is a single blink with a faint tail; a long one
stutters three or four times before settling into the glow.

## Channel

While a flash flickers, a screen-space ribbon follows a 3D random walk. The
vertex shader generates its main channel and three branches from a seed derived from the event
time and location. Revisiting a flash or rebasing GPU times preserves its shape.

The channel is 2.2 flash radii long in either direction, at least 6 px, with a 1.6 px width.
Horizontal size has a pixel floor; altitude stays in kilometres so distant channels do not float
above the globe. Branches only light on the first pulse, later pulses follow the main channel.
The channel fades over 150 ms after the flicker phase, leaving the round afterglow. The glow
is held back to 40 % during the channel phase so the cloud does not wash it out.

A seed selects about 25 % cloud-to-ground looks: a downward channel from a nominal 7 km cloud
base to the surface, with downward branches. Its height alone is exaggerated by 2.5× (17.5 km
on screen), so it reads in a grazing view. The other 75 % spread horizontally at 8–11.5 km,
just below the 12 km cloud tops; those heights are not exaggerated. Both use the same horizontal
walk, width, energy and timing, preserving their footprint from above. Satellites cannot classify
these two kinds: their allocation and exaggerated drops are rendering choices, not measurements.

Only flashes still in that phase enter the channel buffer, capped at 2,048 instances. If a burst
exceeds this budget, the newest channels remain; all flashes retain their glow and cloud lighting.
The light map continues to use the full flash buffer.

## Channel halo

A second, soft ribbon follows the main channel only, sampling every other core vertex (8 segments
instead of 16). Branches retain their thin core. The halo is eight times wider and at 30 % of the
core level. It shares the same profile and fade. Nearby, the round glow falls to 10 % during flicker;
the round afterglow is unchanged. The halo fades with camera distance from 1,500 to 6,000 km,
returning the flicker glow to 40 % at globe scale.

The halo pass is omitted above 512 active channels; the round glow then returns to its previous
level. This bounds its instance and fill cost during bursts. The benchmark must still establish
the 500-channel GPU delta at 1080p before this change is ready for review.

## Reduced motion

With `prefers-reduced-motion: reduce`, there is no flicker: one soft fade, rising over 60 ms (at most 4 %
of the display duration), falling with a 250 ms time constant, then following the same afterglow.
