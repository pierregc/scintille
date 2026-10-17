# 0017 · One scene data owner for live and archive playback

- Status: proposed
- Date: 2026-10-12

Renumbered from the proposed replay ADR 0013 on 2026-10-17 to distinguish it from the
3D-lightning ADR. Status and architectural content are unchanged.

## Context
Storm entry, tracks and share URLs depend on the archive loader (#76). Lightning and thunder
already consume a shared fixed-size FlashRing. Changing only the scene clock leaves live polling
active and cannot remove cached GPU flashes from a previous extract. A storm can exceed the ring's
capacity, and seeking backwards must still recover its earlier observations.

## Options
- Recreate the globe for each extract: discards camera and layer state and reloads graphics assets.
- Replace lightning and thunder for each extract: requires repeated graphics/audio allocations.
- Keep the shared ring and explicitly replace its observation window: preserves scene resources,
  but requires cache invalidation and an owner for asynchronous feed transitions.

## Decision
SceneData owns archive loading and live feed transitions while lightning and thunder keep the
same ring. Loaded extracts remain in an immutable CPU store; playback and seeks move a bounded
window into the renderer ring. Dataset replacements change its generation to invalidate cached
observations; sliding windows retain logical observation indices, active audio and overlapping GPU
instances.

## Consequences
- New loads cancel older requests. Current observations stay available until the replacement is
  ready; failed downloads preserve the current scene. Live polling stops before an archive commits.
- Returning to live clears the archive and creates a new live client so its downloaded-path cache
  cannot skip observations removed from the ring. Disposal cancels loading and releases subscriptions.
- GPU and renderer ring capacities stay fixed. CPU memory scales with the extract's flash count;
  progressively downloading very large archives can be added behind the source interface later.
- Subsequent replay tickets use GlobeApp.data.openStorm and data.live for scene data transitions;
  SceneClock continues to provide playback time, speed and seeking to every layer.
