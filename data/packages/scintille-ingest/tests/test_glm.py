import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import obstore
import polars as pl
import pytest
from obstore.store import MemoryStore
from scintille_contract.ids import flash_id
from scintille_contract.models import FlashRecord
from scintille_ingest.glm.discovery import (
    fetch,
    latest_product,
    list_products,
    new_products,
    public_store,
)
from scintille_ingest.glm.ingest import ingest_glm_file
from scintille_ingest.glm.parse import (
    FLASH_SCHEMA,
    RAW_SCHEMA,
    normalize_glm_flashes,
    read_glm_flashes,
)
from scintille_ingest.glm.products import (
    Satellite,
    goes_stamp,
    hour_prefix,
    parse_key,
    satellites_from_env,
)
from scintille_ingest.runtime.sources import GlmSource

FIXTURE = (
    Path(__file__).parent
    / "fixtures"
    / "OR_GLM-L2-LCFA_G18_s20262811818400_e20262811819000_c20262811819015.nc"
)
KEY = f"GLM-L2-LCFA/2026/281/18/{FIXTURE.name}"
FILE_START = datetime(2026, 10, 8, 18, 18, 40, tzinfo=UTC)
RECEIVED = datetime(2026, 10, 8, 18, 19, 30, 250000, tzinfo=UTC)


@pytest.fixture(scope="module")
def data() -> bytes:
    return FIXTURE.read_bytes()


@pytest.fixture(scope="module")
def raw(data: bytes) -> pl.DataFrame:
    return read_glm_flashes(data)


@pytest.fixture(scope="module")
def flashes(raw: pl.DataFrame) -> pl.DataFrame:
    return normalize_glm_flashes(raw, "glm-west", FIXTURE.name, RECEIVED)


def test_parse_key_reads_times_from_the_file_name() -> None:
    product = parse_key(KEY)
    assert product.platform == "G18"
    assert product.name == FIXTURE.name
    assert product.start == FILE_START
    assert product.end == FILE_START + timedelta(seconds=20)
    assert product.created == datetime(2026, 10, 8, 18, 19, 1, 500000, tzinfo=UTC)
    with pytest.raises(ValueError):
        parse_key("GLM-L2-LCFA/2026/281/18/readme.txt")


def test_hour_prefix_uses_day_of_year() -> None:
    assert hour_prefix(datetime(2026, 2, 1, 7, 59, tzinfo=UTC)) == "GLM-L2-LCFA/2026/032/07/"


def test_buckets_are_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    assert [s.bucket for s in satellites_from_env()] == ["noaa-goes19", "noaa-goes18"]
    monkeypatch.setenv("SCINTILLE_GLM_WEST_BUCKET", "noaa-goes20")
    east, west = satellites_from_env()
    assert (east.source, west.source, west.bucket) == ("glm-east", "glm-west", "noaa-goes20")


def test_read_glm_flashes_unpacks_flash_variables(raw: pl.DataFrame) -> None:
    assert raw.schema == RAW_SCHEMA
    assert raw.height == 17
    assert raw.null_count().sum_horizontal().item() == 0
    assert raw["native_flash_id"].n_unique() == raw.height
    assert raw["lat"].is_between(-90, 90).all() and raw["lon"].is_between(-180, 180).all()
    assert (raw["energy_j"] > 0).all() and (raw["area_m2"] > 0).all()
    assert (raw["last_event_time"] >= raw["first_event_time"]).all()
    first = raw.row(0, named=True)
    assert first["native_flash_id"] == 34709
    assert first["first_event_time"] == datetime(2026, 10, 8, 18, 18, 39, 574656, tzinfo=UTC)
    assert first["lat"] == pytest.approx(10.021328, abs=1e-5)
    assert first["energy_j"] == pytest.approx(9.9285e-14, rel=1e-3)
    assert raw["first_event_time"].min() > FILE_START - timedelta(seconds=5)  # type: ignore[operator]
    assert raw["first_event_time"].max() < FILE_START + timedelta(seconds=20)  # type: ignore[operator]


def test_normalized_flashes_follow_the_contract(flashes: pl.DataFrame) -> None:
    assert flashes.schema == FLASH_SCHEMA
    assert list(flashes.columns) == list(FlashRecord.model_fields)
    assert flashes["intensity"].is_null().all()
    first = flashes.row(0, named=True)
    assert first["area_km2"] == pytest.approx(641.233, abs=1e-3)
    assert first["duration_ms"] == pytest.approx(465.4)
    assert first["event_time"] == datetime(2026, 10, 8, 18, 18, 39, 574656, tzinfo=UTC)
    for row in flashes.to_dicts():
        FlashRecord.model_validate({**row, "intensity": 0.0})


def test_quality_flagged_flashes_are_kept_and_flagged(
    raw: pl.DataFrame, flashes: pl.DataFrame
) -> None:
    assert flashes.height == raw.height
    degraded = flashes.filter(pl.col("quality").list.len() > 0)
    assert degraded["native_flash_id"].to_list() == [34777]
    assert degraded["quality"].to_list() == [["degraded"]]
    assert raw.filter(pl.col("native_flash_id") == 34777)["quality_flag"].item() == 3


