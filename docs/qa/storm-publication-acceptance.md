# Storm publication acceptance (#74)

Prepared 2026-10-17 against main `a4ede5c`. **Production acceptance remains open.**
The merged exporter (#228), accepted classification (#72/ADR 0009) and historical cloud discovery
(#260) are implemented. This record adds no exporter, enables no schedule and changes no retention.

## Evidence available in this session

| Observation | What it proves |
| --- | --- |
| Source: `storm_catalog_schedule`, cron `20 * * * *`, UTC, default `STOPPED` | Code defaults only; persisted Dagster state can differ |
| `hourly_storm_catalog` selects catalog upstream assets | The job includes prerequisite materialization; it cannot repair skipped tracking hours by itself |
| [Latest images run inspected](https://github.com/pierregc/scintille/actions/runs/38254521478), 2026-10-12, failed builds/smoke, deploy skipped | No successful deployment evidence in this run; not a diagnosis of the current VPS |
| [Earlier successful images run inspected](https://github.com/pierregc/scintille/actions/runs/38252699040), 2026-10-12, deploy skipped | Successful image checks do not establish which image is running |
| Public catalog request from this sandbox, 2026-10-17, DNS resolution unavailable | Endpoint could not be inspected from this session; does not establish a production outage |
| ADR 0011 status is proposed | Replay selection still needs an explicit maintainer decision |

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

Keep #74 open until these observations are attached. M4 region publication does not block a
storm-only catalog, and M5 live cells/following do not enter this acceptance scope.
