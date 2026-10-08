# Scintille

A cinematic 3D globe of lightning across the planet in near real time, built on open satellite data
(NOAA GOES GLM, EUMETSAT MTG Lightning Imager). The day/night terminator and city lights are computed
live, flash brightness reflects the measured optical energy, and past storms are detected
automatically so they can be replayed. Live at [scintille.app](https://scintille.app).

## Repository layout

| Path | What lives there |
|---|---|
| `web/` | Astro site and the Three.js globe |
| `data/` | Python `uv` workspace: data contract, ingestion service, Dagster pipelines, dbt models |
| `docs/` | Documentation and architecture decision records (`docs/adr/`) |

## Running locally

Web (Node ≥ 22.12, pnpm):

```sh
pnpm -C web install
pnpm -C web dev      # dev server
pnpm -C web check    # type check
pnpm -C web build    # production build
```

Data (uv, Python 3.13 is installed automatically by uv):

```sh
cd data
uv sync
uv run pytest
uv run ruff check && uv run ruff format --check
uv run mypy
```
