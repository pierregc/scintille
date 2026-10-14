# Retention measurements

Issue #41 remains a proposed decision ([ADR 0012](adr/0012-retention-policy.md)). Use read-only
catalog/listing credentials. The report reads metadata and manifests; it never scans Parquet,
migrates tables, changes maintenance, writes data, or deletes objects. Keep exports outside Git.

## Commands

From `data/`, with the maintainer's existing `SCINTILLE_LAKE_*` connection:

```sh
uv run scintille-lake retention-report --label production-YYYY-MM-DD > /tmp/retention.json
```

Default: `silver.flashes`. Repeat `--table` for bronze, quarantine, or existing gold tables.
Missing tables fail rather than report zero. Connection settings and tokens are not printed.
For physical storage, use the maintainer's existing S3 profile/endpoint:

```sh
aws --profile scintille-readonly --endpoint-url https://ACCOUNT.r2.cloudflarestorage.com s3api list-objects-v2 --bucket scintille-lake --output json > /tmp/retention-lake.json
aws --profile scintille-readonly --endpoint-url https://ACCOUNT.r2.cloudflarestorage.com s3api list-objects-v2 --bucket scintille-live --output json > /tmp/retention-live.json
uv run scintille-lake retention-report --label production-YYYY-MM-DD --lake-inventory /tmp/retention-lake.json --live-inventory /tmp/retention-live.json > /tmp/retention.json
```

Keep automatic pagination enabled; omit prefix filters, `--no-paginate`, and `--max-items`.
Record bucket, command, listing start/end, and completed pagination. Explicit truncation and duplicate
keys are rejected; filtered exports or removed pages cannot be detected. Verify empty bucket results.
Reads incur provider operations. Each unique manifest's entries are read once; each retained snapshot's
manifest list is read. Inventories are held in memory. Concurrent writes/compaction can invalidate
reads or leave missing referenced keys; recollect after failures and record snapshot IDs/timestamps.

## Fields

| Field | Meaning and limitation |
|---|---|
| `current_partitions` | Current data files/bytes and physical rows by partition; includes partial days and flagged observations |
| `retained_manifest_file_bytes` | Unique data/delete files mentioned by retained manifests, including deleted entries; overlaps current data, do not add the totals |
| `referenced_object_count` | Current/logged metadata, statistics, manifest lists/manifests, and their file entries; older metadata versions are not recursively reconstructed |
| `inventory_coverage` | Referenced bytes matched to the listing and missing keys; not a complete billed footprint or deletion-candidate report |
| `inventories` | Raw/cloud prefix and tier totals, plus `other/`; live/archive copies each count, top-level cloud files stay in their prefix group |
| `bytes_by_upload_day` | UTC last-modified cohorts; not source event days or historical ingress |

For billed table storage, also total inventory objects under its location, including unreferenced
files and metadata. `other/` includes Iceberg files and unrelated bucket content.

## Evidence and decisions needed for #41

- [ ] Measure at least seven complete UTC days per deployed source after compaction settles;
  extend for missing weather regimes or source commissioning. Record coverage, completeness,
  parser/calibration versions, outages, and backfills; include daily `lake_file_sizes` evidence.
- [ ] Publish aggregate per-source date ranges, rows/bytes, complete days, compaction state,
  min/median/max daily bytes, and bytes per row. Separate flagged/overlapping rows from display counts.
- [ ] Measure raw files, retained files/metadata, and both cloud tiers/copies. Repeat inventories;
  account for lifecycle deletions/reuploads before interpreting changes as ingress. Verify live cleanup.
- [ ] Separate observations from yearly/cache/cost estimates; state assumptions and current official
  pricing URL/date. Include metadata, orphans, retained files, operations, and cloud copies.
- [ ] Verify actual managed snapshot settings (3 days, minimum 5), `raw/` and `archive/clouds/` 30-day
  lifecycle rules through read-only views. Defaults/checks alone do not prove configured thresholds.
- [ ] Maintainer accepts or revises permanent silver retention and budget; defines older storm cloud
  replay, time padding, geographic/source association, tiers, late/rebuilt detections, and a protected
  prefix outside the existing 30-day rule. Bronze/quarantine/gold age limits remain separate choices.
- [ ] Accept the ADR and apply/verify chosen values through the #27 procedure, separately from measurement.

This preparation supplies no production measurements and does not close #41.
