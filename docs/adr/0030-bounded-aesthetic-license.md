# 0030 · Bounded aesthetic license: styled detail beside the observations

- Status: proposed
- Date: 2026-10-29

## Context

Scintille has two goals of equal weight: a contemplative experience, and data that is reliable and
honest. [ADR 0020](0020-immersive-storm-view.md) drew a strict line for the immersive view: no
source resampled beyond its native resolution, no synthetic relief or noise (point 2 and visual
rule 12 of [immersive view](../immersive-view.md#visual-rules)).

With that line, the cloud relief of [ADR 0028](0028-cloud-relief.md) stays smooth columns shaped
by 1 km opacity and 2 km heights, and an opaque anvil hides the flashes inside it, which are what
the site is about. The maintainer wants more immersion: clouds with thickness and texture,
translucent enough to see lightning inside them, photographic and never cartoon.

## Options

- **Keep rule 12.** Honest, but the volume stays smooth and opaque storms hide their lightning.
- **Free styling.** Whatever looks good. A viewer could no longer tell an observation from a
  decoration, which breaks the honesty goal.
- **Bounded license.** Departures allowed where they serve immersion, held within numeric bounds
  at the scale of the observations, never on the lightning data, and named.

## Decision

Adopt the bounded license. A departure from the observations is allowed when all of these hold:

1. **Lightning is untouched.** Time, position, footprint, energy and duration keep their meaning at
   every pose (ADR 0020, point 6). No styling moves, adds or removes a flash.
2. **It stays below the observation's scale, or on a quantity nothing observes** (thickness, inner
   structure, transparency, light). At the observation's own scale the result stays within a
   stated bound of the observed value.
3. **It is named.** The methodology's table becomes observed, procedural, assumed, **styled**; each
   styled item states its bound, and the debug tooling can show it.
4. **It stays photographic.** No outlines, no saturated colours, heights exaggerated at most 2.5×
   (ADR 0020, rule 7).

Visual rule 12 becomes: *No false precision. Flash positions are not interpolated or snapped.
Surface and clouds keep their sources' values at the sources' scale; below it they may carry
styled detail within the bounds of ADR 0030. Magnification never sharpens.* Point 2 of ADR 0020
is read the same way.

First use: cloud detail and translucency, with their bounds in ADR 0028. Each later use states its
bound in its own ADR or PR.

## Consequences

- Near the floor, pictures are no longer only observations; the methodology says what is styled
  and by how much.
- Bounds are checked by tests or `bench.mjs` where they can be (cloud opacity at the 4 km scale),
  so styling cannot drift silently.
- The ground relief parked in #124 for looking cartoon falls under rule 4 if it comes back.
- Lightning stays the reference: every styled layer is judged by whether it makes the flashes
  easier to see and read, never by how much it adds.
