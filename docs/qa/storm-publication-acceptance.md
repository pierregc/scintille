# Storm publication acceptance (#74)

Updated 2026-10-17. Feature PRs #264–#267 and the #271 fix (#274, `da0ea94`) are merged.
**Production acceptance remains open** until a release containing them is deployed and verified.
The merged exporter (#228), accepted classification (#72/ADR 0009) and historical cloud discovery
(#260) are implemented. This record adds no exporter, enables no schedule and changes no retention.

## Production inspection: 2026-10-17, 08:40–08:45 UTC

The resumed session reached the VPS over the existing pinned-host SSH identity. All checks below
were read-only: no schedule, deployment, table, run or public object was changed.

| Observation | Evidence / implication |
| --- | --- |
| Pipeline release | Daemon and webserver run `ghcr.io/pierregc/scintille-pipelines:880df6805cd67ff198b552c5daeece4e79d3fefe`, image `sha256:938b40c705c46fcada1025432b6f6ce490ffabda36456ff8a95738e397f752d1`, created 2026-10-14 09:27:37 UTC |
| Service state | Ingest, clouds, daemon, webserver and Postgres report healthy; lake-writer and live-probe are running without healthchecks. Container health does not prove successful pipeline execution |
| Deployed publication code | `scintille_pipelines.storm_publication` is absent; registered jobs omit `hourly_storm_catalog`, registered schedules omit `storm_catalog_schedule` |
| Persisted schedules | Four existing schedules are `DECLARED_IN_CODE`; the catalog schedule has no deployed definition or persisted state. Do not describe it as merely stopped |
| Run storage | 256 `NOT_STARTED`, zero successful/failed/queued/started runs at inspection. Latest `daily_gold` run `4c06a7ff-e3eb-4b71-a20f-bf8475198349`, created 08:35:50 UTC, has only `ASSET_MATERIALIZATION_PLANNED`, no start/end |
| Schedule/sensor failures | Latest `daily_gold_schedule`, silver-check schedules and `silver_changed` ticks fail during run creation with a PostgreSQL syntax error on `NOTIFY run_events, $1`. Fixed on main by #274, not yet deployed at inspection ([#271](https://github.com/pierregc/scintille/issues/271)) |
| Installed combination | Dagster 1.13.26, dagster-postgres 0.29.26, SQLAlchemy 2.1.4, psycopg 3.3.6, psycopg2-binary 2.9.13. Installed `dagster_postgres/event_log/event_log.py:202` issues parameterized `NOTIFY`; no installed package was patched |
| Silver inventory | `silver.flashes` exists: snapshot `4400025650626484040`, 2026-10-17 08:26:11 UTC, 20,312,406 records, 1,403 files, 928,018,541 file bytes; 18 day/source partitions covering 2026-10-12 through 2026-10-17. This is file metadata, not an event-hour completeness audit |
| Gold inventory | `catalog.list_tables('gold')` returns no tables. Cells, tracks, storms, names and levels cannot yet supply a published catalog; no historical minute counts or persisted classifications were verified |
| Public catalog | GET `https://data.scintille.app/storms/index/0.json` returned HTTP 404 at 08:40:50 GMT, `cf-cache-status: MISS`. The host resolves; the index is unavailable at the required path. No detail/chunk/reference audit is possible yet |
| Available release tags | GHCR's latest pipeline package is still tagged `880df68` and `main`. This does not contain the merged exporter; a current validated image must be built before deployment |
| ADR 0011 | Still proposed; the provenance decision remains with the maintainer |

The earlier sandbox DNS/SSH failures are superseded by these successful access checks. They were
not evidence of a production outage. The current catalog 404, missing deployed exporter, empty gold
namespace and notification failures are separate observed blockers.

### Recovery order

1. Done on main: #274 pins Dagster storage to psycopg2 (#271). Preserve run history and inventory
   the orphaned `NOT_STARTED` runs before any explicit recovery/cancellation decision.
2. Build and deploy a release from main, which contains the exporter, classification and #274;
   check that the job and schedule are registered and new runs leave `NOT_STARTED`.
3. Inventory available silver event hours, then materialize cells and recover tracking oldest first.
   Build names and accepted-rule levels before publishing. A schema-only migration is insufficient.
4. Run one controlled publication and unchanged rerun, audit all public references within declared
   bounds, drain or account for bootstrap exclusions/backlog, and record run IDs.
5. Only then consider activating the catalog schedule and measuring actual new-storm freshness.
   Hand five real slugs to #83/#261 after the catalog is readable.

No production activation or deployment is performed by this documentation PR. The release and
bootstrap work remain within #74.

## Prerequisites before enabling the hourly schedule

Use the deployed Dagster UI through the existing [VPS procedure](../deploy.md#data-services), with the
maintainer's normal access. Record the actual image digest/commit, code location, current schedule
state and run configuration. A merged commit or a successful build alone is insufficient.

1. Inventory materialized `gold/storm_cells`, `gold/storm_tracks`, `gold/storms`, `gold/storm_names`
   and `gold/storm_levels` partitions for the intended publication interval. Record available
   silver source hours and source outages separately from missing pipeline work.
2. Historical cells must contain usable per-source `minute_counts`; a schema field added to an old
   table does not reconstruct them. Use reviewed rematerialization/backfill procedures if counts are
   missing. Rebuild downstream tracking/classification in dependency and time order and retain run IDs.
3. Recover missed tracking hours oldest first, with the `storm-tracks` pool serialized. Keep
   `StormTracksConfig.new_chain=false` unless an explicit new-chain boundary is intended and documented.
   The guard fails on an untracked predecessor; enabling the schedule does not bypass that guard.
4. Confirm one stable name and one persisted classification per storm, accepted rule
   `sqrt(flashes × peak_rate)`, thresholds 8/25/120/450, best source and five names from ADR 0009.
   Record the deployed rule fingerprint, blocking asset checks and sample storm IDs/metrics.
5. Accept ADR 0011 or record an amendment before treating the catalog as production accepted.
   Classification uses storm membership/best-source metrics; replay initially selects track bounds
   and can include nearby unrelated flashes. `replay.flash_count` is not `storm.flashes`.

Repeat the inspection through the existing pinned-host SSH procedure; do not expose service
environment variables, credentials or unrelated production data in the evidence.

These are deployment-state checks. Do not infer them from unit-test results or enable the schedule
as part of a documentation PR.

## Controlled publication and recovery

Once prerequisites and deployed configuration are verified, use the existing hourly job to publish
an available partition. Record its Dagster run ID, partition and materialization metadata:
`changed`, `storms`, `skipped_storms`, `invalid_exports`, `bootstrap_remaining`, `pending_purge_tags`.
The historical bootstrap is capped at 100 unpublished, untouched storms per run; current/touched
storms are prioritized separately. A full historical catalog requires the backlog to drain, with
invalid/oversized exclusions counted explicitly.

Repeat an unchanged partition and compare stable slugs, immutable chunk paths/hashes and unchanged
detail bytes. Index publication timestamps may advance. Use isolated staging fixtures for missing,
invalid and oversized exports and interrupted publication; do not corrupt public production objects.
Existing #228 tests cover failure ordering and persistent purge retries. Production evidence should
confirm reference readability after real runs/restarts and that pending purge tags drain when cache
purge is configured; an empty outbox is not proof that all prerequisites ran.

## Public reference audit

From a network that reaches the public feed, first fetch `https://data.scintille.app/storms/index/0.json`.
Validate the current contract with the generated `StormIndexPage`/`StormDetail` models. Traverse the
advertised zero-based pages sequentially, deduplicate slugs and record the page/slug count. Resolve
chunk paths against the public data root, never the storm metadata directory. For each public
index entry, verify the detail and referenced chunks are readable and decode with matching counts.
Record the audit's byte/request bounds, timestamps and whether it covered every page/reference or
only a declared sample. A sample must not be reported as "no broken references in the catalog".

Separate publisher acceptance from the browser support limits proposed in #264: an otherwise valid
large public extract can exceed a client's supported memory/download budget and show a usable error.
Historical cloud absence is independent and must never cause substitution with today's clouds.

## Freshness observation and schedule decision

After the checks above, enable the existing schedule through the normal deployed Dagster controls
and record who enabled it, when, the persisted state and the first successful ticks. Do not change
the source default to RUNNING as a substitute for verifying prerequisites.

Observe consecutive successful hourly runs and at least one newly appearing storm. Record:

| Field | Value to collect |
| --- | --- |
| Storm slug / ID and source | Actual new storm, not a bootstrap item |
| Start UTC | Published `storm.t_start` |
| Source availability | Latest ingested source data / known delay or outage |
| First public visibility UTC | First successful detail+index read, polling interval and clock source |
| Publication freshness | First public visibility minus storm start; compare with 2 h |
| Run/partition and published_at | Cross-check with materialization and public cache response |
| HTTP Date/Age/cache state | Distinguish origin publication from publicly visible cached data |
| Exceptions | Missing sources/partitions, retries, rate limits and exclusions, without hiding failed samples |

At minute 20, the previous-hour job gives an ideal 80-minute delay for a storm starting at the
hour boundary **when prerequisites and source data are ready**. That is a scheduling calculation,
not a measured 2 h service guarantee. Attach dated observations before checking the freshness box.

## Decision record to complete

- [ ] ADR 0011 accepted or amendment linked; classified metrics and approximate replay count remain distinct.
- [ ] Deployed image/config and historical minute-count/level coverage verified, with run IDs.
- [ ] Missed hours recovered in order; bootstrap backlog and rejected exports accounted for.
- [ ] Controlled rerun/restart evidence and complete public reference audit attached.
- [ ] Schedule activation and measured new-storm freshness attached, with source limitations.
- [ ] Five actual catalog slugs/times handed to #83 and the complete journey review #261.

The inspection establishes why publication cannot yet run; it does not satisfy the successful
publication, reference integrity or freshness criteria. Keep #74 open until these observations are attached. M4 region publication does not block a
storm-only catalog, and M5 live cells/following do not enter this acceptance scope.
