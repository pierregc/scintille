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
