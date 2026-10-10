# Backfill and reprocessing

`silver/flashes_backfill` (Dagster) rebuilds whole partitions of `silver.flashes`, one day of one
source at a time, with the same parsing and validation code as the hot path
(`scintille_ingest.backfill`). The same mechanism reprocesses history when `parser_version` or
`calibration_version` changes.

1. Lists every product file of the day in the NOAA archive (bucket of the satellite operating the
   slot that day: GOES-16 then GOES-19 for East, GOES-17 then GOES-18 for West), plus the files a
   few minutes either side, whose flashes can cross midnight.
2. **Completeness first**: fewer than 99 % of the expected files (4,320 a day for GLM) and nothing
   is written. Only the day after it ends (plus one hour) can be rebuilt. A reprocessed upstream
   file (same start time, later name) replaces the original.
3. Downloads in parallel, parses on one thread (HDF5 is not thread-safe), validates. The 99 % rule
   applies again to the files that actually parsed, and an empty result is refused: unreadable
   files never replace a good partition.
4. Under the partition's Postgres advisory lock (shared with lake-writer), refuses to write while
   the hot path still has spooled files of that day (in `ingest_files`, not yet in bronze): they
   would land on top of the rebuild as duplicates. Once lake-writer has drained them, relaunch.
   If the spool is known to be lost, the run config `ignore_pending: true` skips this guard.
5. Replaces, each in one Iceberg commit: the day of that source in `silver.flashes` (deduplicated
   on `flash_id`), its rows in `bronze.ingest_log` (on `key`) and the quarantine rows of its files.
   An interrupted run never reaches the commits, so the partition stays as it was; Iceberg has no
   cross-table transaction, so a crash between the three commits is repaired by relaunching the
   same partition (every step is a replacement, so a rerun is idempotent).

Launch from the Dagster UI: select partitions (any date range × source) and materialize. Runs are
queued one backfill at a time (the asset is in the `noaa` pool, limited to one run in
`dagster.yaml`); every partition is
independent, so a stopped backfill resumes by launching the missing partitions. The `raw/` cache is
not used yet: the hot path does not upload raw files (raw cache hook in #35).
