# AGENTS.md

Instructions for coding agents (Codex, Claude Code and others) working on this repository.
Read this file before starting any ticket.

## Project

Scintille is a cinematic 3D globe of lightning across the planet in near real time, built on open
satellite data (NOAA GOES GLM, EUMETSAT MTG Lightning Imager). Two goals with equal weight: a
beautiful, contemplative experience, and data that is reliable and honest (flash brightness reflects
measured optical energy, coverage gaps are shown, sources are attributed).

Work is planned in GitHub Issues, grouped into epics, with "blocked by" relations between tickets.
Decisions are recorded as ADRs in `docs/adr/`.

## Stack

| Area | Tools |
|---|---|
| Site and globe | Astro (static pages for SEO), raw Three.js with custom shaders, TypeScript strict |
| Data | Python 3.13, uv workspace, Polars/Arrow, DuckDB, Apache Iceberg on Cloudflare R2, Dagster, dbt |
| Hosting | Cloudflare (site, R2 storage), OVH VPS (ingestion and pipelines in Docker), Terraform for Cloudflare |

## Repository layout

| Path | Content |
|---|---|
| `web/` | Astro site; the globe will live in `web/src/globe/` |
| `data/packages/scintille-contract/` | Shared data contract (flash schema, live feed format) |
| `data/packages/scintille-ingest/` | Hot path service: satellite ingestion, live feed publishing |
| `data/packages/scintille-lake/` | Iceberg tables as code, catalog connections ([lakehouse](docs/lakehouse.md)) |
| `data/packages/scintille-pipelines/` | Batch pipelines orchestrated by Dagster |
| `data/dbt/` | dbt models for the gold layer |
| `docs/` | Documentation; `docs/adr/` holds architecture decision records |

## Commands

Web (Node ≥ 22.12, pnpm 12), run from the repository root:

```sh
pnpm -C web install
pnpm -C web check    # type check (astro check)
pnpm -C web lint     # ESLint
pnpm -C web build    # production build
pnpm -C web test     # unit tests (Vitest)
pnpm -C web dev      # dev server
```

Data (uv installs Python 3.13 itself), run from `data/`:

```sh
uv sync
uv run pytest
uv run ruff check
uv run ruff format --check
uv run mypy          # paths are configured in data/pyproject.toml
```

Before opening a PR, every command of the area you touched must pass.

## Workflow

- **One ticket = one branch = one PR.** Never push to `main`.
- Branch name: `<type>/<issue-number>-<short-slug>`, e.g. `feat/46-sun-position`.
- Commit messages are one simple, clear line following [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`). No body.
- The PR description starts with `Closes #<issue>` and lists how each acceptance criterion was verified. Visual changes include screenshots or a short video.
- **Stay in scope.** Do only what the ticket describes. If you find something else worth doing, mention it in the PR description instead of doing it.
- If the ticket is ambiguous or an acceptance criterion cannot be met, say so in the PR (or stop and ask) rather than guessing silently.
- A choice that affects other tickets (a format, a library, an architecture pattern) needs an ADR in `docs/adr/`, following `docs/adr/README.md`.

## Conventions

- English everywhere: code, comments, docs, UI text, commit messages, PRs.
- Code should speak for itself. Comments are rare and short: what a function is for, or a one-line hint when something is not obvious. No blocks of context; less is better than too much.
- TypeScript: strict mode, no `any` without a comment explaining why.
- Python: typed (mypy strict), formatted and linted by ruff, tests with pytest. Prefer vectorized Polars/Arrow over row-by-row loops for data.
- Tests come with the code they test. Pure logic (sun position, parsing, normalization) is unit-tested.
- Never commit secrets, `.env` files, or large data files (`*.nc`, `*.parquet`); small test fixtures go under a `fixtures/` folder.

## Parallel work

Several agents work on the repository at the same time, each on its own branch.

- Touch only the files your ticket needs.
- Lockfiles (`web/pnpm-lock.yaml`, `data/uv.lock`): never resolve conflicts by hand. Rebase on `main`, take `main`'s lockfile, then re-run `pnpm -C web install` or `uv lock` to add your changes back.
- Rebase on `main` before asking for a review if `main` has moved.
