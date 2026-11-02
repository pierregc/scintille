# Architecture Decision Records

One file per significant decision, numbered in order: `NNNN-short-title.md` (e.g. `0001-github-issues-for-planning.md`).
Existing records, including proposals, are retained unchanged. A later decision is recorded in a
new ADR linking its predecessor; full filenames disambiguate historical duplicate identifiers.

## Template

```markdown
# NNNN · Title

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD

## Context
What forces the decision: constraints, requirements, what we know.

## Options
The alternatives considered, with their trade-offs.

## Decision
What we chose, in one or two sentences.

## Consequences
What becomes easier, what becomes harder, what we must watch.
```

## M3 decision review

| Record | Current status | Remaining decision/evidence |
| --- | --- | --- |
| [0011 · Storm publication](0011-storm-publication-contract.md) | Proposed | Maintainer accepts track-bounds replay provenance or records an amendment; production evidence in #74 |
| [0015 · Production replay entry](0015-production-replay-entry.md) | Proposed | Entry API, initial framing and browser support limits; #79/#83 review |
| [0016 · Share URLs](0016-replay-share-urls.md) | Proposed | Bounded URL contract and supported camera subset; #82/#261 runtime review |
| [0013 · Replay feed lifecycle](0013-replay-feed-lifecycle.md) | Proposed | Shared scene-owner decision plus GPU/audio/resource evidence in #261 |
| [0013 · 3D lightning ribbons](0013-bis-3d-lightning-ribbons.md) | Superseded by [0033](0033-lightning-looks-and-density.md) | Separate lightning decision; filename carries `-bis`; the CPU skeletons and the flash kinds are recorded in 0033 |
| [0017 · Preserve ADR history](0017-preserve-adr-history.md) | Proposed | Records the history policy and duplicate-identifier resolution |
| [0018 · Interrupted replay framing](0018-interrupted-replay-framing.md) | Proposed | Reload behaviour of an interrupted flight; #272 |
| [0019 · Reload storm framing](0019-reload-storm-framing.md) | Proposed | Storm framing on reload, explicit views for sharing; #272 |

Both historical 0013 records retain their original paths, headings and text. Cite the full filename
when referring to either proposal. [0017](0017-preserve-adr-history.md) documents this resolution;
it does not renumber or accept either architectural record. Historical issue/PR references to the
replay ADR still refer to `0013-replay-feed-lifecycle.md`.
