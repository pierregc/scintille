# Interrupted replay approach (#272)

## Report and fix

During #83 calibration the maintainer interrupted the camera flight and refreshed the page.
The automatically written URL contained the partial pose, so reload restored that pose instantly.
The new placement-completion state omits that pose from automatic history while retaining the
storm, playhead, speed and pause state. Reload then runs the storm framing flight again.
Explicit Share replay still captures the chosen camera, including an intentionally interrupted pose.
See [proposed ADR 0018](../adr/0018-interrupted-replay-framing.md); previous ADR files are unchanged.

## Reproduce on the fix Preview

1. Start with `/?storm=2026-07-15-orlando&speed=60` without a `view` parameter.
2. Move the camera during its approach. The current scene stays interactive and the URL has no `view`.
3. Refresh. The camera approaches Orlando again; interrupted pause/seek/speed state is retained.
4. Let the flight finish, then refresh: the completed view is restored normally.
5. Interrupt another approach and choose Share replay. Open the copied URL: the intentionally
   shared camera view is restored, including a close view tilted back to zero degrees.
6. Repeat with back/forward, pointer/wheel interruption, portrait layout and reduced motion.

Old URLs from before the fix may already contain `view`. They remain explicit views for compatibility;
start again from the clean link above to test the corrected interruption/reload behavior.

## Sparse fixtures reported during calibration

The maintainer saw only a few flashes and a small connector between positions. These five cases
are synthetic geometry/decoding fixtures, not realistic storm-activity samples:

| Cases | Encoded flashes | Scene interval | Playback at 60× |
| --- | --- | --- | --- |
| Orlando | 3 | 119 seconds | About 2 seconds after entry |
| Inland, offshore, antimeridian and southern coast | 12 each | 18 minutes 20 seconds | About 18 seconds after entry |

The twelve-flash extracts contain four groups of three at successive track points. Within a group,
flashes are ten scene seconds apart, only about 0.17 seconds at 60×, so a group can look like one
short burst. A perceived count of four is not evidence of a four-flash extract. Lowering `speed`
makes the sequence easier to inspect but does not add observations. Once the extract has elapsed,
no further observations exist in these fixtures.

This feedback confirms only that some trajectory connectors are perceptible; it does not establish
full visual acceptance or a measured loss of flashes. Real density, duration, brightness/readability
and full journey acceptance still require five actual published storms from #74. Production is
currently blocked by #271; no synthetic observation is substituted for that missing evidence.

## Automated evidence

Regression tests first fail on the reported unwanted `view` persistence. They then exercise fresh
reload with real controls at desktop/portrait aspects and verify the full animated approach completes.
Navigation tests cover both initial URL entry and user selection, pause/seek/speed persistence and
explicit sharing after interruption. Existing zero-tilt sharing, cancellation, bounds and fixture
loader checks remain in the full suite. Browser runtime capture remains pending.
