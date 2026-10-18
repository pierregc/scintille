# #282 — Storm catalog browser: proposal for maintainer review

**Status: proposed; implementation is not authorized by this document.**

Prepared on 2026-10-18 for [issue #282](https://github.com/pierregc/scintille/issues/282).
Repository inspected: `main` at `ef10aeeb2487aad723f0133a9449dd7ca3597fba`, also verified as
GitHub's current `main` during preparation. Issue descriptions and dependency states were read on
the same date. Recheck them before implementation.

This is a design and implementation handoff, not a completed feature or an accepted ADR. All byte
limits and performance targets below are **proposed budgets**, not measurements. Repository docs
and UI copy remain in English, following `AGENTS.md`.

## 1. Decision requested

Expand **Explore storms** into a searchable, paginated browser. Keep the existing globe as the
map; show restrained location markers only while browsing. Close the browser before entering a
replay through `app.replay.open(slug)`.

Use the existing Cloudflare Worker to query a **partitioned, versioned search index in R2**,
published by the storm pipeline. Download at most 20 results and 64 KiB of decoded JSON per
browser request. Search must reach old published storms, beyond the suggestion window.

The principal tradeoff is query complexity: the proposed first version supports exact normalized
words and UTC dates, with AND semantics. It does not promise fuzzy matching, arbitrary substrings,
or natural-language dates. Very selective combinations can return a continuation before finding
20 results. The UI must distinguish this from a completed search with no results.

Approve or amend these choices before another agent starts implementation:

- [ ] **Layout:** left column on desktop, bottom sheet on phones, with space reserved for the
  globe so the browser does not cover the replay. Existing HUD typography and restrained colours.
- [ ] **Map:** at most 20 markers for the current result page, on the existing globe; no second
  map, permanent toolbar, or claim that the markers represent the whole catalog.
- [ ] **Search:** complete place/country words, accent-insensitive matching, ISO UTC dates;
  period, geographic-region and electrical-activity-level filters.
- [ ] **Pagination:** explicit Next/Continue actions; a bounded query may need continuation.
  No automatic traversal of an arbitrary number of search batches.
- [ ] **Architecture:** pipeline search index + same-origin Worker endpoint over the existing
  `LIVE` R2 binding. No new database or search service in this version.
- [ ] **Delivery:** one implementation branch/PR for #282, with a new ADR and both data/web
  validation. Maintainer reviews the deployed Preview before the issue is closed.

If typo tolerance, prefix-as-you-type search, or consistently full pages for arbitrary filter
combinations are required, revise the search architecture first. Do not conceal those additional
requirements inside the implementation.

## 2. What exists today

| Area | Inspected source | Consequence |
| --- | --- | --- |
| Discovery UI | [`StormSuggestions.astro`](../../web/src/components/StormSuggestions.astro) | Closed by default; opens four cards; calls `app.replay.open`; handles basic states and Escape. |
| Suggestions | [`replay/catalog.ts`](../../web/src/globe/replay/catalog.ts) | Reads at most three 50-item pages, capped at 128 KiB each, then chooses four cards. This is not a search over all published storms. |
| Shared replay entry | [`replay/index.ts`](../../web/src/globe/replay/index.ts) | Owns selection, cancellation, framing and replay errors. `open` returns a boolean; it does not accept an AbortSignal. |
| Navigation | [`replay/navigation.ts`](../../web/src/globe/replay/navigation.ts), [`checkpoint.ts`](../../web/src/globe/replay/checkpoint.ts) | Existing share/reload/history behaviour must survive browser integration. |
| Public contract | [`storm.schema.json`](../../data/contract/storm.schema.json) | `StormSummary` has labels, dates, country and classified metrics, but no map coordinate. `StormDetail` has track and bounds. |
| Available naming data | [`storm_names.py`](../../data/packages/scintille-pipelines/src/scintille_pipelines/storm_names.py) | Already stores place, admin region, country name/code, sea, and first-named centroid. No new geocoding service is needed. |
| Publication | [`storm_catalog.py`](../../data/packages/scintille-pipelines/src/scintille_pipelines/storm_catalog.py), [`storm_publication.py`](../../data/packages/scintille-pipelines/src/scintille_pipelines/storm_publication.py) | Publishes chunks, bounded detail, 50-item index pages and sitemaps. Rejects invalid/oversized exports and can retain their previous published summaries. |
| Hosting | [`wrangler.jsonc`](../../web/wrangler.jsonc), [`deploy.md`](../deploy.md) | Astro already runs on Workers; `LIVE` binds production R2 and a separate Preview bucket. |
| Rendering | [`app.ts`](../../web/src/globe/app.ts) | Owns scene, camera, render loop and disposal. Current resize uses window dimensions, so reserving browser space requires real viewport integration. |
| Visual language | [`visual-direction.md`](../visual-direction.md) | A2: globe first, light typography, hairlines, restrained gradients, no dense dashboard. |

Dependency status at inspection:

- [#81 suggestions](https://github.com/pierregc/scintille/issues/81) and
  [#79 replay entry](https://github.com/pierregc/scintille/issues/79): closed; reuse their implementation.
- [#74 publication](https://github.com/pierregc/scintille/issues/74): open. Core code exists, but
  production prerequisites, historical bootstrap and freshness evidence remain. The inspected
  schedule defaults to `STOPPED`; that does not establish its deployed Dagster state.
- [#88 storm pages](https://github.com/pierregc/scintille/issues/88): open; no storm-page routes
  were present in the inspected tree. Coordinate link availability rather than inventing links.
- [ADR 0011](../adr/0011-storm-publication-contract.md) remains proposed. Preserve its bounded
  publication and approximate replay provenance; this proposal does not silently accept it.

## 3. Visitor experience and design

### Closed and open states

Closed: retain the existing **Explore storms** entry. No catalog/search network requests and no
map markers before the first explicit opening. The globe retains the full viewport.

Open, desktop: reserve approximately 360 px on the left, with the result list scrolling inside
that column. Open, phone: reserve a bottom sheet of approximately 45% of the available visual
viewport; keep the globe above it. The exact breakpoint and sizes require Preview review, with
320 px width and landscape included. The on-screen keyboard must not hide the search action.

These are wireframes, not screenshots or measured renderings:

```text
Desktop
┌─────────────────────────────┬─────────────────────────────────────┐
│ Explore storms       Close  │                      UTC clock      │
│ Place, country or date      │                                     │
│ [________________] Search   │        EXISTING 3D GLOBE             │
│ Period  Region  Level       │             · 2                     │
│                             │      · 1                            │
│ 1  Place · date · level     │                    · 3              │
│    flashes · peak/min       │                                     │
│    Replay   Storm details   │   Markers represent this page only  │
│ 2  ...                      │                                     │
│ Previous              Next  │           existing replay controls  │
│ Updated … · provenance      │                                     │
└─────────────────────────────┴─────────────────────────────────────┘

Phone
┌─────────────────────────────────┐
│ Clock / existing compact HUD    │
│          EXISTING GLOBE          │
│       · 1           · 2         │
│ Existing timeline, when active  │
├─────────────────────────────────┤
│ Explore storms           Close  │
│ [Place, country or date] Search │
│ Period    Region    Level       │
│ Scrollable results              │
│ Previous                   Next │
└─────────────────────────────────┘
```

Use the existing font and colour tokens. Present rows separated by hairlines, not a new grid of
heavy cards. A soft edge gradient can support readability. No thumbnails: they add requests and
are not necessary to identify a storm. Close About when opening Explore, and vice versa.

Reserve actual rendering space rather than covering a full-size canvas with the sheet. Update
renderer, postprocessing, camera aspect and control sizing together. Keep the clock and timeline
anchored to the globe area. A `ResizeObserver` on the canvas container should drive the normal
viewport; retain the explicit dimensions of offline `/render/` mode. Avoid CSS-only scaling of
the old canvas, which would break projection and pointer hit testing.

### Query controls

| Control | Proposed behaviour |
| --- | --- |
| Search | Label `Place, country or date`; explicit Search button/Enter submission. Maximum 120 Unicode characters and four normalized text words. No request per keystroke. |
| Text | Case/diacritic insensitive; complete words from published name, label, place, admin region, country name/code and sea. All words must occur in the same record; word order is irrelevant. |
| Dates in search | Recognize `YYYY-MM-DD` and `YYYY-MM`; turn them into visible UTC date chips. Reject impossible dates. Explain unsupported formats instead of silently ignoring them. |
| Period | `Any time` by default, `Last 7 days`, `Last 30 days`, `Custom dates`. Filter by storm **start time**, explicitly labelled. A date interval is `[from, to)` in UTC. |
| Region | `All regions`, Africa, Asia, Europe, North America, South America, Oceania, Antarctica, and `Offshore / unassigned`. Country can be searched by name or ISO alpha-2 code. |
| Level | All, or one persisted level 1–5 with its published electrical-activity name. No new intensity thresholds and no weather-warning language. |
| Reset | Clear text and all filters; return to the first page. |

Text such as `São Paulo` must match `sao paulo`. `France 2026-10-05` becomes one text word plus
one UTC day. A date chip and the period picker control the same interval: changing either replaces
that interval, so hidden contradictory filters cannot accumulate. Relative periods become fixed
absolute times when submitted and remain fixed through pagination.

Document normalization with shared Python/TypeScript golden fixtures: Unicode normalization,
case handling, combining marks, punctuation, whitespace, and token deduplication. Do not depend on
locale-sensitive browser behaviour. Preserve non-Latin letters and numbers; do not claim language
translation or transliteration. `Fra` is not an abbreviation for `France` in this version.

Regions are a versioned, checked-in mapping from published country codes, using the naming
pipeline's geography as the starting point. They describe the named location, not every territory
crossed by the storm. Offshore records keep their null country rather than being assigned to the
nearest country. Missing mappings enter the explicitly named unassigned category and are counted
in publication diagnostics.

### Results, map and replay

- Return newest first, with a stable tie-breaker: `(t_start DESC, slug ASC)`. Use the same order
  in index construction, date seeking, cursor handling and tests. Do not reorder search results
  with `chooseStorms`; variety ranking is specific to the four suggestions.
- Show place label, UTC date/start/end, published activity level, classified flash count and peak
  rate. Keep the existing explanation of electrical activity and approximate replay extracts.
- Use a `Replay` button and a separate `Storm details` link where the #88 route is available.
  Do not nest links inside buttons or issue HEAD requests for every result.
- Each result has a small matching number on the globe. Markers are static outlines, visually
  distinct from flashes, with at most 20 mounted. They identify the first-named centroid from
  `gold/storm_names`; they are not a current storm location, extent, trajectory or severity map.
- List hover/focus highlights its visible marker. Clicking/tapping a marker invokes the same
  `openResult(slug)` handler as its Replay button. The list is the complete keyboard equivalent.
- Hide markers behind the Earth, outside the visible viewport and under unrelated HUD elements.
  Derive occlusion from camera-to-point geometry, including tilted close views. Antimeridian and
  polar coordinates use the existing `latLonToVector` convention.
- Overlapping hit targets form one local group: activating it reveals/focuses the corresponding
  rows in the panel, with no query. Do not use map clusters as an estimate of worldwide activity.
  Existing globe gestures reveal the far side; a short panel caption explains this. No new globe
  zoom/filter controls and no network requests on orbit, hover, focus or resize.
- Use at least 44 px touch targets around small visual markers. A drag, pinch or pointer cancel
  must never launch a replay. Coordinate with the existing coverage-label tap handler.

On Replay activation, synchronously close the panel, clear its markers and restore the full
viewport **before** invoking `app.replay.open(slug)`, so framing uses the final aspect ratio.
Keep query/page state in memory for reopening. The existing HUD reports loading and replay
failure; a failed selection must leave Explore accessible and the previous usable scene intact.
Do not reopen the panel automatically after a delayed failure and cover another selection.

Observe existing replay state when navigation or another entry point opens a replay: hide markers
and close the browser for that transition too. Browsing alone changes neither scene time nor
replay selection. Do not add query parameters that collide with replay share/reload URLs.

Accessibility: use native form controls, ordered result rows, visible focus, a polite result-count
status, and Escape/Close returning focus to Explore. After successful replay, focus the existing
play control, as today. Keep the globe operable when the sheet is open; this is a non-modal region,
not a modal dialog with an inconsistent focus trap. Honour reduced motion. Do not rely on hover
or colour to identify a result.

## 4. Search architecture

### Why a separate index

Filtering the first three existing catalog pages would miss older storms and give false empty
results. Walking all pages in the browser violates #282. Moving an unbounded scan of those same
pages into the Worker would only relocate the problem.

Propose a small inverted index: a **posting list** is the chronologically sorted set of searchable
records containing one word or one filter value. A request selects the smallest relevant list,
seeks into its requested start-date range, and examines a bounded batch. It never lists the R2
bucket, reads Parquet, or downloads a monolithic search file.

Alternative decisions considered:

| Option | Assessment |
| --- | --- |
| Client downloads a single compressed index | Simple initially, but grows with the entire catalog; reject. |
| Client filters bounded recent catalog pages | Suitable for #81, fails full-catalog search; reject. |
| Separate search service or database | Could improve arbitrary queries, but introduces provisioning, synchronization and operations beyond the existing stack; reconsider if the bounded R2 design fails the UX/performance gate below. |
| Worker + versioned R2 postings | Recommended: fits the ticket's explicit options, reuses hosting and publication, has enforceable per-request budgets. Costs include index duplication, publication work and potentially sparse result batches. |

### New records and immutable generations

Add separate search schemas under `data/contract/`; retain the existing detail/index formats.
Use `schema_version` for contract compatibility and a distinct immutable `generation` for dataset
identity. Follow the contract's SemVer process; do not hard-code a future version number here.

Conceptual R2 layout:

```text
storms/search/latest.json                       # <= 4 KiB; generation + timestamps
storms/search/<generation>/manifest.json        # <= 4 KiB; versions, counts, limits
storms/search/<generation>/lists/<key>/meta.json # <= 2 KiB; count, page_count, date extrema
storms/search/<generation>/lists/<key>/0.json    # <= 64 KiB, <= 64 records
storms/search/<generation>/lists/<key>/1.json
...
```

Keys are stable hashes of a typed canonical selector: `all`, `word:<normalized word>`,
`region:<id>`, `level:<n>`. Hashing avoids unsafe object keys; store and verify the selector in
metadata. There is no ever-growing term directory in `latest.json` or the manifest. A missing
posting metadata object for a valid term means that term has no matches in a successfully
published generation; a missing referenced page is an error.

Each record is a bounded projection with slug, label, start/end, country, region, persisted level
and name, classified flashes, peak rate, marker `{lat, lon}`, and the normalized searchable words.
It does not embed track arrays, replay chunks, `level_rule` explanations or image data. Cap encoded
record size at 8 KiB and split pages by both bytes and count; never silently truncate words or drop
published storms to meet a budget. A record outside the agreed schema/budget fails generation
publication while the previous generation remains usable. Measure any such failures explicitly.

One record can appear in the all-storms, region, level and several word lists. Deduplicate words
per record. This duplicates bytes intentionally to avoid fetching 20 storm-detail documents per
query. **Compactness must be measured**, including total bytes, object count, average words per
storm, generation time and bytes rewritten hourly. Do not infer it from the small HTTP response.

Use deterministic serialization, record ordering and generation identity. Re-running identical
input reuses the generation. Bound each posting list to at most `2^24 - 1` pages, allowing at most
24 binary-search probes. Exceeding that supported capacity fails publication visibly; do not
silently exclude older entries. This is a format capacity, not an archive retention policy.

### Publication correctness

Build search records from the **actually accepted public snapshot**, after the publication code
has resolved rejected/oversized exports and retained old summaries. Do not simply index the
`visible` list passed into `publish_catalog`: that function performs another oversized-detail
fallback internally. Refactor it to expose the effective published set to search construction.

Join that set with stable naming coordinates and geographic fields. Resolve legacy records from
published details plus naming data during bootstrap; if necessary use an observed track point
with explicit provenance. Never invent `(0, 0)` coordinates or compute an ordinary longitude
mean across the antimeridian. An unresolved record prevents a supposedly complete new generation
from replacing the previous one and produces a diagnostic for #74.

Publish replay chunks and details first, then the existing index/sitemaps and search objects.
Write the immutable search manifest after all its postings are present; replace `latest.json`
last. The final pointer is the commit point for search. A failed search build can leave the older
search generation active while ordinary publication proceeds; expose its older publication time.
Only the existing serialized publication job writes that pointer. Retry interruption/idempotence
cases and prevent overlapping runs from moving it backwards.

Keep a `catalog_checked_at` timestamp in the mutable pointer, updated only after a successful
complete publication/check, including when the generation is unchanged. The immutable manifest's
`published_at` remains its creation time. This distinguishes an unchanged but healthy catalog
from a stalled publisher; a failed search build must not refresh `catalog_checked_at`.

Immutable search generations freeze membership/order/summary values. Storm detail URLs remain
mutable under ADR 0011; replay may legitimately show a more recent classification for an active
storm. Do not describe the generation as an immutable snapshot of replay content.

Retain old generations throughout this feature's rollout; no deletion job or R2 lifecycle change
is authorized by this proposal. Measure storage growth and record a separate retention follow-up.
Use a 24-hour cursor lifetime initially, even though retained generations may live longer.

### Query algorithm and bounds

Proposed endpoint: `GET /api/storms/search` as an Astro on-demand endpoint using `env.LIVE`.
The browser sends only validated query parameters and an optional cursor; R2 paths and base URLs
are never supplied by the caller. Astro supports per-route on-demand API endpoints, and R2 exposes
object metadata/body reads through the existing binding. See the official
[Astro endpoint guide](https://docs.astro.build/en/guides/endpoints/) and
[R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

1. Validate query length, words, UTC date bounds, region enum, level and cursor before R2 reads.
2. Resolve the current generation, or the cursor's retained generation. Read its manifest.
3. Read metadata for up to four words plus the selected region and level (at most six lists;
   use `all` when there is no other selector). Pick the list with the fewest records. A missing
   required word/region/level list proves an empty intersection immediately.
4. On the first request, binary-search the chosen list's page time boundaries to skip records
   newer than `to`. Probe at most 24 pages; support ties spanning page boundaries. Then iterate
   in stable order until `from`, the end, 20 matches, or four candidate-page reads are reached.
5. Test every candidate against all words/filters. Carry the precise next unread page and row
   in the continuation; stopping after result 20 must not skip the rest of that page.
6. Return results and a cursor if any candidates remain. Resume directly on continuation without
   repeating date seeking. A cursor advances even when a scan batch finds zero matches.

The cursor contains generation, canonical-query hash, selected list, next page/row and expiry.
Bound its encoded length to 1 KiB, validate every field and its correspondence to the query,
and derive every R2 path server-side. It confers no write access; authentication/signing is not
required for this public read cursor. Reject malformed state; changing the query starts over.

| Budget | Hard proposed maximum |
| --- | --- |
| Browser requests per submitted search/filter change/Next/Continue | 1; no automatic retries |
| Browser decoded response body | 64 KiB, enforced while reading, including errors |
| Results per response / visible map markers | 20 |
| Worker R2 reads per cold first query | 36: pointer + manifest + 6 list metadata + 24 seek pages + 4 scan pages |
| Worker R2 bytes per cold first query | < 2 MiB: 8 KiB + 12 KiB + 28 × 64 KiB = 1,812 KiB maximum |
| Worker candidate rows tested after seek | 256 maximum (4 × 64); probes do not become unbounded filtering scans |
| Continuation | <= 12 R2 reads / 276 KiB with metadata validation and four pages; no date seek |
| Client request timeout | 15 seconds; abort response consumption on timeout/replacement/close |
| Client retained result pages | 5 pages / <= 320 KiB of decoded response bodies; current page alone has markers |

Check R2 object size before consuming its body and still enforce body/aggregate byte limits.
No full `.json()` read of an unchecked object. Include JSON envelopes in every byte limit. Stop
before adding a record that would exceed the 64 KiB response: return the current page with the
cursor at that unread record. The 8 KiB record limit guarantees one result can make progress.
Release each page after processing; do not retain all binary-search probes in memory.

These are ceilings, not acceptable normal-case latency. A cold query that does many sequential
R2 reads can be slow even with little Worker CPU. Benchmark early. Proposed UX gate: on the
representative fixture matrix, common place/country/period searches produce their first result
batch within 2 seconds p95 under declared desktop network conditions, and within 4 seconds on
the declared touch/network profile. Report CPU p99 separately and follow ADR 0005's measured
hosting-plan decision; do not assert the current Free budget is sufficient without evidence.

For restrictive combinations, first-page completeness is not guaranteed. The UI says
`No matches in this batch. Continue searching or refine your filters.` with **Continue searching**,
not `No storms found`. Only exhaustion can establish that the query has no matches. If common
queries require repeated empty continuations, revisit indexing or the product requirements;
raising the request limit or silently looping is not an acceptable fix.

### API response and caching

Example request: `/api/storms/search?q=france&from=2026-10-01&to=2026-11-01&level=4`.
Dates are canonical UTC boundaries; the same parser is exercised by fixtures on both sides.

Response fields: `schema_version`, `generation`, `published_at`, `catalog_checked_at`, `last_observation_time`,
canonical `query`, `storms`, `next_cursor`, `exhausted`, and `page_links_available`.
Do not return an invented total match count: finding the exact total would require exhausting
the intersection. Show `20 results on this page`, not `20 storms worldwide`.

`page_links_available` is deployment capability coordinated with #88, not inferred from a
sitemap or detail JSON's existence. When #88 guarantees a route for every published slug, the
Worker can emit true; otherwise hide the secondary links. If #88 adopts per-storm availability,
extend this to an explicit per-result path instead. This must be agreed before #282 ships.

| Condition | Response / UI |
| --- | --- |
| Valid query, matches or exhausted empty intersection | 200; results or meaningful empty state |
| Valid query, bounded scan unfinished | 200; `exhausted: false`, continuation, including when zero results |
| Invalid query/cursor | 400; actionable validation, not an empty catalog |
| Expired/removed generation | 410; `Catalog updated. Restart this search.`; restart only after an explicit action |
| Pointer absent, unsupported version, malformed referenced object, R2 error | 503; catalog unavailable; previous usable results may remain visibly stale |

Cache query responses explicitly with the existing Worker Cache API, keyed by deployment version,
generation, normalized query and cursor. Proposed edge TTL 5 minutes; browser max-age 60 seconds.
Treat pointer freshness separately (at most 60 seconds). Bound any in-isolate memoization; do not
retain all queries or postings. Do not cache 503s. Cursor expiry must also hold on cache hits.
No `stale-while-revalidate`: the Workers Cache API does not support it.
[Official cache documentation](https://developers.cloudflare.com/workers/runtime-apis/cache/)
describes its per-data-center behaviour and supported directives.

## 5. Client states and resource ownership

Extract the large inline UI script into a typed browser controller. Its state contains draft
inputs, submitted query, current generation/page/cursor, cached pages, request revision and status.
Use AbortController plus a monotonically increasing revision: late results never replace newer
queries, even if cancellation arrives too late. Search cancellation must not call `replay.live()`.

| State | Display and behaviour |
| --- | --- |
| Initial loading | `Loading published storms…`; controls remain usable; no fabricated rows |
| New query loading | Remove previous query markers; do not present old rows as new matches |
| Next loading | Preserve current confirmed page until replacement is ready; no mixed generations |
| Empty catalog | `No published storm replays are available yet.` |
| Exhausted query with no matches across its batches | `No published storms match these filters.` plus Clear filters |
| Zero results in unfinished batch | Continue-searching message and cursor action; never a global empty claim |
| Old publication | Keep valid results; `Catalog updated …; recent storms may be missing.` |
| Query failure | Retry button with submitted query; keep previous same-query results, labelled accordingly |
| Replay failure | Existing HUD replay error; Explore reopens to the preserved query/page |
| Closed / globe disposed | Abort search; hide/dispose markers and detach listeners; no background pagination |

Initially reuse the existing 24-hour catalog staleness threshold from `CATALOG_LIMITS`, labelled
as a discovery threshold pending #74's production freshness evidence. For the current generation,
apply it to `catalog_checked_at`; never substitute a fresh pointer timestamp for the age of a
superseded generation. A retained older generation is labelled as an earlier catalog version,
with an explicit refresh action. Cached responses may lag this status by their bounded TTL.
An old storm is not itself a stale catalog. Keep publication, successful check, last observation
and storm start times distinct.

Next replaces the displayed page, rather than infinitely appending results. Previous uses a
bounded cache or replays a saved bounded cursor request. Keep at most five page/cursor history
entries; expose Restart for earlier navigation rather than building unbounded session history.
Reopening may reuse a page younger than 60 seconds; otherwise offer/perform one bounded refresh.
Changing filters clears all old cursor history and map results.

Add a small owned marker layer/controller inside `createGlobeApp`. Expose only a discovery API
such as `setResults`, `setVisible`, `highlight` and a selection callback; keep raw scene/camera
private. Update projection in the existing render loop only while needed. Clean up resources in
`app.dispose()` and handle `GLOBE_GONE`/`GLOBE_READY` remounts. No second WebGL renderer or loop.
The layer must remain disabled in offline render mode.

The existing replay class only emits some state changes after entry completes; do not assume
`onChange` already announces every loading transition. Either use the existing HUD polling
pattern to observe `state.loading`, or add a dedicated tested state notification. Do not change
navigation-origin event semantics just to notify the browser.

## 6. Implementation map and sequence

Proposed filenames are organizational guidance, not existing APIs. Inspect fresh `main` before
starting; #74/#88 may have changed these integration points.

| Files | Work |
| --- | --- |
| `docs/adr/<next>-storm-catalog-search.md` | New ADR for search semantics, index/publication, budgets, cursor and region semantics; link ADRs 0005/0011 without editing historical records. |
| `data/contract/storm-search.schema.json`, `common.schema.json` | Add search records/pages/manifests/response types and the appropriate compatible contract version. |
| Generated `models.py`, `web/src/contract/types.ts`, `docs/data-contract.md` | Regenerate with the contract CLI, never hand-edit generated declarations. |
| `scintille_pipelines/storm_search.py` and matching tests | Normalization, regional mapping, effective records, sorted postings, byte limits, generation and publication. |
| `storm_catalog.py`, `storm_publication.py` and tests | Expose effective accepted snapshot; publish search after usable detail; preserve fallback and retry semantics. |
| `web/src/pages/api/storms/search.ts` | Thin on-demand endpoint; validation, R2 binding, response/cache handling. |
| `web/src/storms/search-query.ts`, `search-store.ts` and tests | Pure query/cursor rules and bounded R2 algorithm, independent of UI. |
| `web/src/components/StormSuggestions.astro` or renamed `StormBrowser.astro`, `Hud.astro` | Browser shell, form, rows and mutually exclusive panels; replace old automatic suggestion requests. |
| `web/src/components/hud/storm-browser.ts` and tests | State, cancellation, pagination, status copy, shared replay activation and focus. |
| `web/src/globe/discovery/*`, `app.ts` and tests | Markers, projection/picking, viewport reservation, lifecycle and render-mode exclusions. |
| `fixtures/storms/search/`, fixture generation/seeding as needed | Contract fixtures in local/Preview R2, consistent with the replay data root used in the same session. |
| `docs/qa/storm-browser.md`, `docs/pipelines.md`, `docs/deploy.md` | Acceptance evidence, bytes/latency, pipeline recovery and local/Preview instructions. |

Recommended order within the implementation PR:

1. Record maintainer approval of this design and any amendments. Recheck dependency status,
   publication provenance and #88 link capability. Create `feat/282-storm-catalog-browser`.
2. Define the ADR, shared schema and normalization/query fixtures. Build the data index and a
   pure Worker query engine first. Prove boundedness and search beyond the old suggestion window.
3. Benchmark selective and broad queries before committing to the UI. If index size, build time,
   latency or repeated empty continuations fail the proposed gate, bring back a concrete amendment.
4. Implement the form/results controller and errors; connect all replay actions to one handler.
5. Implement reserved viewport, markers and touch/keyboard behaviour. Verify existing framing,
   URL history, reload, coverage picking and offline rendering.
6. Seed local/Preview R2 with search fixtures. A browser-only fixture under `/_replay-fixtures/`
   does not automatically populate the Worker's `LIVE` binding. Ensure search slugs resolve in
   `app.replay.baseUrl` for that QA session; do not mix a fixture search with production replay.
7. Run all affected-area commands, mark the draft PR ready, add/retain the `preview` label, and
   collect maintainer Preview acceptance. Do not activate #74's production schedule as part of
   browser UI work; coordinate publication rollout under that ticket's prerequisites.

This is a cross-stack change. The issue's size:L estimate should not be treated as proof it will
fit in two or three days. If the work must be split, agree explicit child issues first, preserving
one ticket/branch/PR per implementation unit and the parent's acceptance criteria.

## 7. Tests and acceptance evidence

### Automated checks that matter

**Data/publication:** deterministic generations; duplicate word/slug handling; date ordering and
ties; UTF-8 byte bounds with long labels; all published old records included; null countries;
missing naming data; unchanged reruns; interrupted publication at each stage; failed pointer
write; no dangling references; skipped/oversized export retaining the old summary; new invalid
export absent from both the existing and search indexes. No search generation may advertise
success with silently omitted records.

**Query:** an old result beyond the first 150 storms; multiple words and combined filters;
normalization parity; ISO day/month and UTC boundary semantics; unknown word; every page-order
tie case; first/last row resumption; date seek across equal timestamps; empty-but-continuable
batch; exhaustive traversal has neither gaps nor duplicates; generation updates between pages;
malformed/expired cursor; missing object versus R2 failure; aggregate requests/bytes bounded under
adversarial metadata and missing/false Content-Length. Assert a limit of 20 returned records and
zero storm-detail reads for searching.

**UI/replay:** delayed response A after query B; close during fetch; Next failure preserving the
confirmed page; keyboard Enter and marker tap dispatching the same slug; full viewport restored
before replay framing; rapid reselection; replay errors; Back/Forward and reload regressions;
opening from live and an existing replay; Escape/focus; repeated globe disposal/remount; no
discovery requests when closed and no request on globe movement.

**Map/layout:** occlusion on the far hemisphere and near horizon, antimeridian, poles, close tilted
camera, overlapping positions, drag-versus-tap, viewport resize and mobile keyboard, 44 px hit
targets, hidden layer does no picking, resources released, `/render/` output unaffected.

Generate small deterministic fixtures for unit tests and larger synthetic benchmark catalogs in
temporary storage. Include at least 10,000 and 100,000 records plus maximum-size object cases;
label all synthetic data. Do not commit a large generated catalog. Real production data remains
necessary for publication/storage/latency claims at launch.

### Required commands for the implementing agent

From the repository root:

```sh
pnpm -C web install
pnpm -C web check
pnpm -C web lint
pnpm -C web build
pnpm -C web test
pnpm -C web test:seo
```

From `data/`:

```sh
uv sync
uv run scintille-contract generate
uv run scintille-contract check --base origin/main
uv run pytest
uv run ruff check
uv run ruff format --check
uv run mypy
```

Regenerate before the web checks. Run the repository's existing deployment dry-run/CI checks as
applicable to the new runtime route. Follow `web/AGENTS.md` for starting the local dev server.

### Manual Preview matrix

Test desktop mouse and keyboard, a real touch browser where available, 320/390 px phone widths,
phone landscape, reduced motion and a slow declared network profile. Record device/browser,
viewport, connection simulation, dataset, commit and generation.

Required captures: closed HUD; desktop search with visible markers; phone search and keyboard;
filtered old result; empty, continuation, stale and error states; map tap to replay with the
panel already closed; reopening while replaying without covering the globe; #88 link when enabled.
Use a short video for drag-versus-tap and replay transitions.

| #282 acceptance criterion | Evidence required in PR |
| --- | --- |
| Search, filters and map on desktop/touch; same replay via keyboard | Contract-backed end-to-end scenarios and Preview recordings; verify selected slug, not just a changed screen. |
| Useful loading/empty/stale/error states, no fabricated storms | Fault-injection screenshots plus tests distinguishing exhausted-empty from incomplete scans. |
| Bounded, measured bytes per interaction | HAR/browser resource records and Worker R2 counters, with the table below filled using observed values. |
| Light, closed by default, no replay obstruction or extra globe controls | Before/after desktop/phone captures and replay-transition video; zero initial discovery requests. |
| Maintainer approves design and Preview | Link this approved proposal/amendment and record explicit Preview acceptance. Automated tests do not substitute for either. |

PR measurement table template; every cell below must be measured during implementation:

| Interaction | Browser requests / transferred bytes / decoded bytes | Worker R2 reads / bytes | Wall latency / Worker CPU | Notes |
| --- | --- | --- | --- | --- |
| Page load, browser closed | TBD (discovery target: 0 / 0 / 0) | TBD | TBD | Exclude baseline globe feeds explicitly |
| First open, cold | TBD | TBD | TBD | Newest 20; declared catalog size |
| Old place + UTC date query, cold | TBD | TBD | TBD | Beyond original suggestion window |
| Region + level + period | TBD | TBD | TBD | Broad and sparse cases |
| Next / empty-batch Continue | TBD | TBD | TBD | Prove cursor progress |
| Warm repeat / Previous | TBD | TBD | TBD | Identify browser, edge and isolate cache hits |
| Stale data / failed query / Retry | TBD | TBD | TBD | No retry loop |
| Marker hover, orbit, close | TBD (additional search target: 0) | TBD | TBD | Include cancelled request bytes separately |
| Replay activation | TBD | TBD | TBD | Report metadata, chunks and historical clouds separately from search |

Record compressed transfer and decoded bytes separately; DevTools/HAR plus explicit response/R2
body counters are preferable to assuming `Content-Length` equals actual network transfer. Counts
for cancelled requests still count toward the interaction that started them. Repeated user
actions have repeated bounded costs; cancellation does not erase an already executed R2 read.

## 8. Rollout, risks and handoff boundaries

- Publish a verified first search generation before making the browser the production discovery
  entry. If the search pointer is missing, expose an unavailable/retry state rather than disguising
  four recent suggestions as full search. Rollback can restore the old UI and keep the old indexes.
- #74 must establish that production publication is running and covers its advertised set. An
  empty generation proves no published entries in that generation, not an absence of lightning.
- #88 governs storm-page availability. The absence of a public HTML page does not prevent a valid
  published replay; secondary links remain conditional.
- The first version intentionally indexes complete words. Prefix/fuzzy requests are a product
  decision, not a free future implementation detail.
- Duplicated postings can become expensive to rebuild and retain. Publication size/time evidence
  is a release concern alongside query latency. Do not label an unmeasured index compact.
- Preserving every generation without deletion is a conservative rollout choice, not a long-term
  storage policy. Bring the measurements into the existing retention work before prolonged growth.
- No changes to storm detection, level thresholds, extraction membership, cloud retention,
  continuous tracking, globe lighting or SEO page content are included.
- Keep existing historical ADRs unchanged and use the next available ADR number at implementation
  time, per [`docs/adr/README.md`](../adr/README.md).

The implementing agent should begin by reading this proposal and the maintainer's response,
`AGENTS.md`, `web/AGENTS.md`, the fresh issue bodies and the listed integration files. Carry any
approved amendments into the new ADR and PR. The implementation PR starts with `Closes #282`,
maps each acceptance criterion to actual evidence, and reports unresolved dependencies explicitly.

**Preparation delivered here:** repository/issue analysis, proposed design, architecture,
budgets, implementation map and validation plan. No application code, production data, deployed
configuration, GitHub issue or PR was changed by this preparation; no performance results or
Preview approval are claimed.
