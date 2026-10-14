# Retention measurements

Issue #41 remains a proposed decision ([ADR 0012](adr/0012-retention-policy.md)). This runbook
collects evidence without migrating tables, writing lake data, changing maintenance, or deleting
objects. Use credentials limited to catalog reads and bucket listing; do not run `migrate`,
`maintenance` output commands, Terraform apply, or expiration commands during measurement.

## Collect

From `data/`, with the existing `SCINTILLE_LAKE_*` connection configured by the maintainer:

```sh
uv run scintille-lake retention-report --label production-YYYY-MM-DD > /tmp/retention.json
```

The default table is `silver.flashes`. Repeat `--table` to include `bronze.ingest_log`,
`silver.flashes_quarantine`, and existing gold tables. Missing tables fail the collection rather
than silently reporting zero. The command reads Iceberg metadata and manifests, never Parquet
contents. It does not print connection settings or tokens. It emits JSON to stdout; keep exports
outside the repository and inspect them before sharing.

For physical storage measurements, export complete bucket listings using an already configured
S3-compatible CLI profile. Replace the endpoint and profile with the maintainer's existing values:

```sh
aws --profile scintille-readonly --endpoint-url https://ACCOUNT.r2.cloudflarestorage.com s3api list-objects-v2 --bucket scintille-lake --output json > /tmp/retention-lake.json
aws --profile scintille-readonly --endpoint-url https://ACCOUNT.r2.cloudflarestorage.com s3api list-objects-v2 --bucket scintille-live --output json > /tmp/retention-live.json
uv run scintille-lake retention-report --label production-YYYY-MM-DD --lake-inventory /tmp/retention-lake.json --live-inventory /tmp/retention-live.json > /tmp/retention.json
```

Keep automatic CLI pagination enabled: do not use `--no-paginate`, `--max-items`, or a prefix filter.
The reader rejects explicit truncation tokens and duplicate keys, but cannot detect an export whose
operator removed pages or filtered keys. Record the bucket, listing start/end, command, and whether
pagination completed separately. Empty inventories are valid observations only after checking the
bucket and export scope. Bucket listings contain object names; do not commit the raw exports.

Listing and manifest reads incur provider operations. The collector holds each inventory in memory;
large raw inventories may need to run on a machine with more memory. Concurrent writers or managed
maintenance can change files during collection. Collection start/end and each table snapshot ID
identify the observation; failed reads or missing referenced keys require a fresh collection.

## Interpret

The JSON separates observations without deriving growth forecasts:

| Field | Meaning and limitation |
|---|---|
| `current_partitions` | Current snapshot file bytes, file count, and physical row counts by day/source; includes today's partial partitions and flagged observations |
| `retained_manifest_file_bytes` | Unique data/delete files mentioned by retained manifests, including deleted entries; conservative referenced-file footprint, not additional bytes to add to current data |
| `referenced_object_count` | Current metadata, logged metadata versions, statistics, manifest lists, manifests, and their file entries as used by the existing orphan inventory |
| `inventory_coverage` | Matched referenced bytes and missing key count in the exported lake listing; a missing key can reflect concurrency, a partial export, or wrong bucket |
| `inventories` | Object counts/bytes by raw prefix, cloud prefix/tier, and other objects; physical duplicates in live/archive each count |
| `bytes_by_upload_day` | Bytes grouped by UTC last-modified date; upload cohorts, not source event days or total historic ingress |

Object counts unmatched to references are not a deletion candidate report. Current metadata may
retain older metadata versions; this command does not recursively reconstruct every older version.
Objects in `other/` include Iceberg files and unrelated bucket content. For a table's billed storage,
join the complete inventory to its location prefix and review metadata/manifest/data objects;
matched referenced bytes alone are not its full billed footprint.

## Evidence needed for acceptance

Collect at least seven complete UTC days for every deployed source, after compaction settles,
and extend the window if it misses active/quiet weather or a new source's commissioning period.
Record source coverage, completeness checks, calibration/parser versions, deployment interruptions,
and any backfill/overwrite. Use daily `lake_file_sizes` results to establish compaction state.
A small fixture or a single live manifest is not a representative storage measurement.

Calculate daily current-silver bytes and rows per source from complete partitions; report the
window's min/median/max and observed bytes per row. Separate overlapped/flagged rows from display
flash counts. Record snapshot count/age and the gap between referenced file bytes and current data.
Inventory `raw/` and both cloud tiers separately; repeat inventories over the observation window
and identify lifecycle deletions/reuploads before treating byte differences as ingress. Cloud
`live/` and `archive/` copies both consume storage; their cleanup behavior must be verified.

Publish a small aggregated table with date range, source, complete days, rows, bytes, and compaction
state, plus bucket-prefix totals and the exact observation timestamp. No such production values
are supplied by this PR. Keep yearly growth, 30-day cache sizes, and prices in a separate **estimate**
table, showing the assumptions and current official pricing link/date; seasonal extrapolation from
one week is uncertain. Account for metadata, retained files, orphan accumulation, operations, and
both tiers rather than pricing current silver alone.

Finally verify actual managed snapshot settings (3 days, minimum 5), the active `raw/` 30-day rule,
and `archive/clouds/` 30-day rule through read-only dashboard/CLI views. Declared defaults do not
prove production settings. The existing maintenance checks are evidence of behavior, not proof of
the configured expiry threshold.

## Maintainer decisions still required

Accept or revise permanent silver retention and its budget after reviewing the observations.
Choose whether older storms promise cloud replay, then define frame time padding, geographic/source
association, tiers, late/rebuilt storm behavior, and where preserved frames live outside the current
30-day lifecycle. Decide separately whether bronze logs, quarantine records, and gold tables need
age limits; no expiry for those is added here. Once accepted, apply/verify the chosen values using
the existing #27 maintenance procedure. This preparation does not close #41.
