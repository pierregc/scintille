# Methodology

## Flash intensity

Each flash carries `intensity` in [0, 1], the brightness the globe draws. It comes from
`energy_raw`, which the sources report in different units and with different sensitivities: GLM
gives an optical energy in joules, MTG LI a radiance in mW m⁻² sr⁻¹. Raw values cannot be compared
across sources, so intensity is a rank within each source, put on one log scale.

### Method

1. **Log transform.** Energies span four to five orders of magnitude; brightness follows
   `log10(energy_raw)`.
2. **Per-source percentiles.** Over a calibration window, for each source, the log energy at 17
   percentiles: 1, 2, 5, 10, 20 to 90 by 10, 95, 98, 99, 99.5 and 99.9. Flashes flagged `degraded`
   or `outside-owner-zone` are left out, so each satellite is calibrated where it sees best.
3. **Shared scale.** GLM East is the reference: between its 1st and 99.9th percentiles, intensity is
   linear in log energy. Each percentile knot gets the reference's intensity there, and every
   source maps its own knot at that percentile to the same value. Between knots the mapping is
   linear in log energy; below the first it is 0, above the last 1.

So a flash at the 90th percentile of MTG LI is as bright as one at the 90th percentile of GLM East,
and within each source a brighter measurement is always drawn brighter.

### Versions and reproducibility

Calibrations are versioned JSON files in `data/packages/scintille-ingest/src/scintille_ingest/calibration/`
(`cal-N.json`: window, flash count and knots per source). Ingestion uses the highest version, and
every row of `silver.flashes` stores it in `calibration_version`. A new calibration is fitted from
the lakehouse with one command, from `data/`:

```sh
uv run scintille-ingest calibrate --start 2026-10-05 --end 2026-10-12
```

It writes the next `cal-N.json`; committing it and deploying makes it current. Older days keep
their version until a backfill rebuilds them ([backfill](backfill.md)).

`cal-0` is provisional: a fixed log range per unit (GLM 10⁻¹⁵·⁵ to 10⁻¹¹·⁵ J, LI 1 to 10⁴
mW m⁻² sr⁻¹), used until enough MTG LI data is in the lake for a fitted calibration. Rows ingested
before #33 have a null intensity and `calibration_version` `none`.

The distributions behind a calibration are plotted in
[`analysis/intensity-calibration.ipynb`](analysis/intensity-calibration.ipynb).

### Limits

- Percentile matching assumes each source sees the same population of flashes. It does not: GLM and
  LI differ in detection efficiency, pixel size and thresholds, and they watch different regions and
  local times. Intensity is comparable as a rank, not as a physical quantity.
- Sensitivity varies across a field of view (viewing angle, day and night background). One
  calibration per source averages over it.
- A calibration reflects its window. A season or region with stronger storms shifts the
  percentiles; a recalibration on a longer window, then a backfill, absorbs it.
- `energy_raw` itself is kept unchanged in silver, so any other mapping can be computed later.
