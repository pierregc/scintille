# 0020 · Bounded storm catalog search

- Status: accepted (implementation requested by the maintainer on 2026-10-18; Preview acceptance pending)
- Date: 2026-10-18

## Context

[#282](https://github.com/pierregc/scintille/issues/282) needs discovery beyond the four
recent suggestions. The maintainer requested implementation of [the #283 proposal](../proposals/282-storm-catalog-browser.md).
The whole catalog must remain searchable without an unbounded client or Worker scan.
[ADR 0011](0011-storm-publication-contract.md) defines publication and replay provenance;
[ADR 0005](0005-hosting-and-dynamic-pages.md) still requires measured hosting capacity.
Their historical statuses are unchanged by this decision.

## Options

A client download or scanning all index pages grows with the archive. A separate search service
adds infrastructure. We choose versioned R2 posting lists and an Astro Worker endpoint over `LIVE`.

## Decision

Index the effective published summaries, after rejected and oversized exports resolve their
previous-summary fallback. Join stable naming coordinates and geography. An unresolved location
or oversized record fails the new search publication and leaves the previous pointer unchanged.
Publication under #74 determines which storms qualify; search does not change that policy.

Use contract 2.5.0 and deterministic SHA-256 generations/selectors. Each posting contains at most
64 records and 64 KiB including its envelope; each record is at most 8 KiB. Publish postings before
the immutable manifest and mutable pointer. Identical input reuses the generation; only a successful
check refreshes `catalog_checked_at`. The serialized Dagster `storm-tracks` pool owns publication.
Reject older check timestamps. Retain generations during rollout; no deletion policy is introduced.

Queries match up to four complete normalized words with AND semantics. NFKD, per-codepoint
lowercasing, removal of combining marks and non-letter/number separators are shared by golden
fixtures. There is no transliteration, prefix or fuzzy search. Region mapping v1 describes the
named country, with explicit offshore/unassigned fallback; it does not describe storm extent.
ISO UTC day/month search and start-date intervals use `[from, to)` boundaries.

Select the smallest posting. Seek dates with at most 24 probes, then scan at most four pages /
256 candidates, returning at most 20 records. A cursor carries the exact next unread row, query
hash, generation, selector and 24-hour expiry. It advances even for an empty incomplete batch.
Validate cursor/query before R2 access. First requests use at most 36 reads / 2 MiB; continuations
at most 12 reads / 276 KiB. Enforce individual and aggregate body limits, including missing lengths.

The browser makes one request per explicit search, pagination or refresh, with a 15-second timeout
and 64 KiB decoded response limit. No retries or automatic continuation; retain five pages.
Responses are cached in the Worker Cache API for five minutes, keyed by deployment, current/check
metadata, immutable generation, canonical query and cursor. Pointer/manifest reads remain fresh on
each request; cursor validation precedes cache hits. Browser cache lifetime is at most 60 seconds.
No isolate memoization and no cache for errors. `Server-Timing` reports R2 reads/bytes and candidates.

The panel reserves 360 px on desktop or 45dvh on phones; canvas observation updates renderer,
postprocessing, aspect and controls. A synchronous replay-entry notification closes it before
framing, without changing navigation event semantics. Up to 20 numbered markers are projected
in the existing loop, occluded by the sphere, with grouped overlap targets and a keyboard list.
Offline rendering creates no discovery layer. Disposal releases listeners and DOM markers.
Public storm-page links remain disabled until #88 guarantees those routes.

## Consequences

R2 duplication trades publication storage for bounded queries. The synthetic 100,000-storm index
writes about 295 MB per changed generation; hourly rebuild/retention costs need production review.
Sparse intersections can require explicit continuation. Local disk benchmarks establish algorithm
bounds, not edge latency, Worker CPU, mobile performance or a hosting-plan decision.

Preview captures and maintainer acceptance remain release gates. See [QA evidence](../qa/storm-browser.md).
Production publication readiness stays with #74; public storm-page availability stays with #88.
