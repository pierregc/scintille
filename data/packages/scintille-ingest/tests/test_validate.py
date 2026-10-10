import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import polars as pl
from pyiceberg.catalog.sql import SqlCatalog
from scintille_ingest.glm.ingest import IngestedFile
from scintille_ingest.glm.parse import FLASH_SCHEMA
from scintille_ingest.ingest_log import IngestLogRecord
from scintille_ingest.runtime.lake_commit import LakeCommit
from scintille_ingest.runtime.service import IngestLive
from scintille_ingest.runtime.sources import Product
from scintille_ingest.runtime.spool import Spool
from scintille_ingest.runtime.state import MemoryState
from scintille_ingest.validate import validate
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES, FLASHES_QUARANTINE

START = datetime(2026, 7, 15, 18, tzinfo=UTC)


def rows(**overrides: list[object]) -> pl.DataFrame:
    base: dict[str, list[object]] = {
        "flash_id": ["0" * 32, "1" * 32, "2" * 32, "3" * 32],
        "source": ["glm-east"] * 4,
        "product_file": ["f.nc"] * 4,
        "native_flash_id": [0, 1, 2, 3],
        "event_time": [START + timedelta(seconds=i) for i in range(4)],
        "ingest_time": [START + timedelta(seconds=40)] * 4,
        "lat": [10.0, 95.0, 10.0, 10.0],
        "lon": [20.0, 20.0, 20.0, 20.0],
        "energy_raw": [1e-14, 1e-14, -1.0, 1e-14],
        "energy_unit": ["J"] * 4,
        "intensity": [None] * 4,
        "area_km2": [100.0] * 4,
        "duration_ms": [200.0] * 4,
        "quality": [[]] * 4,
    }
    base.update(overrides)
    return pl.DataFrame(base, schema=FLASH_SCHEMA)


def test_flags_each_broken_rule_with_a_reason() -> None:
    frame = rows(event_time=[START, START, START, START + timedelta(hours=2)])
    valid, rejected = validate(frame, (START, START + timedelta(seconds=20)))
    assert valid["native_flash_id"].to_list() == [0]
    reasons = dict(
        zip(rejected["native_flash_id"].to_list(), rejected["reason"].to_list(), strict=True)
    )
    assert "lat" in reasons[1]
    assert "energy_raw" in reasons[2]
    assert reasons[3] == "event_time: outside the product window"


def test_bad_rows_land_in_quarantine_with_their_reason(tmp_path: Path) -> None:
    product = Product("glm/f.nc", START)

    class Source:
        name = "glm-east"
        cadence = 1.0

        async def list_recent(self, now: datetime) -> list[Product]:
            return [product]

        async def fetch(self, p: Product) -> bytes:
            return b"x"

        def parse(self, p: Product, data: bytes, received_at: datetime) -> IngestedFile:
            log = IngestLogRecord(
                p.key,
                "glm-east",
                "G19",
                START,
                START + timedelta(seconds=20),
                received_at,
                4,
                "sha256:x",
                "ok",
                1.0,
            )
            return IngestedFile(rows(), log)

    catalog = SqlCatalog("t", uri=f"sqlite:///{tmp_path}/c.db", warehouse=f"file://{tmp_path}/w")
    migrate(catalog)
    spool = Spool(tmp_path / "spool")
    asyncio.run(IngestLive([Source()], MemoryState(), spool, clock=lambda: START).poll(Source()))
    LakeCommit(lambda: catalog)(spool, spool.pending())

    silver = catalog.load_table(FLASHES.identifier).scan().to_arrow()
    quarantine = catalog.load_table(FLASHES_QUARANTINE.identifier).scan().to_arrow()
    assert silver.num_rows == 2
    assert quarantine.sort_by("native_flash_id")["native_flash_id"].to_pylist() == [1, 2]
    assert all(quarantine["reason"].to_pylist())
    record = json.loads(quarantine["record"][0].as_py())
    assert record["product_file"] == "f.nc"
