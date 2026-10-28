# 0021 · Active storm cells: update cadence and feed contract

- Status: accepted
- Date: 2026-10-28

## Context

M5 lets a visitor pick a storm on the live globe and follow it (#257, #258). That needs the cells
active now, with ids that hold while the camera follows them, a footprint, a recent path and an
honest age. Today storms only exist hour by hour:

- `gold/storm_cells` clusters the flashes of `[H - 30 min, H + 1 h)` (ST-DBSCAN, 10 km, 10 min,
  10 flashes, fixed hot spots removed from three days of positions). `gold/storm_tracks` links each
  hour to the previous one; a storm takes the `cell_id` of its first cell,
  `sha1(window_start, first flash)`, and keeps it while it continues. Splits start a new storm
  (`split_from`), merges end storms into the main branch (`merged`).
- `hourly_storm_catalog` runs these assets, levels, names and the publication for hour `H` at
  `H + 1 h 20 min`, so a published storm is 20 to 80 minutes old plus the run, and only levels 3
  and up are published. Tracking hour `H` refuses to run until hour `H - 1` is tracked.
- `lake-writer` drains the spool into silver, then waits 5 minutes before the next drain. The live
  flash feed does not wait for it: 30 second chunks, a manifest polled every 30 s by the globe,
  which plays GLM 2 minutes and MTG LI 12 minutes behind the wall clock (`LIVE_DELAY_MS`).
- Dagster runs at most 2 runs at once (`max_concurrent_runs`), and `silver_changed` starts a
  `daily_gold` run after each new silver snapshot, at most every 10 minutes.

### Measurements

Measured read-only in production on 2026-10-28 between 15:20 and 16:25 UTC with
`docs/analysis/active-cells/measure.py`: the last 72 hours of silver and `bronze.ingest_log`
(`latency-2026-10-28.json`), the last 7 days of Dagster runs (`measurements-2026-10-28.json`),
and a replay of hours of 2026-10-18 and 19, the last ones the catalog tracked
(`replay-2026-10-19.json`). Storm volumes come from the 72 hours before 2026-10-19 10:00 UTC.

| Layer | Measure | p50 | p95 | p99 or max |
|---|---|---|---|---|
| GLM | flash to reception | 26 s | 41 s | 47 s |
| GLM | end of the 20 s file to reception | 15 s | 26 s | 32 s |
| MTG LI | flash to reception | 365 s | 636 s | 671 s |
| MTG LI | end of the 10 min file to reception | 59 s | 81 s | 214 s |
| Silver | interval between commits | 928 s | 1,137 s | 1,489 s |
| Silver | file reception to commit | 495 s | 985 s | 1,302 s |
| Silver | flash to commit, GLM East | 545 s | 1,063 s | 1,415 s |
| Silver | flash to commit, MTG LI | 888 s | 1,539 s | 1,869 s |
| Volume | flashes per hour, all sources | 133 k | 282 k | 364 k |
| Volume | storms per hourly window, all levels | 579 | 956 | 1,096 |
| Volume | storms per hourly window, level 2 and up | 400 | 674 | 842 |
| Volume | hull vertices, WKT bytes | 8, 162 | 14, 275 | 26, 522 |
| Dagster | `daily_gold` run, 103 a day | 177 s | 278 s | 446 s |
| Dagster | `hourly_storm_catalog` run | 78 s | 120 s | 132 s |
| Dagster | wait for a run slot, hourly jobs | 9 s | 147 s | 248 s |

Late data: no flash was received more than 10 minutes after its hour ended (GLM none after
5 minutes, MTG LI 0.025 %), and 0.025 % of MTG LI flashes reached silver after the catalog's run
at `H + 1 h 20 min`.

The replay recomputed three representative hours (2026-10-18 21:00, 2026-10-19 03:00 and 09:00
UTC, 76 k to 324 k flashes in the 90 minute window) at several minutes into the hour, with the
flashes received by then (spool) or committed by then (silver), linked to the catalog's previous
hour, or to its own version of it until 30 minutes into the hour. Each result is compared with the
complete hour linked by the catalog's code, which matched the catalog's ids for every storm.

| Minutes into the hour | 10 | 20 | 30 | 45 | 60 |
|---|---|---|---|---|---|
| Flashes whose storm already has its final id, spool, worst hour | 86 % | 86 % | 90 % | 95 % | 98 % |
| Same with silver | 85 % | 86 % | 89 % | 90 % | 97 % |
| Clustering and linking, quiet hours / 324 k flash hour | 3 to 4 s / 23 s | 3 to 4 s / 26 s | 1 to 2 s / 10 s | 2 s / 12 s | 2 s / 14 s |
| Age of the newest GLM flash, spool / silver | 21 s / 261 to 421 s | 21 s / 241 to 481 s | 21 s / 221 to 521 s | 21 s / 121 to 541 s | 21 s / 241 to 461 s |

Averaged over the hour, 91 to 97 % of flashes already carried their final id with the spool.
Reading the 2.5 hours of silver took 5 to 7 s and the hot spot scan 75 s. A compact snapshot of
every storm of the hour weighed 56 to 122 KB gzipped at 60 minutes. A fourth hour, 2026-10-18
15:00, caught an ingestion stop: from about 15:08 UTC flashes arrived more than 80 minutes late,
the newest data stopped advancing and only 78 to 81 % of flashes had their final id.

The same run also showed:

- Silver commits every 15 minutes, not 5: a drain takes 5 to 10 minutes before the 5 minute wait.
  The daily median interval grew from 518 s on 2026-10-18 to 984 s on 2026-10-28, about 45 s a
  day.
- `hourly_storm_catalog` failed all 168 runs of the week. One hour was not tracked on 2026-10-19
  around 10:00 UTC and every later hour refused to run, so the catalog has not moved since.
- One `lake_weekly_maintenance` run held a Dagster slot for 63 hours before failing.
- The VPS has 4 vCPU and 7.6 GiB. `dagster-daemon` used 2.1 cores and 1.6 GiB, the load average
  was 1.4, and 4 GiB were available.
- MTG LI had been offline since 12:41 UTC that day.

## Options

**Shorter authoritative windows.** 10 or 15 minute partitions for cells and tracks would give one
pipeline and one set of ids. It changes the accepted catalog: six times the track steps and
commits, a 30 minute overlap longer than the window, a serial tracking chain where one failed
partition stops every later one (as it did on 2026-10-19), and three days of hot spot positions
read for every partition. It would also still wait for silver.

**Incremental clustering per product file.** A stateful process updating clusters as each file
lands would be the freshest, but ST-DBSCAN with merges and splits depends on arrival order, its
results would drift from the catalog's, and its state needs checkpoints. MTG LI delivers one file
per 10 minutes anyway, and recomputing a whole window costs seconds (above), so incremental state
buys little. ADR 0006 sets the bar for that kind of stream processing (storm tracking in seconds)
and this does not reach it.

**Recompute the open hour, bounded.** At each update, rerun the catalog's own functions
(`hour_cells`, `link`, the ADR 0009 levels) on the hours the catalog has not tracked yet, chained
to the last hour it tracked, and publish one snapshot. Each update reads a bounded window, is
deterministic for a given input, and converges to the catalog's result once an hour is complete.
Its inputs:

- silver alone: the catalog's own data, with `flash_id`, so ids match, but 9 minutes behind at
  p50 and 18 at p95 for GLM, and only every 15 minutes;
- live chunks: 1 to 2 minutes behind, but without `flash_id`, so no id could ever match the
  catalog's;
- silver plus the spool batches `lake-writer` has not committed yet: the same rows with the same
  `flash_id`, available seconds after reception, and ids as stable as with silver alone (above).
  But the spool is `lake-writer`'s private directory, deleted after each commit: a second reader
  turns it into a hidden contract and has to survive deletes in the middle of its reads. Silver is
  the contract ADR 0006 gives the batch side, and its delay is a fault to fix there (5 minutes by
  design, 15 measured).

Where it runs: a Dagster job started by a sensor shares the two run slots with `daily_gold`, which
starts on the same silver snapshots, and with the catalog, whose wait already reaches 4 minutes;
a single long run can hold a slot for days. It boots a process per run and adds 288 runs a day to
the run history. A small service, like `clouds`, keeps its caches warm, runs one update at a time
and reports its own health.

## Decision

A long-running `active-storms` service recomputes the hours the catalog has not tracked every
5 minutes, from silver, with the catalog's own clustering, linking and levels, and rewrites one
object, `storms/active.json` (contract 2.6.0).

**Inputs.** At each update the service loads the current silver snapshot and reads the flashes of
its window. It never writes to silver or gold. The freshness targets below need GLM flashes in
silver within 2 minutes at p95 (18 minutes measured), which is the lake's fix to make, not this
service's.

**Spool, as a transition only.** If silver misses that bar when #257 is measured, the service
also reads the spool batches not committed yet, until silver meets it for a week; then that code
is removed. Read-only mount, spool first and then the silver snapshot, rows deduplicated by
`flash_id` with silver first, files older than the window skipped by modification time, and a file
deleted during the read skipped, since it is then in silver. If the spool cannot be read, the
service goes on from silver alone and `observed_until` shows the delay.

**Hours.** The catalog's last tracked hour sets `authoritative_until`. The service recomputes the
open hour and each closed hour after `authoritative_until` until it is 15 minutes past its end
(no flash arrived later than 10 minutes in the 72 hours measured), then keeps its own version of
that hour to chain the next one, until the catalog tracks it. Hot spots are rescanned once per
hour with the catalog's rule, apart from the updates, which use the latest scan. An update
therefore clusters 90 minutes of flashes, and 150 minutes in the first quarter of each hour.

**Ids.** A storm that started in an hour the catalog tracked keeps its catalog `storm_id`, final.
A later storm gets the id the catalog's formula gives on the data so far, provisional: when the
catalog tracks that hour with the same first flash, the id is unchanged and becomes final. A storm
that leaves `cells` without expiring or merging is `replaced` by the storm that now holds most of
its flashes, which lists it in `previous_ids`. If the catalog stops, the service keeps chaining
its own hours: storms stay provisional, ids hold, and `authoritative_until` ages. After a restart
the service reads its last snapshot back, so levels, `ended` and `previous_ids` carry over; if the
catalog is then behind its window, a provisional id can change once, published as `replaced` to
the storm whose hull overlaps it most.

**Contract.** `storms/active.json` (`ActiveStorms`, `docs/data-contract.md`) carries
`published_at`, `authoritative_until`, `update_seconds`, `min_level`, each source's
`observed_until`, the cells and the storms ended in the last 2 hours. A storm expires 30 minutes
of its sources' data after its last flash, ends `source-gap` once its sources have been silent for
an hour, and its `level` only rises. `path` holds 10 minute centroids over the last 2 hours; the
catalog keeps the full track and remains the record for replay. Snapshots are not archived.
`min_level` is 2: at most 842 storms of level 2 and up were seen in an hour, an estimated 150 KB
gzipped in this contract's format. Each snapshot and each transition is checked by
`scintille_contract.active` before it is written.

**Targets.** #257 holds them on representative loads, peak hours included.

| Target | Value | From |
|---|---|---|
| Update interval (`update_seconds`) | 300 s | |
| Processing, update start to object written | p95 90 s, max 180 s | read 5 to 7 s, clustering up to 26 s at 324 k flashes; peak windows reach 544 k |
| Age at publication (`published_at - observed_until`), GLM | p95 240 s | 26 s p95 delivery, 2 min to silver |
| Age at publication, MTG LI | p95 900 s | 10 min files, 81 s p95 delivery, 2 min to silver |
| Flashes whose storm already has its final id | 85 % at each update, 90 % over each hour | worst update 86 %, worst hour 91 % |
| Snapshot size | 256 KiB gzipped, 1 MiB raw | about 180 B gzipped per storm, estimated |
| Stale alarm, `published_at` older than | 900 s | three missed updates |
| Catalog alarm, `authoritative_until` older than | 3 h | normally 22 to 82 minutes |

The id target holds outside ingestion stops; during one, `observed_until` stops and the storms of
that source end `source-gap` after an hour, as in the replayed hour of 2026-10-18 15:00.

**Backpressure.** One update at a time, never queued: an update that overruns starts the next one
at once, and the longer interval shows in `published_at`. The window stays at most 150 minutes of
flashes whatever the catalog's lag, and the container is limited to one CPU and 1 GiB. A failed
read or write keeps the previous object in place; clients see its age.

**Clients.** The object is served with `Cache-Control: public, max-age=30`. Clients poll it every
60 s while the live globe is open, with the cached ETag so an unchanged object costs no body, and
show each storm's age from its sources' `observed_until`. A storm is drawn at the earlier of the
scene time and that time, never extrapolated: no forecast.

**GLM and MTG LI.** GLM files cover 20 s and arrive about 15 s after their end; MTG LI files cover
10 minutes and arrive about a minute after theirs. So a GLM storm is 2 to 4 minutes old at
publication and an MTG LI storm up to 15, and the contract carries one `observed_until` per source
so each storm is judged on its own data. A lower MTG LI latency (#204) or a lower live latency
(#115) shortens these ages without any change here. Neither is a prerequisite, and neither is the
limit today: silver is.

## Consequences

- Cost: 288 updates a day of 6 to 33 s each at the measured loads, plus 24 hot spot scans of 75 s,
  so about 2 CPU hours a day on the VPS; 288 writes a day to R2 and one object stored.
  Each update loads silver's metadata and reads its window from R2: the number of data files read
  per update is the cost to watch.
- Viewers see a GLM storm about 3 to 9 minutes old once silver meets its bar, against roughly 9
  to 30 minutes at today's commit interval.
- Freshness of active cells depends on how fast silver commits. Today's interval, 15 minutes
  instead of the 5 in ADR 0006 and growing by about 45 s a day, also delays the catalog and
  `daily_gold`; if it keeps growing, the catalog's run at `H + 1 h 20 min` will miss flashes and
  replace provisional ids that were right.
- If the spool transition is needed, `lake-writer` stays the spool's only owner, the transition is
  written as temporary in #257, and it ends when silver meets the bar for a week.
- Provisional ids can change: a viewer following a provisional storm may see it continue under
  another id, which the client follows through `previous_ids` and `ended`.
- The catalog's chain is a single point of failure for final ids, as the week measured shows. The
  feed keeps working through it, provisional, and the catalog alarm makes the outage visible.
- The service adds a container to watch: its health endpoint and both alarms join the existing
  operations checks (#257).
- Tickets to update after acceptance: #257 (targets and architecture), #258 (client polling and
  the age rules above).
