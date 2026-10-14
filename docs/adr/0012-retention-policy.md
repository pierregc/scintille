# 0012 · Retention policy for flashes, raw products, and cloud frames

- Status: proposed
- Date: 2026-10-12

## Context

Issue #41 requires a retention decision confirmed by measured volumes. ADR 0006 already accepts
3-day snapshots and a 30-day raw cache. #27 implements these defaults with at least 5 snapshots,
but PR #167 leaves production enablement/verification to the maintainer; completion is not proven here.

The 65 to 100 GB/year silver estimate combines assumed flash rates with synthetic Parquet rows.
It is not a production measurement. ADR 0007's cloud estimate covers 2048-pixel frames; ingestion
now stores both 2k/4k and live/archive copies. No production report is supplied by this proposal.
See [the measurement runbook](../retention.md); review prices using current official pricing.

## Options

- Permanent silver: preserves replay, recalibration, and historical analysis; storage grows with
  coverage/time and overlapping observations. Age limits bound storage but require deletion logic
  and make older replay depend on upstream archives and historical parser/calibration inputs.
- Permanent full cloud archive: preserves global cloud replay; growth needs both tiers/copies measured.
- Full cloud frames for 30 days, then storm-related frames: follows #41, but needs selection criteria
  and protected storage. Only 30 days matches today's lifecycle and loses older cloud context.

## Decision

Proposed: keep silver indefinitely, snapshots for 3 days with at least 5, and raw products for 30 days.
Keep all cloud frames for 30 days; longer storm-related retention awaits maintainer selection criteria
and tier choices. This does not change accepted policy or authorize production changes. Orphans remain
inventory-only with a minimum age of 7 days, as implemented in #27.

## Consequences

Snapshot expiration removes rollback history, not current silver rows. Measure current data,
unique retained-file references, metadata, and billed storage separately; shared files count once.

Storm frames surviving 30 days need storage outside `archive/clouds/` or a revised lifecycle rule.
Time padding, geographic/source association, tiers, late/rebuilt detections, and historical replay
promises remain undecided. This proposal implements no selection.

Acceptance needs representative complete days per source, compaction evidence, complete inventories,
verified production expiry settings, cost review, and maintainer agreement. #41 stays open until the
ADR is accepted and its values applied; merging preparation alone satisfies neither requirement.
