# 0012 · Retention policy for flashes, raw products, and cloud frames

- Status: proposed
- Date: 2026-10-12

## Context

Issue #41 asks for a retention decision confirmed by measured volumes. ADR 0006 already accepts
3-day Iceberg snapshot expiration and a 30-day raw cache. #27 implements these defaults, with at
least 5 snapshots retained, but its merged PR #167 leaves production enablement and verification
to the maintainer. This proposal does not assert those steps were completed.

The 65 to 100 GB/year silver estimate in ADR 0006 combines assumed flash rates with 45 to 70
bytes per synthetic Parquet row. It is not a production measurement. ADR 0007's cloud archive
estimate concerns 2048-pixel frames; ingestion now stores both 2k and 4k copies in the live and
archive prefixes. Raw product sizes and MTG LI contribution need separate measurements.

No production retention report has been collected for this proposal. The collection method and
required evidence are in [the retention runbook](../retention.md). Prices and yearly cost figures
must be checked against current provider pricing when that evidence is reviewed.

## Options

- Keep silver flashes indefinitely: preserves replay, recalibration inputs, and historical storm
  analysis; storage grows with coverage and time, including overlapping observations.
- Expire silver by age: bounds storage but makes older replay depend on upstream archives and
  availability of the historical parser/calibration inputs. It needs a new deletion mechanism.
- Keep every cloud frame indefinitely: preserves global cloud replay, with predictable growth
  once both tiers and duplicate live/archive storage are measured.
- Keep all cloud frames for 30 days, then only frames around detected storms: follows #41's
  recommendation, but requires a definition of the selection window and a protected archive.
- Keep cloud frames only 30 days: matches today's declared lifecycle; older storms lose cloud
  context even when their flashes remain available.

## Decision

Proposed, awaiting measured evidence and maintainer acceptance: keep silver flashes indefinitely,
retain Iceberg snapshots for 3 days with at least 5 snapshots, and cache raw products for 30 days.
Keep all cloud frames for 30 days; longer storm-related cloud retention remains unresolved until
the maintainer chooses the selection criteria and retained tiers.

This proposal does not change the accepted policy or authorize production changes. Orphan files
remain inventory-only, with a minimum age of 7 days, as implemented in #27.

## Consequences

Snapshot expiration removes rollback history, not current silver rows. Permanent silver retention
therefore does not require permanent snapshots. Current data bytes, files referenced by retained
manifests, and total object-storage bytes must be measured separately; retained files are counted
once even when multiple snapshots reference them.

Keeping selected cloud frames past 30 days requires copying them to a prefix outside the current
`archive/clouds/` lifecycle or revising that rule. The time padding, geographic/source relationship,
2k/4k choice, treatment of late or rebuilt storm detections, and historical replay promise must be
settled before implementing selection. Storm selection is not implemented by this proposal.

Production acceptance requires representative complete days per source, compaction evidence,
complete object inventories, confirmation of actual lifecycle/snapshot settings, and a cost review.
Until then #41 remains open. Accepting this ADR and applying its values are separate steps.
