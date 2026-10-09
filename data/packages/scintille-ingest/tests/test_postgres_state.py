"""PostgresState against the local Postgres from compose.yaml."""

import asyncio
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import polars as pl
import pytest
from scintille_ingest.runtime.identity import FileIdentity
from scintille_ingest.runtime.service import Crash, IngestLive
from scintille_ingest.runtime.sources import Product
from scintille_ingest.runtime.spool import Spool
from scintille_ingest.runtime.state import PostgresState

pytestmark = pytest.mark.lake
DSN = "postgresql://postgres:postgres@localhost:55432/scintille"


def test_states_only_move_forward() -> None:
    state = PostgresState(DSN)
    file = FileIdentity(f"test/{uuid4().hex}.nc", "sha256:1")
    state.advance(file, "glm-east", "published_live")
    state.advance(file, "glm-east", "downloaded")
    record = state.get(file)
    assert record is not None and record.state == "published_live"
    state.advance(file, "glm-east", "spooled", "batch-1")
    state.advance(file, "glm-east", "spooled", "batch-2")
    record = state.get(file)
    assert record is not None and (record.state, record.batch_id) == ("spooled", "batch-1")
    assert state.spooled_keys("glm-east", [file.key, "other"]) == {file.key}
    state.close()


def test_restart_after_a_crash_spools_once(tmp_path: Path) -> None:
    prefix = uuid4().hex
    products = [Product(f"{prefix}/f{i}.nc", datetime.now(UTC)) for i in range(2)]

    class Source:
        name = "glm-east"
        cadence = 1.0

        async def list_recent(self, now: object) -> list[Product]:
            return products

        async def fetch(self, product: Product) -> bytes:
            return product.key.encode()

        def parse(self, product: Product, data: bytes, received_at: object) -> pl.DataFrame:
            return pl.DataFrame({"flash_id": [product.key]})

    def crash(step: str, identity: FileIdentity) -> None:
        if step == "spool_written" and identity.key.endswith("f1.nc"):
            raise Crash(step)

    spool = Spool(tmp_path)
    with pytest.raises(Crash):
        asyncio.run(
            IngestLive([Source()], PostgresState(DSN), spool, after_step=crash).poll(Source())
        )
    state = PostgresState(DSN)
    asyncio.run(IngestLive([Source()], state, spool).poll(Source()))
    assert len(spool.pending()) == 2
    assert state.spooled_keys("glm-east", [p.key for p in products]) == {p.key for p in products}
