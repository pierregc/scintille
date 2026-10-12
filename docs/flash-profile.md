# Flash profile

How bright a flash is on screen over time. Implemented in `web/src/globe/lightning/profile.ts` (TypeScript
reference, unit-tested) and its GLSL twin used by the lightning shader. Times are scene time, so replay
speed compresses them.

## Flicker, then afterglow

1. **Flicker phase.** Lasts the measured flash duration, clamped to 60–600 ms (and to 60 % of the display
   time). It holds one pulse per 150 ms, from 1 to 4. Each pulse rises in 4 ms and decays with a 40 ms time
   constant; each later pulse is 0.7× the previous one. Pulses after the first are jittered per flash, so
   neighbouring flashes do not blink in step.
2. **Afterglow.** A dim glow rises over the flicker phase, then decays exponentially with a time constant
   of a quarter of the display duration, shifted to reach exactly zero at its end. The eye reads brightness
   on a log scale, so this looks like a steady fade. The display duration is chosen in the HUD
   ("Afterglow": 1 second, 1 or 30 minutes, 1 second by default, saved in `localStorage`). At 1 second
   the flash leaves no trace: its flicker, then a short fade.

   Its level is 12 % of the first pulse up to 5 minutes, then `0.12 × 5 / minutes`: a longer window keeps
   more flashes on screen, so each one glows dimmer and the light on screen at 30 minutes stays that of
   5 minutes. New flashes stay visible over the older ones.

The result is the maximum of the two. A short flash is a single blink with a faint tail; a long one
stutters three or four times before settling into the glow.

## Reduced motion

With `prefers-reduced-motion: reduce`, there is no flicker: one soft fade, rising over 60 ms (at most 4 %
of the display duration), falling with a 250 ms time constant, then following the same afterglow.
