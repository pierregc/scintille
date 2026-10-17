# 0019 · Use storm framing for ordinary reloads and explicit views for sharing

- Status: proposed
- Date: 2026-10-17

## Context

The maintainer confirmed the interruption fix, then reported that refresh after a completed approach
and later camera movement still skipped the approach. [0018](0018-interrupted-replay-framing.md)
only excluded unfinished poses from automatic history; completed approaches still added `view`.
The requirement is to reframe whenever the current camera is away from the storm's final pose,
while leaving an already correct frame still. Existing records remain unchanged.

## Options

- Save every camera in the URL: preserves arbitrary views but suppresses ordinary reload framing.
- Always replay the approach: fixes moved cameras but adds a redundant flight when already framed.
- Keep normal URLs on storm framing, reserve explicit `view` for shared destinations, and remember
  a verified settled frame locally for reload only.

## Decision

Automatic history writes retain storm, time, speed and pause state without adding a camera `view`.
An explicit incoming `view` remains attached to that storm across replacement writes; Share replay
always samples the chosen view. Selecting a storm creates a normal framing URL again.

On page hide, save `scintilleReplayFrame` in the current history entry only when the actual camera
position and quaternion match the storm framing pose after control limits. Clear that checkpoint
if the camera is moved, tilted, turned or still approaching. Capture before app disposal and remove
the listener on teardown. This state stays local to the history entry and is never encoded in a URL.

On an actual browser reload, a checkpoint can skip the approach only for the same slug, field of
view and aspect, with finite supported values that still match framing computed from the freshly
loaded storm bounds. Missing, stale or malformed state falls back to the normal approach. A camera
already at a requested pose completes on the next update without a flight; a changed heading counts
as a changed pose even when target/range/tilt are unchanged.

## Consequences

- Refresh after moving the camera before or after arrival returns to the storm framing.
- Refresh from its correct final frame restores that frame without replaying the approach.
- Explicit shared/custom `view` links retain their intended destination and zero-tilt range support.
- Checkpoints never cause a second download or an independent scene transition; StormReplay remains
  the owner and revalidates against current metadata before applying the saved-frame shortcut.
- Old URLs already containing `view` remain explicit for compatibility. A clean storm link starts
  normal framing. No new URL key, observation or production data is introduced.
