# 0039 · Wind from the clouds service, two looks

- Status: accepted
- Date: 2026-11-21

## Context

The maintainer wants to see the wind on the globe, and whether storms sit where it blows (#486).
The spike on `spike/wind-layer` compared the sources and prototyped the look:

- GFS (NOAA NCEP): hourly steps at 0.25°, published about 3 h 30 after each run, free, already
  read by byte range by the clouds service for the skin temperature (`clouds/gfs.py`). One level
  (u and v) is 1.2 to 1.9 MB of GRIB, about 10 s.
- ECMWF open data: 3-hourly, 7 h 30 late. ICON: icosahedral grid to reproject. GOES derived motion
  winds: observed but sparse, Americas only.
- On 71 storms of 21 November at 13 UTC: 3.0 m/s of surface wind under them against 6.0 for the
  globe within ±55°, 7.8 against 20.3 m/s at 250 hPa; 6 under a jet stream ribbon, 50 where the
  surface wind converges. Storms sit in calm convergence zones, not under the jet.

## Options

- **A Dagster asset.** Fits batch tables of the lake. Wind is a live feed of images, not a table:
  the asset would need its own GFS reader, its own hourly schedule and an R2 publisher that the
  pipelines do not have, and would run inside the 10 min rhythm of the gold jobs.
- **The clouds service.** Already wakes up every hour, already finds the newest GFS run, reads
  only the bytes of the fields it needs and publishes frames with live and archive manifests.
  Wind adds four GRIB fields to the same reads and reuses the publisher pattern.

## Decision

- The clouds service publishes one wind frame per valid hour, beside the cloud frames and in the
  same process; a wind failure never stops the clouds. Frames cover the last 6 hours and the next
  one, from the newest GFS run available, older runs as fallback.
- Two levels: 10 m (surface) and 250 hPa (jet stream), on a 0.5° grid (720 x 361, rows from 90° N,
  columns from 0° E), one lossless WebP per level and hour: u in red, v in green,
  value = (byte - 128) / 127 x scale, scale 40 m/s at 10 m and 120 m/s at 250 hPa.
- Textures are written once under `archive/wind/`; `live/wind/manifest.json` points to them, and a
  daily index under `archive/wind/manifests/` serves travel in time. Kept 30 days, like clouds.
  The rules are in `scintille_contract/wind_rules.json`, read by the publisher and the browser.
- Two looks, picked by the viewer, off by default: jet stream ribbons (250 hPa, where it blows
  over about 28 m/s) and a surface veil (10 m), attenuated over observed clouds by day so it never
  combs them. Fibres are baked offscreen and fade out in close storm views.
- The interface calls it a model forecast and credits NOAA NCEP GFS.

## Consequences

- About 350 kB a hour for both levels, 8 MB a day, 250 MB at 30 days; about 100 writes a day.
  R2 already holds more than its 10 GB free (12.7 GB on 14 November): this adds well under one
  cent a month. Writes stay far below the free million.
- A viewer downloads only the level of the chosen look, about 170 kB per hour shown, and nothing
  while the layer is off.
- The wind is a forecast valid at the hour, not a measurement; the next hour is a forecast even
  at the live edge.
- `archive/wind/` needs its R2 lifecycle rule applied with Terraform.
