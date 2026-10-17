# Interrupted replay approach (#272)

## Report and fix

During #83 calibration the maintainer interrupted the camera flight and refreshed the page.
The first fix stopped automatic URL writes from saving incomplete poses. The maintainer confirmed
that behavior, then reported that refreshing after arrival followed by a camera move still skipped
framing. The final behavior uses normal storm framing unless an explicit camera view was requested.

Automatic history no longer adds `view`, even after arrival or later pause/seek/speed actions.
Explicit Share replay still captures the chosen camera. A local history checkpoint skips a redundant
approach on reload only if the camera was already at the verified final frame, the viewport matches
and the newly loaded metadata still produces the same frame. Position and quaternion are checked,
so a heading-only turn also invalidates that shortcut.

See [proposed ADR 0019](../adr/0019-reload-storm-framing.md), amending the earlier
[0018 proposal](../adr/0018-interrupted-replay-framing.md) without rewriting it.

## Reproduce on the fix Preview

1. Start with `/?storm=2026-07-15-orlando&speed=60` without a `view` parameter.
2. Move the camera during its approach and refresh: the approach restarts.
3. Let the approach finish, then pan, zoom, tilt or turn and refresh: the approach restarts.
4. Let it finish, leave the camera at the final frame and refresh: that frame is restored without
   an unnecessary flight. A viewport change or updated storm bounds triggers normal framing.
5. After moving the camera, also pause, seek or change speed before refreshing: those actions keep
   the playhead/speed/pause state, without adding a camera view to the normal URL.
6. Choose Share replay after a camera change and open the copied link: its explicitly chosen view
   is preserved. Repeat with a close view tilted back to zero degrees, back/forward and reduced motion.

Old URLs from before the fix may already contain `view`. They remain explicit views for compatibility;
start again from the clean link above to test the expanded reload behavior.

## Sparse fixtures reported during calibration

The maintainer saw only a few flashes and a small connector between positions. These five cases
are synthetic geometry/decoding fixtures, not realistic storm-activity samples:

| Cases | Encoded flashes | Scene interval | Playback at 60× |
| --- | --- | --- | --- |
| Orlando | 3 | 119 seconds | About 2 seconds after entry |
| Inland, offshore, antimeridian and southern coast | 480 each | About 45 minutes | About 45 seconds after entry |

The four synthetic extracts originally held only twelve flashes each; they were densified in
#268 after this report (see [replay-framing.md](replay-framing.md#synthetic-density)). Lowering
`speed` makes the sequence easier to inspect but does not add observations.

This feedback confirms only that some trajectory connectors are perceptible; it does not establish
full visual acceptance or a measured loss of flashes. Real density, duration, brightness/readability
and full journey acceptance still require five actual published storms from #74. Production is
currently blocked by #271; no synthetic observation is substituted for that missing evidence.

## Automated evidence

Regression tests first fail on unwanted `view` persistence and unnecessary repeated flights.
They exercise real controls at desktop/portrait aspects, moving before and after arrival, fresh
reload, and orientation-only movement. Navigation tests cover pause/seek/speed, the one-time reload
checkpoint and explicit sharing priority. Checkpoint tests reject a different storm/viewport,
malformed values and a frame that no longer matches current bounds. Existing zero-tilt sharing,
cancellation and bounds checks remain in the full suite. Browser runtime retest remains pending.
