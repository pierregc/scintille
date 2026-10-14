# 0009 · Storm intensity levels

- Status: accepted
- Date: 2026-10-14

## Context

Storm pages and the globe need an intensity level per storm that the public can read at a glance
(#71), stored on each storm and updated while it is active (#72). The level must stay honest: it
describes how electrically active a storm was as measured by the satellites, not a weather warning.

The [analysis notebook](../analysis/storm-intensity.ipynb) covers 29 days of GLM East and West data
(2026-09-08 to 2026-10-08, 2026-09-22 missing, 64 M flashes): 159,412 closed storms once the hot
spot warm-up is left out. What it shows:

- **Heavy tails.** The median storm has 24 flashes, a peak of 3 flashes per minute and lasts
  31 minutes; the top 1 % have more than 4,300 flashes and 50 per minute.
- **Correlations** (Spearman). Flash count correlates with every other measure (0.74 to 0.86).
  Peak rate and duration are the least related pair (0.55).
- **Double counting.** Where the GLM East and West fields of view overlap, most flashes are in
  `silver.flashes` twice, and `gold/storms.flash_count` is 1.9 times too high there. Counting the
  flashes of the satellite that saw the storm best fixes it.
- **Energy** per flash differs between satellites by up to 1.7 times (median), is not calibrated
  across sources (#33), and will not compare with MTG LI.
- **Fixed hot spots.** Without the #179 filter, two hot spots become the second and third largest
  "storms" of the month (close to a million flashes each). With it, percentiles barely move. The
  refined hot-spot rule (#180) removes most of these pixels; the bursty one near 3.5°S 22.3°W
  remains partly unfiltered, so levels 4–5 may still contain a few artefacts.
- **Track bounds.** Energy summed from silver within the bounds of each track step matches the sum
  over each storm's own flashes in ranking (Spearman 0.998) and reads 6 % high in total.

## Options

All options set thresholds at fixed values, taken from percentiles of this month and rounded. All
count flashes on the satellite that saw the storm best (`flashes`, `peak_rate`). Percentages are
shares of the 159,412 storms; per day is over 29 days. Level descriptions are the medians of this
month, not a global ranking.

A storm here is any track of ST-DBSCAN cells, which need `min_pts` (10) flashes across both
satellites; on the best satellite alone a storm can have a single flash. Half of all storms are
Light by construction of the percentiles, near noise ones included, so "50 % Light" describes this
population, not the weather.

### Proposal: two-criterion score, 5 levels

`score = sqrt(flashes × peak_rate)`, where `peak_rate` is the highest number of flashes in one
minute. Public wording: *the level grows with how much lightning a storm produced and how fast it
flashed at its peak.*

| Level | Name | Score from | Percentile | Storms | Share | Per day | Description |
|---|---|---|---|---|---|---|---|
| 1 | Light | 0 | | 80,406 | 50.4 % | 2,773 | A brief, isolated burst: a dozen flashes in about twenty minutes. |
| 2 | Moderate | 8 | p50 | 47,403 | 29.7 % | 1,635 | An ordinary thunderstorm, a few flashes a minute for under an hour. |
| 3 | Strong | 25 | p80 | 24,038 | 15.1 % | 829 | A well-developed storm: hundreds of flashes over about two hours. |
| 4 | Intense | 120 | p95 | 6,004 | 3.8 % | 207 | A large, very active storm, a flash every two seconds at its peak, for hours. |
| 5 | Exceptional | 450 | p99 | 1,561 | 1.0 % | 54 | Among the most active storms we detect: thousands of flashes, more than one per second at its peak. |

Medians by level: 12, 44, 218, 1,449 and 7,716 flashes; peak rates 2, 4, 9, 27 and 67 per minute;
durations 20, 46, 108, 224 and 410 minutes.

- Both terms only grow during a storm's life, so a live level can rise and never drops.
- Tells a short, violent burst from a long, slow storm, which flash count alone ranks the same.
- Area (depends on clustering parameters and on the hull of few flashes), duration (rewards slow
  storms) and energy (not comparable across satellites) are left out.
- The score itself has no physical unit; the public sees names, not numbers.

### Variant A: same score, 4 levels

Thresholds 10, 50, 450 (p58, p89, p99): Light 58.4 % (93,095), Moderate 30.8 % (49,081),
Strong 9.8 % (15,675), Exceptional 1.0 % (1,561). Fewer, wider steps, easier to tell apart on
the globe, but Strong then mixes ordinary afternoon storms with large systems.

### Variant B: flash count only, 5 levels

Thresholds 25, 100, 750 and 4,000 flashes (p50, p80, p95, p99), same names: 50.5 % (80,518),
28.6 % (45,661), 15.9 % (25,319), 3.9 % (6,196), 1.1 % (1,718). The simplest wording (*number of
flashes*), and monotonic too. It agrees with the proposal on 89.7 % of storms, never by more than
one level; it ranks long, slow storms higher and short bursts lower.

### Limits common to all options

- **29 days, one season** (late northern summer, early southern spring): freeze the thresholds as
  absolute values and re-check them after a full year rather than recomputing live percentiles.
- **GLM only, no MTG LI**: Europe, Africa and the Indian Ocean are missing, and LI has its own
  detection efficiency. Counts and rates should transfer better than energy, but LI storms need a
  check against these thresholds once they flow.
- **Detection efficiency** drops toward the edges of each field of view; keeping the better
  satellite per storm is a proxy for flash matching across satellites.
- **Satellite ownership (#182)**: storms are clustered from both satellites together, so duplicate
  flashes in the overlap help small groups reach `min_pts`. Once #182 assigns each flash to one
  satellite and the month is backfilled again, the storm population changes and the percentiles must
  be re-run.
- **Analysis code**: `storm_metrics.py` copies the logic of `storm_cells.hour_cells` to keep the
  members of each cell, so it has to follow changes to that function (#182, #183) before a re-run.
- **Parameters**: changing the ST-DBSCAN or tracking parameters changes storm sizes and calls for
  re-running the notebook.
- Names avoid *severe* and *warning*, which national weather services use for hazards (hail, wind)
  that GLM does not measure.

## Decision

The proposal: `score = sqrt(flashes × peak_rate)` on the best satellite, 5 levels from 8, 25, 120
and 450, with the names and descriptions of its table. It separates short violent bursts from long
slow storms, uses only measures that grow during a storm's life, and leaves out energy, area and
duration, which do not compare across satellites or clustering settings.

## Consequences

- #72 stores `flashes`, `peak_rate`, the score and the level per storm, and needs flash counts per
  source per cell (or per-minute counts per storm), which the current tables do not keep. Because of
  the table migration policy, #183 stores them in a new `gold/storm_levels` table rather than on
  `gold/storms`.
- The thresholds become constants with unit tests on their boundaries; changing them is a new
  ADR, since storm pages would change level.
- Reviewing the thresholds after a year of data, and once MTG LI is ingested, is planned work.
