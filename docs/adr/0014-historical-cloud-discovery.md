# 0014 · Daily cloud archive discovery

- Status: proposed
- Date: 2026-10-16

## Context

Replay needs cloud frames outside the six-hour live manifest (#260). Existing archive copies have
immutable paths and a 30-day lifecycle. Browsers must not list the bucket, keep an entire historical
catalog in memory, or show present-day clouds during historical playback. No longer retention policy
or cloud-source upgrade is decided here.

## Options

- One ever-growing global index: simple initially, but unbounded transfer and invalidation.
- List the bucket from the client: exposes the storage layout and requires listing access.
- Known daily manifests: bounded discovery near the playhead, independent of storm publication.

## Decision

Propose `archive/clouds/manifests/YYYY-MM-DD.json`, one UTC observation day, with schema version 1,
attribution, generation time and at most 96 frames. Each frame uses the existing cloud reference
fields plus `expires_at`; texture paths resolve relative to that manifest. Publication writes every
archive texture before referencing it. Revised observations replace the same time in that day's
index; a restart reads the prior index. Archive failures leave live publishing operational and the
last successful index intact.

A malformed version-1 index is rebuilt from the next successfully published frame, with a warning;
previous entries cannot be reconstructed from corrupt bytes. An unsupported version is preserved,
not overwritten by this publisher. GMGSI supplies hourly observations (24 per UTC day), as confirmed
by the [NOAA product description](https://www.ospo.noaa.gov/products/imagery/gmgsi/).
If a different cadence exceeds the capacity, explicitly keep the newest bounded set and log the
dropped coverage instead of freezing the index. This is not silent support for a new cloud source.

Wire limits, supported tiers and texture path syntax live in the contract package's
`cloud_archive_rules.json`, consumed by both Python and TypeScript. Shared accepted/rejected
fixtures test the two validators. The readers validate their own runtime data structures; no
generic schema-validation library or flash-contract generator change is introduced here.

The replay client reads the playhead day and adjacent days, selects at most three nearby frames
of its quality tier, and caches each daily index, including failed lookups, for 60 seconds of wall
time. Selection follows the actual playhead, including sub-hourly seeks, independently of metadata
refresh. Discovery responses are capped at 128 KiB; compressed textures at 16 MiB in live and replay.
One metadata sequence and one texture load may run concurrently. Only obsolete work is cancelled:
refreshing metadata never interrupts a still-selected image on a slow connection. GPU texture ownership
stays with the cloud layer, which releases frames outside the selected window and on mode changes.

## Consequences

`expires_at` is archive publication time plus 30 days, conservatively before lifecycle grace. The
daily index shares the existing archive lifecycle and may outlive its earliest texture references
within that day. Expired references are ignored; missing/failed textures yield no historical cloud
picture. The existing maximum observation gap (3 hours) and source attribution remain visible.
Interpolation is visual blending, not a new observation.

This starts discovery for newly published frames; existing unindexed objects are not inferred or
silently backfilled. Older replay remains usable without clouds. Longer storm-cloud preservation
needs a protected storage policy and a later change; no deletion/lifecycle configuration changes.

The Preview-only Orlando fixture uses the real July cloud image with synthetic future publication
and expiry dates to keep QA reproducible. Those dates are not production evidence, and the fixture
is omitted from production builds. The normal archive feed always uses SceneClock wall time for
expiry and scene time for observation selection. Offline `/render` retains its frozen live source;
extending offline archive rendering is separate work.
