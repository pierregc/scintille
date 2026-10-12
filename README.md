# Scintille

A cinematic 3D globe of lightning across the planet in near real time, built on open satellite data
(NOAA GOES GLM, EUMETSAT MTG Lightning Imager). The day/night terminator and city lights are computed
live, flash brightness reflects the measured optical energy, and past storms are detected
automatically so they can be replayed. Live at [scintille.app](https://scintille.app).

## Repository layout

| Path | What lives there |
|---|---|
| `web/` | Astro site and the Three.js globe |
| `data/` | Python `uv` workspace: data contract, ingestion service, Dagster pipelines and gold SQL models |
| `docs/` | Documentation and architecture decision records (`docs/adr/`) |

## Running locally

Web (Node ≥ 22.12, pnpm):

```sh
pnpm -C web install
pnpm -C web dev      # dev server
pnpm -C web check    # type check
pnpm -C web lint     # lint
pnpm -C web build    # production build
pnpm -C web test     # unit tests (Vitest)
```

Data (uv, Python 3.13 is installed automatically by uv):

```sh
cd data
uv sync
uv run pytest
uv run ruff check && uv run ruff format --check
uv run mypy
```

## Data & attribution

The code is released under the [MIT License](LICENSE). The data it reads and publishes is not: each
source keeps its own terms, and anyone redistributing it must keep the credits below.

| Data | Source | Terms |
|---|---|---|
| Lightning, Americas | [NOAA GOES GLM](https://registry.opendata.aws/noaa-goes/) L2 LCFA | NOAA open data. Credit: "GLM data courtesy of NOAA" |
| Lightning, Europe and Africa | [EUMETSAT MTG Lightning Imager](https://www.eumetsat.int/meteosat-third-generation) L2 LFL | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) under the EUMETSAT Data Policy. Credit: "Contains modified EUMETSAT Meteosat data 2026" |
| Clouds | [NOAA NESDIS GMGSI](https://registry.opendata.aws/noaa-gmgsi/) | NOAA open data. Credit: "Clouds: NOAA NESDIS GMGSI (contains EUMETSAT Meteosat and JMA Himawari data)" |
| Earth imagery | NASA Blue Marble and Black Marble | Public domain. Credit: NASA Earth Observatory |
| Coastlines, countries, marine areas | [Natural Earth](https://www.naturalearthdata.com/) | Public domain |
| Place names | [GeoNames](https://www.geonames.org/) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit GeoNames wherever names are shown |

Details per file: [assets](docs/assets.md#sources-and-licenses), [reference data](docs/pipelines.md#reference-data)
and [data contract](docs/data-contract.md).
