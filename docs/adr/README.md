# Architecture Decision Records

One file per significant decision, numbered in order: `NNNN-short-title.md` (e.g. `0001-github-issues-for-planning.md`).
A record is never rewritten once accepted; a later decision supersedes it with a new record.

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
| [0017 · Replay feed lifecycle](0017-replay-feed-lifecycle.md) | Proposed | Shared scene-owner decision plus GPU/audio/resource evidence in #261 |

Replay feed lifecycle was originally numbered 0013, duplicating
[0013 · 3D lightning ribbons](0013-3d-lightning-ribbons.md). Its proposed record is now 0017;
0013 remains the lightning record. Existing historical PR/issue references to the replay ADR refer
to 0017. Renumbering and this table do not accept any proposal on the maintainer's behalf.
