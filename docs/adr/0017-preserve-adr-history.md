# 0017 · Preserve ADR history and disambiguate duplicate identifiers

- Status: proposed
- Date: 2026-10-17

## Context

Two existing proposals carry identifier 0013: [replay feed lifecycle](0013-replay-feed-lifecycle.md)
and [3D lightning ribbons](0013-bis-3d-lightning-ribbons.md). The maintainer requires existing records,
including proposals, to remain unchanged. Only the lightning ribbons file is renamed, with a `-bis` suffix; its content is unchanged.
The cloud-discovery gap described in [0011](0011-storm-publication-contract.md) also predates the
implementation documented by [0014](0014-historical-cloud-discovery.md).

## Options

- Renumber or rewrite the original proposals: unique numbers, but changes the historical records.
- Keep both records, suffixing one filename with `-bis`: preserves content and resolves references
  without implying that either architectural proposal has been accepted.

## Decision

Retain existing ADR headings, dates, statuses and content. Disambiguate the two 0013 records
by filename (`0013-bis-` for lightning ribbons) in the index and in new references. Record a later decision in a new numbered ADR
that links its predecessor; explain implementation progress in QA documentation instead of rewriting
an older record. Allocate future numbers from the highest existing identifier.

## Consequences

- Historical references to replay ADR 0013 resolve to `0013-replay-feed-lifecycle.md`; lightning
  references resolve to `0013-bis-3d-lightning-ribbons.md`. Both remain proposals.
- This record proposes the documentation policy only. It does not accept the publication,
  replay-lifecycle, framing or URL contracts on the maintainer's behalf.
- The M3 QA packet records current cloud discovery and later verification independently of ADR 0011.
