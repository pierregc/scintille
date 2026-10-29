# 0029 · Asia and Oceania coverage

- Status: accepted
- Date: 2026-10-29

## Context

Lightning comes from GOES-East and GOES-West GLM (the Americas) and MTG LI (Europe, Africa, the
Atlantic). Asia, Oceania and the poles have no source. `live/coverage.geojson` already marks them,
the globe shades them and the coverage label links to the methodology page. Issue #42 asks whether
to fill the gap before launch.

## Options

- **Grey zone.** Keep the shading and explain it. Nothing to build, nothing to license, and it
  matches the rule that an empty region must never read as a region without lightning.
- **Blitzortung.** Ground network with good coverage in Asia and Oceania. Its data is meant for
  station operators and non-commercial use; publishing it on a public site needs their agreement,
  likely tied to hosting a station. It is ground detection, not optical: different physics, no
  optical energy, so neither the intensity scale nor the storm levels apply without a separate
  calibration. It would also be a new ingestion path and a new contract source.
- **FY-4B Lightning Mapping Imager.** The only geostationary lightning imager over East Asia and
  Oceania. Access terms, latency and format from the CMA data service are not checked yet.
- **Paid network** (Vaisala GLD360 and similar). Global, but priced for business use; out of
  proportion for a portfolio project.

## Decision

Ship with the grey zone. The methodology page says which regions are not covered and why. No new
source is added without the maintainer's approval.

## Consequences

- Nothing changes in the pipelines, the contract or the globe.
- Asia and Oceania storms are absent from the catalog and the highlights.
- Revisit after launch: ask Blitzortung with traffic numbers, and check FY-4B LMI access. A source
  that is chosen gets its own ADR and tickets (ingestion, ownership mask, calibration, credits).
