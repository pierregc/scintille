# 0015 · Production replay entry and framing

- Status: proposed
- Date: 2026-10-17

## Context

Discovery (#81), URL restoration (#82) and tracks (#80) need one selected storm. The merged
SceneData owns feed replacement; the development-only fixture launcher bypasses production entry.
A replay may cover the antimeridian, a pole or more data than a mobile browser can hold.

## Options

- Each control loads and flies independently: duplicates selection and cancellation rules.
- Rebuild the globe per storm: discards graphics, user layers and audio preferences.
- Coordinate entry around SceneData: preserve the existing scene and expose its selected metadata.

## Decision

Expose `GlobeApp.replay` with `open(slug, speed)`, `live()` and read-only `state` (selected metadata,
loading slug, error). SceneData still owns atomic data replacement. Superseded results cannot fly
or replace the selection. An interrupted flight keeps the loaded replay. Every geographic layer
continues to consume SceneClock; historical clouds remain asynchronous and optional.

Fit a spherical cap enclosing the storm's published geographic bounds inside the central 62% of
the camera viewport, with a modest 12-degree tilt and a 2.8-second flight. Wide caps use whole-globe
framing. These are initial settings for #83, not final visual acceptance. Respect the existing
reduced-motion instant flight and allow pointer/wheel input to interrupt.

Before downloading an extract, reject metadata exceeding 256 KiB, more than one million flashes
or 64 MiB of advertised compressed chunks. Bound each archive chunk by its declared stored size
and 2 MiB after decompression. These are browser support limits, not classification thresholds;
oversized storms show a usable error while the previous scene remains available.

## Consequences

- Suggestions and navigation must use `replay.open` / `replay.live`, rather than directly changing
  SceneData, so camera and selected metadata stay coherent.
- The basic `?storm=<slug>` entry now runs in production. #82 defines scene-time/camera encoding
  and browser navigation; #81 supplies discovery controls.
- The existing synthetic Orlando fixture uses the same entry in dev/Preview. Its dedicated data
  root is selected for that QA session only; no fixture is added to production.
- Download time is independent of the 2.8-second camera flight. Cold end-to-end timings and visual
  desktop/touch evidence still require the deployed Preview, with network conditions recorded.
