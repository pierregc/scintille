# 0018 · Reload interrupted replay approaches without persisting an intermediate destination

- Status: proposed
- Date: 2026-10-17

## Context

A visitor interrupted a replay approach and refreshed the page. Automatic URL canonicalization
had captured the intermediate camera pose as `view`, so the reload restored it instantly instead
of framing the storm. [0016](0016-replay-share-urls.md) describes camera sampling on replay actions;
this proposal narrows that behavior for incomplete approaches without rewriting the original record.

## Options

- Persist every interrupted pose: preserves the camera but prevents reload from retrying framing.
- Drop every camera state: restarts framing but breaks explicit Share replay links.
- Distinguish completed framing from an explicit request to share the current pose.

## Decision

StormReplay records whether the current placement arrived, guarded by the existing transition
revision. Automatic history writes include a camera `view` only after arrival. After interruption,
reload/back-forward retain the storm, playhead, speed and paused state and run the normal framing
flight. Explicit Share replay always samples the current supported pose, even after interruption;
opening that shared URL restores the chosen view as before. No new URL keys are introduced.

## Consequences

- Pointer/wheel interruption still gives the visitor immediate control of the current scene.
- Pause, seek and speed changes do not accidentally turn an incomplete approach into a destination.
- Completed and intentionally shared views retain close zero-tilt restoration and existing limits.
- Cancelled/superseded completions cannot mark a newer selection as framed. Returning to live clears
  the placement state; a failed replacement retains the prior selection's state.
- An old URL that already contains an intermediate `view` cannot be distinguished from an explicit
  shared view. Remove that parameter or reopen a clean storm link to retry normal framing.
