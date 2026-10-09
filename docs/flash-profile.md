# Flash profile

How bright a flash is on screen over time. Implemented in `web/src/globe/lightning/profile.ts` (TypeScript
reference, unit-tested) and its GLSL twin used by the lightning shader. Times are scene time, so replay
speed compresses them.

## Flicker, then afterglow

1. **Flicker phase.** Lasts the measured flash duration, clamped to 60–600 ms (and to 60 % of the display
   time). It holds one pulse per 150 ms, from 1 to 4. Each pulse rises in 4 ms and decays with a 40 ms time
   constant; each later pulse is 0.7× the previous one. Pulses after the first are jittered per flash, so
   neighbouring flashes do not blink in step.
2. **Afterglow.** A dim glow, at most 18 % of the first pulse, rises over the flicker phase and fades as
   `(1 − t)²` until the end of the display duration (1.5 s by default).

The result is the maximum of the two. A short flash is a single blink with a faint tail; a long one
stutters three or four times before settling into the glow.

## Reduced motion

With `prefers-reduced-motion: reduce`, there is no flicker: one soft fade, rising over the first 4 % of
the display duration and decaying as `(1 − t)²`.
