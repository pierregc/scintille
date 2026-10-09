# 0007 · Cloud source: NOAA GMGSI infrared mosaic first, home-made composite later

- Status: accepted
- Date: 2026-10-09

## Context

The globe needs a cloud layer (#62, published by #61) that looks like the view from the ISS (#43):
photographic, sunlit on the day side, dark on the night side, later lit from inside by flashes
(#64). It must also be honest: clouds come from observations, and flashes should sit under the
storms that produced them. Criteria from #60: beauty at globe scale, latency, global coverage,
licence, effort, archive cost for replay.

Spike method. Every option was turned into the same product, an equirectangular opacity texture
(8192 × 4096, then 4096 and 2048), for **2026-07-15 18:00 UTC**, the start of the lightning
fixtures. Infrared brightness temperature (BT) became opacity with the same rule for all IR
options: `smoothstep(4 K, 32 K, T_surface − BT)`, where `T_surface` is the GFS skin temperature
(one 0.6 MB GRIB field). The textures were rendered on our Earth shader (`createEarth`, 4k tier)
as a shell at 1.004 R, lit with the same twilight bands, at five views: Atlantic and Americas
(globe), Asia at night (globe), Gulf of Mexico and Sahel (country scale), and an oblique view
from ISS altitude over the Gulf. Prototype code and screenshots stay outside the repository.

Shortcut in (c): without a EUMETSAT account, the MTG frame came from the EUMETView WCS as 8-bit
counts at 0.05°, calibrated on GOES-19 where both disks overlap (r = 0.87, MAE 6.7 K). A real
build would read FCI L1c. Meteosat-9 (IODC) was not available from EUMETView for that date.

## Options and measurements

| | (a) GFS total cloud cover | (b) NASA GIBS Band 13 layers | (c) Home-made IR composite | (d) NOAA GMGSI longwave IR |
|---|---|---|---|---|
| Nature | Model forecast (12z run, +6 h) | Observed IR, served as coloured PNG | Observed IR, raw radiances | Observed IR, ready-made global mosaic |
| Satellites | none | GOES-East, GOES-West, Himawari-9 | GOES-19, GOES-18, Himawari-9, MTG-I1 | GOES-19, GOES-18, Himawari-9, Meteosat-10, Meteosat-9 (IODC) |
| Coverage | Global, poles included | **No Europe, Africa, Middle East, western Asia** (no Meteosat layer); ±~72° | Global to ±~72°; thin weak band near 63–70° E without Meteosat-9 IODC | Global, 72.7° S to 72.7° N |
| Spatial resolution | 0.25° (~28 km) | ~2 km source, any WMS size | 2 km IR (FCI IR10.5 also 1 km) | 0.072° (~8 km) |
| Temporal resolution | Hourly steps, 4 runs a day | 10 min | 10 min | Hourly |
| Latency (measured) | f006 on S3 3 h 35 after the cycle, so the frame shown is a 3.5 to 9.5 h old forecast | 25 to 50 min | GOES ~10 min after scan start, Himawari ~13 min, FCI L1c ~14 min (Data Store) | ~40 min (objects land at hh:39) |
| Access | HTTP range request on S3, 0.8 MB per field, GRIB2 | WMS/WMTS, no login; palette must be inverted (only 77% of GOES pixels match a palette colour exactly; a cold grey ramp overlaps the warm one) | S3 NetCDF (GOES, 24 MB per band per disk), S3 HSD (Himawari, 10 bz2 segments, ~24 MB), EUMETSAT Data Store with an account (FCI FDHSI ~1 GB per 10-min disk, all channels) | S3 NetCDF, 7.4 MB per hour, 0–255 counts (calibrated against (c): r = 0.97, MAE 2.9 K) |
| Archive for replay | S3 since 2021 | Continuous only since April 2025, with holes (GOES-West: 203 of 4,464 slots in May 2026; Himawari empty on 2025-07-15 18:00) | Full archives (AWS for GOES and Himawari, Data Store for FCI since 2024) | S3 since July 2021 |
| Licence | NOAA open data, attribution requested | NASA open data, GIBS acknowledgement; underlying data NOAA and JMA | NOAA open; Himawari "produced and managed by JMA", redistributed openly by NOAA, attribution required; FCI: hourly Level 1 is "Core" (CC BY 4.0), sub-hourly Level 1 with latency under 1 h is "Recommended" (licence, fees possible for service providers) | NOAA open data (contains EUMETSAT and JMA data; credit both) |
| Running cost | none | none | none for data; ~150 GB/day ingress if FCI is taken every 10 min | none; 180 MB/day ingress |
| Effort | S (a day) | S, but the Europe/Africa hole still needs a EUMETSAT source, so it ends up as (c) | L (one to two weeks): three formats, reprojection, seam blending, cross-calibration, EUMETSAT licence | S (one to two days) |

Texture sizes (2048 × 1024 grayscale): about 330 to 400 KB in WebP, 1 MB in PNG; 4096 × 2048 PNG:
3 to 4 MB. Archiving our own 2048 WebP frames costs ~8 MB/day hourly or ~50 MB/day every 10 min.

**Beauty against the ISS look.** ISS photos (NASA Gateway to Astronaut Photography) show sunlit
cumulus fields resolved to a few hundred metres, translucent cirrus, anvils casting shadows near the
terminator, and night clouds lit from inside by lightning. Observations from the screenshots:

- (a) GFS: total cloud cover is near 100% over much of the planet, so the globe looks overcast and
  smeared; at country scale 0.25° cells are visible as blocks, and storms are where the model put
  them, not where the flashes are. This is the "cartoon" look #43 rules out.
- (b) GIBS: as good as (c) where it has data, but the Europe/Africa hole is obvious from the default
  Atlantic view, and the coloured PNG loses precision.
- (c) Home-made composite: the sharpest; Sahel convective cells and Gulf storms read as separate
  anvils at country scale. Seams between disks are invisible at globe scale once blended by view
  angle.
- (d) GMGSI: at globe scale almost indistinguishable from (c); at country scale and from ISS
  altitude, 8 km pixels show as soft blocks.
- All IR options share two limits: warm low clouds (marine stratocumulus, fair-weather cumulus) are
  faint, and nothing is known beyond ±72°. Using absolute BT instead of `T_surface − BT` makes cold
  surfaces look cloudy and drops most low clouds; the GFS skin temperature reference is worth its
  small dependency. No option resembles the ISS at ISS altitude: relief, shadows and texture must
  come from the renderer (#62), using BT as a cloud-top height proxy, which GFS cover cannot give.
- On the night side every option behaves the same: clouds stay dark and dim city lights, which is
  the canvas #64 needs.

Documentation and measurement disagree for GMGSI: the product page states about 3 km, 60° N to
60° S and a two to three hour latency, while the files are 0.072° from 72.7° S to 72.7° N and land
on S3 about 40 minutes after the nominal hour. We trust the files and keep checking them in #61.

## Decision

Use **NOAA GMGSI longwave IR (d)** as the first cloud source for #61: hourly, observed,
global between ±72.7°, one 7.4 MB file per hour, open licence and an archive back to 2021 for any
replay. Convert counts to opacity against the GFS skin temperature. Keep the **home-made composite
(c)** as the upgrade path once the layer ships (#131), starting with GOES and Himawari every 10 minutes
from AWS and MTG FCI hourly (Core, CC BY 4.0), then sub-hourly FCI if the EUMETSAT licence allows
it for the site. GFS cloud cover (a) and GIBS (b) are rejected as primary sources.

Clouds lag lightning by 40 to 100 minutes: the HUD shows the cloud frame time. Beyond ±72.7° the
layer fades out rather than being filled with GFS, so observed and modelled clouds are never mixed.

This follows the recommendation of #60 ("the quickest observed IR option that covers the globe"),
except that GIBS turned out not to cover the globe.

## Consequences

- Clouds lag lightning by 40 to 100 minutes (hourly frames, ~40 min latency). A fast-growing storm
  will flash before its anvil appears. The renderer cross-fades frames, and the HUD states the
  cloud frame time next to the lightning time.
- Polar caps beyond 72.7° have no clouds; they fade out. Filling them from GFS is possible but mixes
  model and observation (open question for the owner).
- Attribution on the site: "Clouds: NOAA NESDIS GMGSI (contains EUMETSAT Meteosat and JMA Himawari
  data)". Moving to (c) adds "Contains modified EUMETSAT Meteosat data <year>" and a JMA credit.
- #61 needs a GRIB reader for the skin temperature (or a coarser fallback without it).
- **Fixture for #62:** GMGSI LW `GLOBCOMPLIR_v3r0_blend_s202607151800000_e202607151809599_c202607151834333.nc`
  (7.4 MB, not committed), converted to a 2048 × 1024 grayscale opacity WebP (quality 70, about
  330 KB), same instant as the lightning fixtures, NOAA open data. The lightning fixtures are
  synthetic, so cloud and flash positions will not match; a real GLM hour is needed to judge that.
- Revisit when (c) is built, if GMGSI changes format or latency, or if the country-scale look is
  judged too soft.

## Sources

- GFS on AWS (licence, cycles): https://registry.opendata.aws/noaa-gfs-bdp-pds/
- GIBS API and data use policy (acknowledgement text): https://nasa-gibs.github.io/gibs-api-docs/
- Geostationary layers in Worldview/GIBS (satellites, no Europe or Africa): https://www.earthdata.nasa.gov/learn/articles/geostationary-in-worldview
- GIBS time domains, measured with `DescribeDomains`: https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/wmts.cgi
- GOES on AWS (licence): https://registry.opendata.aws/noaa-goes/
- Himawari on AWS (licence, JMA): https://registry.opendata.aws/noaa-himawari/
- GMGSI on AWS (licence, satellites, hourly, ~8 km): https://registry.opendata.aws/noaa-gmgsi/
- GMGSI product page (stated 3 km, 60° N–60° S, 2–3 h): https://www.ospo.noaa.gov/products/imagery/gmgsi/
- EUMETSAT Data Policy, amended 25 November 2025 (Core/Recommended, CC BY 4.0, attribution): https://www-cdn.eumetsat.int/files/2026-01/45173%20-%20Data_Policy.pdf
- EUMETSAT Data Store, FCI L1c FDHSI collection `EO:EUM:DAT:0662` (latency and size measured via the search API): https://api.eumetsat.int/data/search-products/1.0.0/os
- EUMETView WMS/WCS (used for the MTG frame of the spike): https://view.eumetsat.int/geoserver/wms
- ISS photography reference: https://eol.jsc.nasa.gov/
