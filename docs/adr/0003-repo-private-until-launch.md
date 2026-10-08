# 0003 · Repository private until launch

- Status: accepted
- Date: 2026-10-08

## Context
The repository will be public eventually: it is a portfolio project and its engineering is part of
what it shows. Before launch, the code, tickets and visuals are unfinished.

## Options
- **Public from day one**: unlimited free GitHub Actions minutes, branch protection rules available,
  the work is visible as it happens.
- **Private until launch**: the project is revealed when it is presentable; GitHub Actions is limited
  to the free monthly quota, and rulesets / branch protection are not available on a free plan.

## Decision
Keep the repository private until the public launch, then make it public.

## Consequences
- CI must stay lean (path filters, cancelled superseded runs) to fit the monthly Actions quota.
- No enforced branch protection before launch: the "one PR per ticket, never push to `main`" rule
  relies on discipline and on agent instructions.
- Before going public: scan the full git history for secrets, review tickets and docs, then enable
  branch protection.
