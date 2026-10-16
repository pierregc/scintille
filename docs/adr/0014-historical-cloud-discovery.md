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

The replay client reads the playhead day and adjacent days, selects at most three nearby frames
of its quality tier, and refreshes discovery at most once per wall-clock minute or playhead-hour
change. Discovery responses are capped at 128 KiB; compressed textures at 16 MiB. One sequence of
requests/decodes runs at a time; newer seeks coalesce and cancel stale work. GPU texture ownership
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
