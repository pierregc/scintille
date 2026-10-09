# Backfill and reprocessing

`silver/flashes_backfill` (Dagster) rebuilds whole partitions of `silver.flashes`, one day of one
source at a time, with the same parsing and validation code as the hot path
(`scintille_ingest.backfill`). The same mechanism reprocesses history when `parser_version` or
`calibration_version` changes.

1. Lists every product file of the day in the NOAA archive (bucket of the satellite operating the
   slot that day: GOES-16 then GOES-19 for East, GOES-17 then GOES-18 for West), plus the files a
   few minutes either side, whose flashes can cross midnight.
2. **Completeness first**: fewer than 99 % of the expected files (4,320 a day for GLM) and nothing
   is written.
3. Downloads in parallel, parses on one thread (HDF5 is not thread-safe), validates; rejected rows
   go to quarantine.
4. Under the partition's Postgres advisory lock (shared with lake-writer), overwrites the day of
   that source in `silver.flashes` and its rows in `bronze.ingest_log`, each in one commit. An
   interrupted run never reaches the commit, so the existing partition stays as it was.

Launch from the Dagster UI: select partitions (any date range × source) and materialize. Runs are
queued one backfill at a time (`scintille/backfill` tag limit in `dagster.yaml`); every partition is
independent, so a stopped backfill resumes by launching the missing partitions. The `raw/` cache is
not used yet: the hot path does not upload raw files (raw cache hook in #35).
