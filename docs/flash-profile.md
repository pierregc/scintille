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

While a flash flickers, a thin channel is drawn over its glow (`web/src/globe/lightning/channel.ts`). Its
shape is picked per flash: I, zigzag, Y or branched. Small flashes lean to I and zigzag, flashes wider than
about 14 km to Y and branched, the horizontal spread of large intra-cloud flashes seen from orbit. The
satellites cannot tell cloud-to-ground from intra-cloud flashes, so the shape is a rendering choice, not
a measurement.

The channel is 3.2 flash radii long, at least 9 px either way so it reads from far, with a random
orientation. Branches only light on the first pulse, later pulses follow the main channel, and the glow
is held back to 40 % meanwhile so the cloud does not wash the channel out. It fades within 150 ms after
the flicker phase, leaving only the glow.

## Reduced motion

With `prefers-reduced-motion: reduce`, there is no flicker: one soft fade, rising over 60 ms (at most 4 %
of the display duration), falling with a 250 ms time constant, then following the same afterglow.
