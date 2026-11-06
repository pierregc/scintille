# 0036 · Keep ADR statuses current

- Status: accepted
- Date: 2026-11-06
- Supersedes [0017](0017-preserve-adr-history.md)

## Context

[ADR 0017](0017-preserve-adr-history.md) kept every record unchanged, statuses included. Fourteen
records stayed `proposed` after their decisions shipped, so the index no longer said which decisions
are in force.

## Options

- Keep statuses frozen and track decisions elsewhere: the records stop answering the question they
  exist for.
- Update the status line only: the text stays as written, the status follows the decision.

## Decision

The status line changes when a decision is accepted, superseded or replaced in part; the rest of a
record stays as written. A later decision is still a new record that links its predecessor. The two
records numbered 0013 keep their file names.

## Consequences

The [index](README.md) gives every record with its current status.
