# 0001 · GitHub Issues and Projects for planning

- Status: accepted
- Date: 2026-10-08

## Context
The project is built by one maintainer working with several coding agents in parallel (Claude Code,
Codex). Tickets must be readable and writable by those agents, show dependencies between tasks, and
give a review checkpoint for every change. The board is also part of the portfolio: it shows how
the work is organized.

## Options
- **GitHub Issues + Projects**: free, native to the repository, `gh` CLI for agents, sub-issues and
  "blocked by" relations, each ticket maps to a branch and a PR.
- **Linear**: pleasant UI and agent integrations, but the free plan caps the number of issues, which
  this project would reach.
- **Tickets as Markdown files in the repo** (Backlog.md, Taskmaster): convenient for one local agent,
  but parallel agents editing ticket files create git conflicts, and nothing can be triggered from
  the web.

## Decision
GitHub Issues grouped into epics (sub-issues), with "blocked by" relations and one GitHub Project
board. One ticket = one branch = one PR, reviewed and merged by the maintainer.

## Consequences
- Agents read and update tickets with `gh`; no planning file to keep in sync.
- Dependencies are explicit, so tickets that can run in parallel are easy to find.
- The maintainer's review capacity is the bottleneck: PRs must stay small enough to review in one go.
