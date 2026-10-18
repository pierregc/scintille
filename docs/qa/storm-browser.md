# Storm browser validation (#282 / PR #283)

Implementation follows [ADR 0020](../adr/0020-storm-catalog-search.md). The maintainer's request
on 2026-10-18 authorizes the design implementation. Preview visual acceptance remains pending.
No production schedule, bucket lifecycle, detection or activity thresholds were changed.

## Automated evidence

- Python: deterministic complete postings, byte/count bounds, duplicate/missing naming failures,
  interrupted writes, older-check rejection, idempotent manifest reuse, oversized-export fallback
  and reading previous minor-version public details.
- TypeScript: shared normalization fixtures, UTC day/month bounds, invalid query/cursor,
  traversal beyond 150 records without gaps/duplicates, seek ties, zero-result continuation,
  generation changes, missing word versus missing referenced object, false object sizes.
- Client: replacement cancels and ignores late responses even if fetch ignores abort; close
  cancels; decoded bodies bounded; errors do not retry automatically.
- Replay: entry closes discovery synchronously before loading/framing without premature navigation
  events. Existing replay, navigation, reload, coverage and offline-render tests also run.
- Projection: far hemisphere/horizon and close tilted camera checks.

Local HTTP checks used Astro 7.3.7 / Worker runtime with `LIVE` bound to local R2:
missing pointer returned 503 with `Cache-Control: no-store`; seeded Orlando search returned 200,
721 decoded bytes (before adding the current-generation response field), `Server-Timing: 4 reads / 760 bytes`, one candidate. Fixtures are synthetic.

## Reproduce local fixtures and measurements

From `data/`:

```sh
uv run python ../scripts/storm-search-fixture.py --out /tmp/storm-search
uv run python ../scripts/storm-search-fixture.py --out /tmp/storm-search-10k --count 10000
uv run python ../scripts/storm-search-fixture.py --out /tmp/storm-search-100k --count 100000
```

From the repository root:

```sh
pnpm -C web exec node scripts/seed-storm-search.mjs /tmp/storm-search
pnpm -C web exec astro dev --background
SCINTILLE_SEARCH_BENCH=/tmp/storm-search-100k pnpm -C web exec vitest run src/storms/search-benchmark.test.ts
```

The seeder writes only local `.wrangler/state/v3` R2, never a remote bucket. The single-record
fixture uses the existing Orlando replay slug. Serve the existing `fixtures/` feed on port 8787
as described in development setup; search and replay must use the same fixture dataset.
The larger datasets are search-only benchmarks: their synthetic slugs have no replay payloads.
Generated catalogs and measurement JSON stay in temporary directories.

On 2026-10-18, macOS, Node 26, Python 3.13, six words/storm, local filesystem object store:

| Synthetic storms | Index construction | Objects written | Bytes written (including pointer/manifest) |
| --- | --- | --- | --- |
| 10,000 | 1.175 s | 1,585 | 29,396,015 |
| 100,000 | 10.838 s | 14,236 | 294,800,229 |

These are full changed-generation writes, not compressed transfer, R2 upload time, or peak RAM.
Unchanged generations write only the check pointer. Old generations accumulate until a separate
retention decision; 24 changed hourly generations of this synthetic 100k dataset imply about
7.1 GB/day. Real data, object churn and index-build memory still need production measurements.

100,000-record query benchmark; 20 samples/query, warm local filesystem, no HTTP or edge cache:

| Query | Results | Decoded / gzip bytes | R2-model reads / decoded bytes | Candidates | Local disk p95 |
| --- | --- | --- | --- | --- | --- |
| Initial open | 20 | 7,301 / 1,094 | 4 / 21,173 | 20 | 1.045 ms |
| `place99`, before 2026-10-17 | 20 | 7,464 / 1,029 | 9 / 127,463 | 41 | 1.840 ms |
| North America + level 4 + start date | 20 | 7,339 / 1,044 | 5 / 21,275 | 20 | 0.776 ms |
| `region1` + level 1 | 0, continuation | 839 / 563 | 8 / 84,133 | 256 | 1.305 ms |

Gzip numbers use Node zlib and are estimates, not browser HAR transfer measurements. R2-model
counters count object bodies actually consumed by the query engine. Local disk p95 is not a
measurement of R2, Worker CPU or the proposed desktop 2 s / mobile 4 s Preview latency gates.
Closed browser, hover, orbit and close introduce no search call by construction; HAR confirmation
and cancellation-byte accounting remain pending. Replay bytes are separate from search bytes.

## Preview and manual acceptance still required

The in-app browser reported no available browser backends during implementation. No screenshots,
real touch interaction or visual acceptance are claimed. A deployed Preview must verify:

- Closed HUD: zero discovery requests; desktop search/focus/Escape; phone 320/390 px and landscape,
  on-screen keyboard, reduced motion and scrolling controls.
- Markers at poles/dateline/horizon, overlap groups, 44 px touch targets; drag/pinch/cancel must not
  launch a replay; coverage labels and other HUD targets must remain usable.
- Same selected slug through list keyboard action and marker tap; panel closed/full viewport
  restored before replay flight; reopen after errors; Back/Forward/reload and remount.
- Loading, empty, incomplete empty batch, stale, earlier generation, unavailable and Retry states.
- HAR bytes and R2 counters for first open, old query, combined filters, Next/Continue, Previous,
  warm repeat, cancelled requests and replay; declared network profiles and Worker CPU p99.
- Public details links once #88 supplies route capability. Production completeness/freshness from
  #74, which remains open. Maintainer approval of the final Preview before merge.
