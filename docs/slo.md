# Service level objectives

What "working" means for the data, and where each number is measured. Values are published every
minute in `live/metrics.json` ([contract](data-contract.md#opsmetrics)), which feeds the HUD and
`/status`.

| SLO | Target | Window | Measured from |
|---|---|---|---|
| Live latency | p95 ≤ 120 s per source, from `event_time` to the chunk listed in the manifest | rolling 60 min | `ingest-live`, in memory |
| Completeness | ≥ 99 % of expected product files spooled (GLM 180/h, MTG LI 120/h) | 30 days, with an error budget | Postgres `ingest_files` |
| Live feed freshness | manifest age < 2 min | instant | `ingest-live` |
| Silver lag | < 15 min (lake-writer drains every 5 min) | instant | oldest batch in the spool |
| Gold age | < 26 h (daily build at 01:30 UTC) | instant | latest `gold/*` materialization in Dagster |

Latency budget: about 30 s from satellite to product file (#30), up to 30 s of chunk window, then
upload; 120 s leaves room for a slow listing or a retry.

## Freshness per layer

Each layer reports its own age (ADR 0006), so the globe can stay live while a storm page says its
data is an hour old:

- `live_feed_age_seconds`: time since `ingest-live` last wrote the manifest.
- `silver_lag_seconds`: age of the oldest spooled batch not yet committed; 0 when drained. Stopping
  `lake-writer` makes it grow by one second per second while the live feed age stays near 0.
- `gold_age_seconds`: time since the latest gold build; null before the first one.

## Error budget

Completeness allows 1 % of expected files to be missing over 30 days (about 43 GLM files a day per
satellite). `error_budget_remaining` is `1 - missing / allowed` since the first file of the window:
1 is untouched, 0 spent, negative overspent. Latency and freshness have no budget yet: their
history is not stored (only the current hour).

## Other signals

- `quality`: the latest result of each silver asset check ([data quality](data-quality.md)),
  copied from Dagster to Postgres every minute by the `ops_status` sensor: `fail` if an error check
  failed, `warn` if only warnings did.
- `catalog`: catalog operations counted by `lake-writer` this month (3 table loads and one commit
  per table per drain, about 50,000 a month) against the R2 Data Catalog free tier of 1 million.
  Dagster checks and backfills are not counted.
- `flashes_per_minute`: flashes per minute of `ingest_time`, so a spot check against silver is
  `count(*) GROUP BY date_trunc('minute', ingest_time), source`. The series restarts with
  `ingest-live` (`series_start`).
