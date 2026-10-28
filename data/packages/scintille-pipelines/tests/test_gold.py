import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from io import BytesIO
from pathlib import Path

import duckdb
import obstore
import pyarrow as pa
import pytest
from dagster import AssetKey, materialize
from obstore.store import MemoryStore, ObjectStore
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_ingest.backfill import EXPECTED_FILES_PER_DAY
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES, INGEST_LOG
from scintille_pipelines.definitions import defs
from scintille_pipelines.gold import assets, models
from scintille_pipelines.gold.assets import GOLD, daily_stats_feed, feed_key
from scintille_pipelines.gold.checks import (
    accepted_ranges,
    failures,
    not_null,
    relationship,
    unique,
)
from scintille_pipelines.gold.models import (
    FLASH_STATS_HOURLY,
    MODELS,
    REGION_DAILY,
    SOURCE_SLA_DAILY,
)
from scintille_pipelines.resources import FeedResource, LakeResource, R2Resource

COUNTRIES = Path(__file__).parent / "fixtures" / "countries.geojson"
DAY = datetime(2026, 7, 15, tzinfo=UTC)


class SqliteLake(LakeResource):
    """SQLite catalog; DuckDB gets a copy of every table under `lake`."""

    path: str

    def catalog(self) -> Catalog:
        return SqlCatalog(
            "test", uri=f"sqlite:///{self.path}/catalog.db", warehouse=f"file://{self.path}"
        )

    @contextmanager
    def duckdb(self) -> Iterator[duckdb.DuckDBPyConnection]:
        con = duckdb.connect()
        con.execute("ATTACH ':memory:' AS lake")
        catalog = self.catalog()
        for (namespace,) in catalog.list_namespaces():
            con.execute(f"CREATE SCHEMA lake.{namespace}")
            for identifier in catalog.list_tables(namespace):
                rows = catalog.load_table(identifier).scan().to_arrow()
                con.register("copy", rows)
                con.execute(f"CREATE TABLE lake.{namespace}.{identifier[-1]} AS FROM copy")
                con.unregister("copy")
        try:
            yield con
        finally:
            con.close()


BUCKET: list[ObjectStore] = []


class MemoryR2(R2Resource):
    """The in-memory lake bucket, fresh for each test."""

    def store(self) -> ObjectStore:
        return BUCKET[0]


class MemoryFeed(FeedResource):
    """The in-memory public feed bucket, fresh for each test."""

    def store(self) -> ObjectStore:
        return BUCKET[1]


@pytest.fixture
def r2() -> MemoryFeed:
    BUCKET[:] = [MemoryStore(), MemoryStore()]
    return MemoryFeed()


def flash(source: str, when: datetime, lat: float, lon: float, i: int) -> dict[str, object]:
    return {
        "flash_id": f"{i:032x}",
        "source": source,
        "product_file": "test.nc",
        "native_flash_id": i,
        "event_time": when,
        "ingest_time": when,
        "lat": lat,
        "lon": lon,
        "energy_raw": 2.0,
        "energy_unit": "J",
        "intensity": 0.5,
        "area_km2": 100.0,
        "duration_ms": 200.0,
        "quality": [],
        "parser_version": "test",
        "calibration_version": "test",
    }


def add_flashes(catalog: Catalog, rows: list[tuple[str, datetime, float, float]]) -> None:
    table = catalog.load_table(FLASHES.identifier)
    data = [flash(s, t, lat, lon, i) for i, (s, t, lat, lon) in enumerate(rows)]
    table.append(pa.Table.from_pylist(data, schema=table.schema().as_arrow()))


def add_log(catalog: Catalog, rows: list[tuple[str, datetime, float, str]]) -> None:
    """(source, product_start, delivery latency in seconds, status) per file."""
    table = catalog.load_table(INGEST_LOG.identifier)
    data = [
        {
            "key": f"{source}/{start:%H%M%S}/{i}.nc",
            "source": source,
            "satellite": "test",
            "product_start": start,
            "product_end": start + timedelta(seconds=20),
            "received_at": start + timedelta(seconds=20 + latency),
            "row_count": 1,
            "checksum": "x",
            "status": status,
            "parse_duration_ms": 1.0,
            "error": None,
        }
        for i, (source, start, latency, status) in enumerate(rows)
    ]
    table.append(pa.Table.from_pylist(data, schema=table.schema().as_arrow()))


