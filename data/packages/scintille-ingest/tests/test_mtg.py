import asyncio
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path

import netCDF4
import numpy as np
import polars as pl
import pytest
from scintille_contract.ids import flash_id
from scintille_contract.models import FlashRecord
from scintille_ingest.cli import mtg_once
from scintille_ingest.glm.parse import FLASH_SCHEMA
from scintille_ingest.mtg.discovery import Listed, chunks
from scintille_ingest.mtg.ingest import ingest_li_file
from scintille_ingest.mtg.parse import RAW_SCHEMA, normalize_li_flashes, read_li_flashes
from scintille_ingest.mtg.products import is_flash_chunk, parse_key
from scintille_ingest.runtime.sources import MtgSource
from scintille_ingest.validate import validate

PREFIX = "W_XX-EUMETSAT-Darmstadt,IMG+SAT,MTI1+LI-2-LFL--FD--CHK-"
OPE = "L2PF_OPE"


def name(kind: str, created: str, start: str, end: str, chunk: str) -> str:
    return f"{PREFIX}{kind}---NC4E_C_EUMT_{created}_{OPE}_{start}_{end}_N__O_0049_{chunk}"


PRODUCT_ID = name("BODY", "20261012081012", "20261012080000", "20261012081000", "0000")
BODY = name("BODY", "20261012080041", "20261012080000", "20261012080030", "0001.nc")
LATER = name("BODY", "20261012080111", "20261012080030", "20261012080100", "0002.nc")
TRAIL = name("TRAIL", "20261012081012", "20261012080000", "20261012081000", "0021.nc")
KEY = f"{PRODUCT_ID}/{BODY}"
CHUNK_START = datetime(2026, 10, 12, 8, 0, 0, tzinfo=UTC)
RECEIVED = datetime(2026, 10, 12, 8, 1, 5, tzinfo=UTC)
EPOCH = datetime(2000, 1, 1, tzinfo=UTC)

LAT = [48.85, -1.29, 6.52, 35.2]
LON = [2.35, 36.82, 3.38, -40.0]
RADIANCE = [120.5, 3400.0, 15.25, 800.0]


def li_chunk(
    path: Path,
    *,
    duration_units: str = "ms",
    footprint_units: str = "km2",
    geolocation_warning: int = 0,
    radiometric: list[int] | None = None,
) -> bytes:
    """A small LFL chunk with the layout of the product user guide: variables in `data`, packed
    coordinates, times in seconds since 2000."""
    seconds = (CHUNK_START - EPOCH).total_seconds()
    with netCDF4.Dataset(path, "w") as root:
        ds = root.createGroup("data")
        ds.createDimension("flashes", len(LAT))
        ids = ds.createVariable("flash_id", "u4", ("flashes",))
        ids[:] = [101, 102, 103, 104]
        time = ds.createVariable("flash_time", "f8", ("flashes",))
        time.units = "seconds since 2000-01-01 00:00:00.0"
        time[:] = [seconds + s for s in (1.25, 7.5, 12.0, 29.875)]
        for name, values in (("latitude", LAT), ("longitude", LON)):
            var = ds.createVariable(name, "i2", ("flashes",))
            var.scale_factor = 0.0027
            var.add_offset = 0.0
            var.units = "degrees"
            var[:] = values
        radiance = ds.createVariable("radiance", "f4", ("flashes",))
        radiance.units = "mW.m-2.sr-1"
        radiance[:] = RADIANCE
        footprint = ds.createVariable("flash_footprint", "f4", ("flashes",))
        footprint.units = footprint_units
        footprint[:] = [210.0, 1500.0, 95.0, 400.0]
        duration = ds.createVariable("flash_duration", "f4", ("flashes",))
        duration.units = duration_units
        duration[:] = [120.0, 350.0, 0.0, 80.0]
        ds.createVariable("l1b_missing_warning", "u1")[:] = 0
        ds.createVariable("l1b_geolocation_warning", "u1")[:] = geolocation_warning
        per_flash = ds.createVariable("l1b_radiometric_warning", "u1", ("flashes",))
        per_flash[:] = radiometric or [0, 0, 0, 0]
    return path.read_bytes()


@pytest.fixture
def data(tmp_path: Path) -> bytes:
    return li_chunk(tmp_path / "li.nc")


class FakeStore:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.fetched: list[tuple[str, str]] = []
        self.listed = [
            Listed(
                PRODUCT_ID,
                (TRAIL, LATER, "EOPMetadata.xml", BODY),
                RECEIVED - timedelta(seconds=20),
            )
        ]

    def search(self, start: datetime, end: datetime) -> list[Listed]:
        return self.listed

    def fetch(self, product_id: str, entry: str) -> bytes:
        self.fetched.append((product_id, entry))
        return self.data


def test_parse_key_reads_the_chunk_times() -> None:
    chunk = parse_key(KEY)
    assert (chunk.platform, chunk.product_id, chunk.name) == ("MTG-I1", PRODUCT_ID, BODY)
    assert chunk.start == CHUNK_START
    assert chunk.end == CHUNK_START + timedelta(seconds=30)
    assert chunk.created == datetime(2026, 10, 12, 8, 0, 41, tzinfo=UTC)
    with pytest.raises(ValueError):
        parse_key(f"{PRODUCT_ID}/EOPMetadata.xml")


def test_only_body_chunks_carry_flashes() -> None:
    assert is_flash_chunk(BODY)
    assert not is_flash_chunk(TRAIL)
    assert not is_flash_chunk("EOPMetadata.xml")
    listed = FakeStore(b"").listed
    assert [c.name for c in chunks(listed)] == [BODY, LATER]