def test_missing_quality_is_treated_as_degraded(raw: pl.DataFrame) -> None:
    patched = raw.with_columns(pl.lit(None, dtype=pl.Int32).alias("quality_flag"))
    flashes = normalize_glm_flashes(patched, "glm-west", FIXTURE.name, RECEIVED)
    assert flashes["quality"].list.len().min() == 1


def test_same_file_parsed_twice_yields_identical_flash_ids(data: bytes) -> None:
    first = ingest_glm_file(data, KEY, "glm-west", RECEIVED).flashes
    second = ingest_glm_file(data, KEY, "glm-west", RECEIVED + timedelta(hours=1)).flashes
    assert first["flash_id"].to_list() == second["flash_id"].to_list()
    assert first["flash_id"].n_unique() == first.height
    assert first["flash_id"][0] == flash_id("glm-west", FIXTURE.name, 34709)


def test_ingest_log_row_describes_the_file(data: bytes) -> None:
    log = ingest_glm_file(data, KEY, "glm-west", RECEIVED).log
    assert log.status == "ok" and log.error is None
    assert (log.key, log.source, log.satellite) == (KEY, "glm-west", "G18")
    assert (log.product_start, log.product_end) == (FILE_START, FILE_START + timedelta(seconds=20))
    assert log.received_at == RECEIVED
    assert log.row_count == 17
    assert log.checksum.startswith("sha256:") and len(log.checksum) == 7 + 64
    assert log.parse_duration_ms > 0


def test_unreadable_file_is_logged_as_failed() -> None:
    result = ingest_glm_file(b"not a netcdf file", KEY, "glm-west", RECEIVED)
    assert result.log.status == "failed"
    assert result.log.error
    assert result.log.row_count == 0
    assert result.flashes.schema == FLASH_SCHEMA


def test_discovery_lists_the_hour_prefix_and_falls_back_one_hour() -> None:
    store = MemoryStore()
    names = [
        "OR_GLM-L2-LCFA_G18_s20262811818400_e20262811819000_c20262811819015.nc",
        "OR_GLM-L2-LCFA_G18_s20262811819000_e20262811819200_c20262811819216.nc",
        "OR_GLM-L2-LCFA_G18_s20262811818200_e20262811818400_c20262811818415.nc",
    ]
    for name in names:
        obstore.put(store, f"GLM-L2-LCFA/2026/281/18/{name}", b"")
    obstore.put(store, "GLM-L2-LCFA/2026/281/18/index.html", b"")

    listed = list_products(store, datetime(2026, 10, 8, 18, 30, tzinfo=UTC))
    assert [p.name for p in listed] == [names[2], names[0], names[1]]
    assert [p.name for p in new_products(listed, {listed[0].key})] == [names[0], names[1]]

    latest = latest_product(store, datetime(2026, 10, 8, 19, 0, 10, tzinfo=UTC))
    assert latest is not None and latest.name == names[1]
    assert latest_product(store, datetime(2026, 10, 8, 21, 0, tzinfo=UTC)) is None


@pytest.mark.network
def test_latest_live_file_of_each_satellite_parses() -> None:
    for satellite in satellites_from_env():
        store = public_store(satellite.bucket)
        product = latest_product(store, datetime.now(UTC))
        assert product is not None
        result = ingest_glm_file(fetch(store, product.key), product.key, satellite.source, RECEIVED)
        assert result.log.status == "ok"


def test_glm_source_lists_recent_files_then_the_whole_hours_every_minute() -> None:
    store = MemoryStore()

    def put(start: datetime) -> str:
        stamp = goes_stamp(start)
        end = goes_stamp(start + timedelta(seconds=20))
        key = f"{hour_prefix(start)}OR_GLM-L2-LCFA_G19_s{stamp}_e{end}_c{end}.nc"
        obstore.put(store, key, b"")
        return key

    t = datetime(2026, 10, 29, 18, 0, 40, tzinfo=UTC)
    old, previous_hour, recent = (
        put(t - timedelta(minutes=30)),
        put(t - timedelta(minutes=2)),
        put(t),
    )
    source = GlmSource(Satellite("glm-east", "noaa-goes19"), store)
    assert {p.key for p in asyncio.run(source.list_recent(t))} == {old, previous_hour, recent}

    late = put(t - timedelta(seconds=40))
    obstore.put(store, old, b"revised")
    listed = asyncio.run(source.list_recent(t + timedelta(seconds=2)))
    assert {p.key for p in listed} == {previous_hour, late, recent}

    full = asyncio.run(source.list_recent(t + timedelta(minutes=2.5)))
    assert {p.key for p in full} == {old, previous_hour, late, recent}
    assert {p.key for p in asyncio.run(source.list_recent(t + timedelta(minutes=3)))} == {recent}
