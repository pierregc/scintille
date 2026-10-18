# 0013 · 3D lightning ribbons

- Status: proposed
- Date: 2026-10-14

## Context

The ground-plane channel from #223 flattens in grazing views. #232 replaces it with ribbons,
while #233 and #234 extend the same paths with vertical looks and a main-channel halo.
The long afterglow buffer may contain hundreds of thousands of flashes; only a short flicker
window needs detailed geometry. Reduced motion, bloom and cloud lighting already have shared rules.

## Options

- Keep fragment distance fields: one draw, but no relief and repeated work over large glow quads.
- Upload CPU-generated paths: easy inspection, but additional allocations, CPU work and bandwidth.
- Generate seeded paths in the vertex shader: compact inputs and relief, with repeated walk work per vertex.

## Decision

Generate 16-segment main paths and branches in the vertex shader, using a separate buffer capped
at 2,048 active channels. Store event-derived seeds independently of rebased GPU time. Attach
channel meshes to the glow mesh and share its layer object, profile uniforms and disposal lifecycle.

## Consequences

Height variants and a coarsely sampled halo can reuse each flash's path. The full glow and cloud
light map retain their existing buffer. Bursts may omit older channels while preserving their light.
The shader cost and grazing-view continuity must be checked on the GPU before acceptance;
local unit and type checks cannot establish these visual and performance criteria.