FLASH_ROWS = [
    ("glm-east", DAY + timedelta(hours=18, minutes=10), 48.85, 2.35),
    ("glm-east", DAY + timedelta(hours=18, minutes=11), 48.86, 2.34),
    ("glm-east", DAY + timedelta(hours=19), -10.5, -50.5),
    ("glm-west", DAY + timedelta(hours=18, minutes=30), 0.5, -140.2),
    ("mtg-li", DAY + timedelta(hours=18, minutes=5), 45.2, 5.7),
    ("glm-west", DAY + timedelta(days=1, hours=1), 48.0, 2.0),
]

LOG_ROWS = [
    ("glm-east", DAY + timedelta(hours=18), 10.0, "ok"),
    ("glm-east", DAY + timedelta(hours=18, seconds=20), 20.0, "ok"),
    ("glm-east", DAY + timedelta(hours=18, seconds=40), 30.0, "ok"),
    ("glm-east", DAY + timedelta(hours=18, minutes=1), 40.0, "failed"),
    ("glm-west", DAY + timedelta(hours=18), 15.0, "ok"),
    ("glm-west", DAY + timedelta(days=1), 15.0, "ok"),
]


@pytest.fixture
def lake(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SqliteLake:
    monkeypatch.setattr(models, "countries_file", lambda: COUNTRIES)
    resource = SqliteLake(path=str(tmp_path))
    catalog = resource.catalog()
    migrate(catalog)
    add_flashes(catalog, FLASH_ROWS)
    add_log(catalog, LOG_ROWS)
    return resource


PARTITION = "2026-07-15"


def count(check_rows: pa.Table, *checks: object) -> list[int]:
    con = duckdb.connect()
    con.execute("CREATE TABLE parent AS SELECT 'a' AS source")
    end = DAY.replace(day=16)
    return [failures(con, c, check_rows, {"parent": "parent"}, DAY, end) for c in checks]  # type: ignore[arg-type]


def test_generic_checks_count_failing_rows() -> None:
    rows = pa.table({"source": ["a", "a", "b", None], "n": [1, 1, -1, 2]})
    assert count(
        rows,
        unique(["source", "n"]),
        not_null(["source"]),
        accepted_ranges({"n": "n > 0"}),
        relationship("source", "SELECT source FROM {parent}"),
    ) == [1, 1, 1, 1]


def test_models_have_sql_and_checks() -> None:
    for model in MODELS:
        assert model.sql.lstrip().startswith("--")
        assert {"unique", "not_null", "accepted_ranges"} <= {c.name for c in model.checks}
        assert model.table.properties["write.delete.mode"] == "merge-on-read"
    assert "relationships" in {c.name for c in REGION_DAILY.checks}


def rows_of(lake: LakeResource, model: models.Model) -> list[dict[str, object]]:
    return lake.catalog().load_table(model.table.identifier).scan().to_arrow().to_pylist()


def materialize_day(lake: LakeResource, r2: FeedResource) -> None:
    result = materialize(
        [*GOLD, daily_stats_feed],
        partition_key=PARTITION,
        resources={"lake": lake, "r2": MemoryR2(), "feed_bucket": r2},
    )
    assert result.success
    checks = result.get_asset_check_evaluations()
    assert len(checks) == sum(len(m.checks) for m in MODELS)
    assert all(c.passed for c in checks), [c.check_name for c in checks if not c.passed]


def test_completeness_is_capped_when_a_source_sends_extra_files(
    lake: LakeResource, r2: FeedResource, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(EXPECTED_FILES_PER_DAY, "glm-east", 2)
    materialize_day(lake, r2)
    sla = {r["source"]: r for r in rows_of(lake, SOURCE_SLA_DAILY)}
    assert sla["glm-east"]["completeness"] == 1.0


def test_gold_day_end_to_end(lake: LakeResource, r2: FeedResource) -> None:
    materialize_day(lake, r2)

    stats = sorted(
        (r["source"], r["hour"].hour, r["lat_cell"], r["lon_cell"], r["flashes"])  # type: ignore[attr-defined]
        for r in rows_of(lake, FLASH_STATS_HOURLY)
    )
    assert stats == [
        ("glm-east", 18, 48, 2, 2),
        ("glm-east", 19, -11, -51, 1),
        ("glm-west", 18, 0, -141, 1),
        ("mtg-li", 18, 45, 5, 1),
    ]

    regions = sorted(
        (r["country_code"], r["source"], r["flashes"]) for r in rows_of(lake, REGION_DAILY)
    )
    assert regions == [("BR", "glm-east", 1), ("FR", "glm-east", 2), ("FR", "mtg-li", 1)]

    sla = {r["source"]: r for r in rows_of(lake, SOURCE_SLA_DAILY)}
    assert sla.keys() == {"glm-east", "glm-west", "mtg-li"}
    mtg = sla["mtg-li"]
    assert (mtg["files"], mtg["completeness"], mtg["latency_p50_s"]) == (0, 0.0, None)
    assert mtg["expected_files"] == 144
    east = sla["glm-east"]
    assert (east["files"], east["failed_files"], east["expected_files"]) == (4, 1, 4320)
    assert east["completeness"] == pytest.approx(3 / 4320)
    assert east["latency_p50_s"] == pytest.approx(25.0)

    feed = json.loads(bytes(obstore.get(r2.store(), feed_key(date(2026, 7, 15))).bytes()))
    assert feed["schema_version"] == 1 and feed["day"] == PARTITION
    by_source = {s["source"]: s for s in feed["sources"]}
    assert by_source["glm-east"]["flashes"] == 3
    assert by_source["glm-east"]["hourly"][18:20] == [2, 1]
    assert by_source["glm-west"]["completeness"] == pytest.approx(1 / 4320)
    assert by_source["mtg-li"]["completeness"] == 0.0
    assert obstore.list(BUCKET[0]).collect() == []

    materialize_day(lake, r2)
    assert len(rows_of(lake, FLASH_STATS_HOURLY)) == 4
    assert len(rows_of(lake, REGION_DAILY)) == 3


def test_failed_check_does_not_overwrite_the_day(
    lake: LakeResource, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert materialize([GOLD[0]], partition_key=PARTITION, resources={"lake": lake}).success
    compute = models.compute
    monkeypatch.setattr(
        assets,
        "compute",
        lambda con, model, day: pa.concat_tables([compute(con, model, day)] * 2),
    )
    result = materialize(
        [GOLD[0]], partition_key=PARTITION, resources={"lake": lake}, raise_on_error=False
    )
    assert not all(c.passed for c in result.get_asset_check_evaluations())
    assert len(rows_of(lake, FLASH_STATS_HOURLY)) == 4


def test_lineage_runs_from_raw_files_to_the_feed() -> None:
    graph = defs.resolve_asset_graph()
    upstream = graph.get(AssetKey(["feeds", "daily_stats"])).parent_keys
    seen = set(upstream)
    while upstream:
        upstream = {p for key in upstream for p in graph.get(key).parent_keys} - seen
        seen |= upstream
    assert {
        AssetKey(["gold", "flash_stats_hourly"]),
        AssetKey(["gold", "source_sla_daily"]),
        AssetKey(["silver", "flashes"]),
        AssetKey(["bronze", "ingest_log"]),
        AssetKey(["raw", "glm_files"]),
    } <= seen
    region = graph.get(AssetKey(["gold", "region_daily"])).parent_keys
    assert AssetKey(["reference", "countries"]) in region


def test_countries_file_rejects_a_bad_checksum(
    tmp_path: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: BytesIO(b"nope"))
    with pytest.raises(ValueError, match="checksum"):
        models.countries_file(tmp_path)  # type: ignore[arg-type]
