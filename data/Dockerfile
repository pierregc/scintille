# One image per service: docker build -f data/Dockerfile --build-arg PACKAGE=scintille-pipelines data
ARG PYTHON=mirror.gcr.io/library/python:3.13-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f

FROM ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21 AS uv

FROM ${PYTHON} AS build
ARG PACKAGE
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /src
COPY pyproject.toml uv.lock ./
COPY packages packages
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --package "${PACKAGE}"

FROM ${PYTHON}
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin app
COPY --from=build /app/.venv /app/.venv
COPY packages/scintille-pipelines/dagster_home/dagster.yaml /app/dagster_home/dagster.yaml
ENV PATH=/app/.venv/bin:$PATH DAGSTER_HOME=/app/dagster_home PYTHONUNBUFFERED=1
RUN chown app /app/dagster_home
WORKDIR /app
USER app
