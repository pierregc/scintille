# 0032 · Free camera tilt: orbit along the floor, then raise the gaze

- Status: proposed
- Date: 2026-10-30

## Context

The surface camera orbits the point at the screen centre. Its tilt is capped at 80° and, under
[ADR 0020](0020-immersive-storm-view.md), stops where the camera would drop under the 400 km floor.
Every storm view sits at that floor, so a vertical drag has little or no room: none from `iss`, up
to 60° from `window`, none from the Horizon view (72°). To see more horizon the visitor has to zoom
out, tilt, then zoom back in, and even then the screen centre must land on the ground: at the floor
the horizon never sits lower than 44 % of the screen height (#394).

The maintainer wants to look toward the horizon freely and more grazingly, without a lower floor
(texels at the bottom of the screen, visual rule 9) and without new Horizon or Follow compositions.
Share links ([ADR 0016](0016-replay-share-urls.md)) carry `lat,lon,altitude,tilt[,heading]` with the
tilt clamped to 80°.

## Options

- **Look in place at the floor.** The camera stays put and the gaze rises from straight down. Close
  to a window seat, but the same drag would orbit above the floor and look at it, the storm leaves
  the screen as soon as the gaze rises from `iss`, and tilting up then down does not come back.
- **Orbit up to 90° only.** One rule, but between 80 and 90° the camera only slides 850 km back for
  6 % of screen: the horizon never goes below the middle of the screen.
- **A lower floor for grazing views.** More grazing near the camera, but visible texels and a
  second floor rule.
- **Orbit, sliding along the floor, then raise the gaze.** Two phases on one drag, reversible.

## Decision

The surface tilt runs from 0 to 90° in two phases on one drag:

- **0 to 80°: orbit.** The camera turns around the point at the screen centre. Where the range the
  visitor chose would take it under the floor, it slides back along the floor (`floorRange(tilt)`),
  so the point stays put.
- **80 to 90°: raised gaze.** The camera stays where it is and turns up about its own horizontal
  axis, by up to 10°. At the floor the horizon goes from 44 % to about 71 % of the screen height.
- **Reversible.** Dragging down lowers the gaze first, then the tilt. Only zoom, pinch, flights and
  Follow change the chosen range, so tilting up then down ends where it started.

The target stays the orbited point, on the ground and on screen at every tilt. The up vector comes
from the tilt and heading at the target, so the camera never rolls. Flights fly the look at the
target and ease the gaze on top of it. A tilt above 80° in a share link is the 80° view with the gaze
raised by the difference, so links up to 80° keep their meaning. The cloud relief windows and the
flash cloud light, centred on the point looked at, stay at the 80° point once the view ray passes
it instead of falling back under the camera. Zooming out leaves the surface camera when the camera
height, rather than the range, passes the orbit camera's minimum, so a grazing view slid back along
the floor stays close. The floor stays at 400 km; tilt while following stops Follow, as any input.

## Consequences

- One drag reaches the horizon and the limb from every storm view, on mouse and touch, and comes back.
- `CameraPose` and `SurfaceView` carry the gaze; code that assumed the camera looks at its target
  must lower the gaze first. The surface view's range is the chosen range, not the camera distance.
- Share links accept tilts up to 90°; older clients clamp them to 80° and lose the raised gaze.
- Grazing views show up to 2,200 km of ground and the atmosphere limb: two bench poses, `grazing`
  (floor, 80°) and `limb` (floor, 90°), join the references and the ADR 0020 budgets apply to them.
- An interrupted surface flight still drops the roll the flight carried, as before; with a raised
  gaze this also tilts the view by a fraction of a degree.
