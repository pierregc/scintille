"""Dagster's own storage on the local Postgres, configured as in production (#271)."""

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from dagster import DagsterEventType, DagsterInstance, DagsterRunStatus, asset, materialize
from scintille_pipelines.resources import LOCAL_POSTGRES

pytestmark = pytest.mark.lake

DAGSTER_HOME = Path(__file__).parents[1] / "dagster_home"


@asset
def probe() -> int:
    return 1


@pytest.fixture
def fresh_database(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    name = f"dagster_{uuid4().hex[:12]}"
    with psycopg.connect(LOCAL_POSTGRES, autocommit=True) as conn:
        conn.execute(f"CREATE DATABASE {name}")
    url = f"postgresql+psycopg2://postgres:postgres@localhost:55432/{name}"
    monkeypatch.setenv("DAGSTER_POSTGRES_URL", url)
    yield
    with psycopg.connect(LOCAL_POSTGRES, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE {name} WITH (FORCE)")


@pytest.mark.usefixtures("fresh_database")
def test_runs_succeed_on_fresh_then_existing_storage() -> None:
    for _ in range(2):
        with DagsterInstance.from_config(str(DAGSTER_HOME)) as instance:
            run_id = materialize([probe], instance=instance).run_id
            planned = instance.get_records_for_run(
                run_id, of_type=DagsterEventType.ASSET_MATERIALIZATION_PLANNED
            ).records
            run = instance.get_run_by_id(run_id)
            assert planned
            assert run is not None and run.status == DagsterRunStatus.SUCCESS
