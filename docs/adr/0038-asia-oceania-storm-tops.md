# 0038 · Storms over Asia and Oceania from cold cloud tops

- Status: accepted
- Date: 2026-11-20
- Replaces in part [0029](0029-asia-oceania-coverage.md)

## Context

[ADR 0029](0029-asia-oceania-coverage.md) left Asia and Oceania as a grey zone. The maintainer wants
every storm on Earth visible, from a free source, even a less fresh or less precise one (#450).

Checked on 2026-11-20: FY-4C's Lightning Mapping Imager (133°E, full disk) is still commissioning
and published nowhere; FY-4A's is limited to China and to March to September; Blitzortung needs an
approval its rules make unlikely ("do not set up yet another visualization of online data") and a
station to host; ECMWF's open data has no lightning parameter; WIS2 carries only Singapore, the UK
and Canada. No free lightning feed covers the gap.

The composite clouds ([ADR 0023](0023-composite-clouds.md)) already download Himawari-9's band 13
(10.4 µm, 2 km) every hour. Deep convection shows there as tops colder than about 215 K.

## Options

- **Keep the grey zone.** Honest, but Asia and Oceania stay empty.
- **Cold cloud tops from Himawari.** Free, no new download, hourly, about 35 minutes late. A proxy
  for storms, not lightning: it misses storms that stay below the threshold and flags tropical
  ocean convection that barely flashes.
- **Overshooting tops** (a local minimum several kelvin under its surroundings). Worse than the
  plain threshold on the one hour tried.

Measured on 7 hours of 18 and 19 November against GLM, on the GOES-East and GOES-West band 13:
areas of at least 9 pixels under the threshold, widened by 10 km, against the flashes from 10
minutes before to 20 minutes after the hour (a lightning cell has at least 3 flashes):

| Threshold | GLM-East flashes under a top | Lightning cells seen | Tops with lightning | GLM-West flashes | Tops with lightning |
|---|---|---|---|---|---|
| 210 K | 68 % | 36 % | 55 % | 37 % | 18 % |
| 215 K | 77 % | 51 % | 44 % | 43 % | 13 % |
| 220 K | 85 % | 63 % | 33 % | 54 % | 10 % |

## Decision

Show the cold tops of the grey zone as storms, never as flashes, at 215 K.

- **Ingest.** Each composite frame cuts Himawari's band 13 into cells of 16 pixels (about 32 km).
  A cell with at least 9 pixels under 215 K is placed under its top (parallax from the frame's
  top heights, at most 15 km), kept within 75° of view zenith and only where no lightning source's
  footprint reaches (`coverage.half_width`). About 1,500 to 1,900 cells an hour, 40 to 50 kB of
  JSON.
- **Contract.** One immutable object per frame under `archive/clouds/cold-tops/`, referenced by
  both cloud manifests through an optional `cold_tops` block. It follows the frame's retention.
- **Globe.** Soft, ground-aligned glows at 13 km, two cells wide so they merge, crossfaded with the
  cloud frames and breathing slowly (steady with reduced motion). Pale violet, not the flash
  white, about half as bright by day. They show whether the cloud layer is on or not. The
  coverage tooltip and the methodology page name them.

## Consequences

- Asia and Oceania show their storms, at cloud cadence. Storm catalog, search, highlights and
  sound still come from lightning only.
- R2: 24 writes and about 1 MB a day, about 35 MB kept.
- A real lightning source for the zone (FY-4C, if CMA opens it) replaces the glows where it sees;
  the ownership mask then shrinks the zone they cover.