def test_read_li_flashes_unpacks_and_converts(data: bytes) -> None:
    raw = read_li_flashes(data)
    assert raw.schema == RAW_SCHEMA
    assert raw["native_flash_id"].to_list() == [101, 102, 103, 104]
    assert raw["event_time"][0] == CHUNK_START + timedelta(seconds=1.25)
    assert raw["event_time"][3] == CHUNK_START + timedelta(seconds=29.875)
    assert np.allclose(raw["lat"].to_numpy(), LAT, atol=0.002)
    assert np.allclose(raw["lon"].to_numpy(), LON, atol=0.002)
    assert raw["radiance"].to_list() == RADIANCE
    assert raw["footprint_km2"][1] == 1500.0
    assert raw["duration_ms"][1] == 350.0
    assert not raw["l1b_warning"].any()


def test_units_are_converted(tmp_path: Path) -> None:
    raw = read_li_flashes(li_chunk(tmp_path / "li.nc", duration_units="s", footprint_units="m2"))
    assert raw["duration_ms"][1] == 350_000.0
    assert raw["footprint_km2"][1] == pytest.approx(1500e-6)


def test_unknown_units_fail_the_file(tmp_path: Path) -> None:
    ingested = ingest_li_file(li_chunk(tmp_path / "li.nc", duration_units="min"), KEY, RECEIVED)
    assert ingested.log.status == "failed"
    assert ingested.log.error and "flash_duration" in ingested.log.error
    assert ingested.flashes.height == 0


def test_l1b_warnings_mark_flashes_degraded(tmp_path: Path) -> None:
    per_flash = read_li_flashes(li_chunk(tmp_path / "a.nc", radiometric=[0, 1, 0, 0]))
    assert per_flash["l1b_warning"].to_list() == [False, True, False, False]
    whole = read_li_flashes(li_chunk(tmp_path / "b.nc", geolocation_warning=1))
    assert whole["l1b_warning"].all()


def test_normalize_maps_to_the_contract(data: bytes) -> None:
    flashes = normalize_li_flashes(read_li_flashes(data), "mtg-li", BODY, RECEIVED)
    assert flashes.schema == FLASH_SCHEMA
    assert flashes["flash_id"][0] == flash_id("mtg-li", BODY, 101)
    assert flashes["energy_unit"].cast(pl.String).unique().to_list() == ["mW m-2 sr-1"]
    assert flashes["energy_raw"].to_list() == RADIANCE
    assert flashes["area_km2"][0] == 210.0
    assert flashes["ingest_time"].unique().to_list() == [RECEIVED]
    for row in flashes.with_columns(pl.col(pl.Enum).cast(pl.String)).iter_rows(named=True):
        FlashRecord.model_validate(row | {"intensity": 0.5})


def test_ingest_li_file_writes_an_ingest_log_row(data: bytes) -> None:
    ingested = ingest_li_file(data, KEY, RECEIVED)
    entry = ingested.log
    assert (entry.source, entry.satellite, entry.status, entry.row_count) == (
        "mtg-li",
        "MTG-I1",
        "ok",
        4,
    )
    assert (entry.product_start, entry.product_end) == (CHUNK_START, parse_key(KEY).end)
    assert entry.checksum.startswith("sha256:")
    valid, rejected = validate(ingested.flashes, (entry.product_start, entry.product_end))
    assert (valid.height, rejected.height) == (4, 0)
    quality = ingested.flashes["quality"].to_list()
    assert "outside-owner-zone" not in quality[0]
    assert "outside-owner-zone" in quality[3]


def test_ingest_is_idempotent(data: bytes) -> None:
    first = ingest_li_file(data, KEY, RECEIVED).flashes
    again = ingest_li_file(data, KEY, RECEIVED + timedelta(minutes=3)).flashes
    assert first["flash_id"].to_list() == again["flash_id"].to_list()


def test_unreadable_file_gives_a_failed_log_row() -> None:
    ingested = ingest_li_file(b"not a netcdf file", KEY, RECEIVED)
    assert ingested.log.status == "failed"
    assert ingested.flashes.schema == FLASH_SCHEMA


def test_mtg_source_lists_and_fetches_chunks(data: bytes) -> None:
    store = FakeStore(data)
    source = MtgSource(store)
    products = asyncio.run(source.list_recent(RECEIVED))
    assert [p.key for p in products] == [KEY, f"{PRODUCT_ID}/{LATER}"]
    assert asyncio.run(source.fetch(products[0])) == data
    assert store.fetched == [(PRODUCT_ID, BODY)]
    assert source.parse(products[0], data, RECEIVED).log.row_count == 4


def test_mtg_once_prints_the_latest_chunk_and_latencies(
    data: bytes, capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture
) -> None:
    store = FakeStore(data)
    with caplog.at_level(logging.INFO):
        assert mtg_once(store, rows=2) == 0
    assert store.fetched == [(PRODUCT_ID, LATER)]
    out = capsys.readouterr().out
    assert "mtg-li (MTG-I1, EUMETSAT Data Store)" in out
    assert "4 normalized flashes" in out
    assert "Data Store publication after chunk end" in caplog.text
    assert "received after newest flash" in caplog.text


def test_mtg_once_without_chunks_fails(data: bytes) -> None:
    store = FakeStore(data)
    store.listed = []
    assert mtg_once(store, rows=0) == 1
