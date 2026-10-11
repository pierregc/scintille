# Data quality

Three layers of defence, per [ADR 0006](adr/0006-data-architecture.md).

## At ingestion (row level)

`scintille_ingest.validate` runs a Pandera schema generated from the data contract (`FlashRecord`:
ranges, patterns, allowed values) on every parsed file, plus a check that each event time falls
inside its product window (± 5 min). Invalid rows are never dropped silently: they go to
`silver.flashes_quarantine` with the record as JSON and a `reason` listing every failed rule. An
unreadable file gets a `failed` row in `bronze.ingest_log`.

## Asset checks on `silver.flashes` (Dagster)

| Check | When | Rule | Severity |
|---|---|---|---|
| `silver_freshness` | hourly | every source has flashes newer than 20 min | error |
| `silver_completeness` | hourly, last closed hour | ≥ 99 % of expected files (GLM 180/h, LI 120/h) | error |
| `silver_ranges` | hourly, last closed hour | lat/lon in range, energy > 0, event time within its product window | error |
| `silver_volume` | hourly, last closed hour | flash count within 0.2× to 5× the median of the same hour over 7 days | warning |
| `silver_uniqueness` | daily, yesterday (closed partitions only) | no `flash_id` twice; a violation calls for a partition rebuild (#40) | error |
| `silver_reconciliation` | daily, yesterday | per source and hour: files spooled in Postgres = files in bronze, flashes parsed = silver + quarantine | error |

- Error: something is wrong with the data or the pipeline and needs action. Error checks are
  `blocking`, so a failed result fails the run; a check that raises fails it too. Either way
  `alert_on_failure` posts it.
- Warning: unusual but possibly real (a quiet night, a huge storm); visible in the UI, no alert.

Reconciliation reads each side on its own (Postgres by the day encoded in the file name, bronze by
`product_start`, silver and quarantine by `product_file`) and lists the files missing from any side.

Schedules: `silver_hourly_checks` at :10 every hour, `silver_daily_checks` at 02:00 UTC. Results show
in the Dagster UI on the `silver/flashes` asset; their summary in `metrics.json` comes with #38.

Cost of uniqueness on a large partition: 4 million rows (about one day of one source) scan the
`flash_id` column and count distinct values in 0.15 s locally (0.05 s scan, 0.10 s count); on R2 the
scan is bounded by downloading that one column.

## Fixed hot spots

Some GLM pixels fire at a fixed position with no storm around: around the clock (a few thousand to
100k "flashes" a day), or in bursts of a few hours that come back day after day. They are kept in
silver, which stays faithful to the source, and are left out of storm detection
(`gold/storm_cells`, hence storms) only.

**Rule.** Before clustering hour `H`, flashes of the 3 days ending at `H + 1 h` are grouped per
source, 0.05° grid cell and 24 h slot. A cell is a hot spot when any of these holds:

- **busy**: at least 2000 flashes in at least 12 distinct hours over the last 24 h;
- **tight**: at least 300 flashes in at least 3 distinct hours over the last 24 h, with a spread
  under 0.5 km (geometric mean of the north and east standard deviations of the positions);
- **stuck**: the same with a spread under 1 km, on at least 2 of the 3 slots.

Flashes of that source within 10 km of the hot spot's median position are dropped from the window.
Thresholds are run config (`hotspot_*`, see [pipelines](pipelines.md#storm-cells)).

- No coordinates are hard coded: the spots move when the satellite flips (below).
- `degraded` is not part of the rule: it is set on up to 99.8 % of the main spot's flashes on some
  days, on 9 % on others, on 3 % of a second pixel next to it, and on 0 to 22 % of the weaker spots.
- A real storm crossing a spot keeps its cell: only flashes within 10 km of the pixel are dropped
  (tested). Storms do not meet the thresholds. Over 30 days, the busiest natural 0.05° cell held 711
  flashes in a day with 12 active hours or more. Natural cells with 300 flashes over 3 hours or more
  never had a spread under 0.70 km, and none of the 148 compact ones (under 1.2 km) came back to
  the same cell on another day. Pixel cells are mostly under 0.6 km and come back every day.
- A new hot pixel produces cells until it qualifies: 3 hours when tight, otherwise up to half
  a day (busy) or a second day (stuck).
- Reading 3 days of positions per run costs about 6 M rows of 5 columns for both GLM satellites.
- Known limitation: GLM-West shows short single-pixel bursts over the equatorial Pacific (1 to 2 h,
  200 to 400 flashes, spread under 0.1 km) at a different place each time. Under 3 active hours,
  they meet no criterion and are not filtered.

**Characterization** (local backfill, 2026-09-08 to 2026-10-08, 64 M flashes, GLM-East and West):

| Spot (GLM-East) | Days | Flashes a day | `degraded` | Notes |
|---|---|---|---|---|
| 21.315° N 28.66° W | 09-23 to 10-08 | 52k to 123k | 9 % to 99.8 %, about 90 % overall | ~2,300 an hour at every hour, 1 to 3 km spread, median area 89 km² |
| 21.32° S 121.78° W | 09-08 to 09-21 | 48k to 97k | 76 % | The same pixel before 09-22 |
| 21.14° N 28.87° W | 10-08 | 10k | 3 % | A second pixel, 25 km away |
| 3.46° N 128.18° W and 3.54° N 127.96° W | 09-08 to 09-21 | 9k to 26k | 0 to 40 % | Two pixels, background at every hour plus bursts; the second one 4 ms, 6 fJ flashes |
| 3.54° S 22.44° W and 3.46° S 22.24° W | 09-23 to 10-08 | 5k to 16k | 0 to 24 % | Mirror of the above; the second one bursts around 07:00 to 10:00 UTC |

The spots before and after 2026-09-22 (missing from the backfill) are symmetric about the
sub-satellite point (0°, 75.2° W), as expected when a fixed detector pixel is seen after a
spacecraft yaw flip. Within 1.5° of 21.3° N 28.7° W, natural lightning stayed below 215 flashes a
day: no real storm crossed the spot in that month. GLM-West has no fixed spot.

**Verification** (same 30 days, every hour replayed with its 3-day lookback): storm cells left
within 1° of each spot. No hot spot of any criterion was found outside the spots (no false
positive).

| Spot | No rule | Tight only | Stuck only | Union (busy, tight or stuck) |
|---|---|---|---|---|
| A (21.3° N 28.7° W) | 438 | 35 | 47 | 34 |
| Am (mirror, 21.3° S 121.8° W) | 343 | 23 | 28 | 10 |
| B (3.5° N 128.1° W) | 357 | 27 | 26 | 7 |
| Bm (3.5° S 22.3° W, bursts) | 374 | 153 | 74 | 41 |

The union removes most of each hot spot; the bursty Bm pixel remains partly unfiltered.
