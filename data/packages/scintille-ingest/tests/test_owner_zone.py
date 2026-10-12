import asyncio
import gzip
import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import netCDF4
import polars as pl
import pytest
from scintille_contract.chunk import decode
from scintille_contract.models import SOURCE_VALUES, LiveManifest
from scintille_contract.ownership import SATELLITES
from scintille_ingest.glm.ingest import IngestedFile, ingest_glm_file
from scintille_ingest.glm.parse import FLASH_SCHEMA
from scintille_ingest.ingest_log import IngestLogRecord
from scintille_ingest.ownership import OUTSIDE_OWNER_ZONE, flag_outside_owner
from scintille_ingest.runtime.lake_commit import to_silver
from scintille_ingest.runtime.live_feed import LiveFeed
from scintille_ingest.runtime.metrics import Metrics
from scintille_ingest.runtime.service import IngestLive
from scintille_ingest.runtime.sources import Product
from scintille_ingest.runtime.spool import Spool
from scintille_ingest.runtime.state import MemoryState

NOW = datetime(2026, 7, 15, 18, 30, tzinfo=UTC)
FIXTURE = (
    Path(__file__).parent
    / "fixtures"
    / "OR_GLM-L2-LCFA_G18_s20262811818400_e20262811819000_c20262811819015.nc"
)


class MemoryStore:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    async def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
        self.objects[path] = data

    async def get(self, path: str) -> bytes | None:
        return self.objects.get(path)

    async def delete(self, path: str) -> None:
        self.objects.pop(path, None)


def flash(source: str, lat: float, lon: float, quality: tuple[str, ...] = ()) -> dict[str, object]:
    return {
        "flash_id": hashlib.sha256(f"{source}{lat}{lon}".encode()).hexdigest()[:32],
        "source": source,
        "product_file": f"{source}.nc",
        "native_flash_id": 1,
        "event_time": NOW - timedelta(seconds=40),
        "ingest_time": NOW,
        "lat": lat,
        "lon": lon,
        "energy_raw": 2e-14,
        "energy_unit": "J",
        "intensity": None,
        "area_km2": 150.0,
        "duration_ms": 250.0,
        "quality": list(quality),
    }


def frame(*rows: dict[str, object]) -> pl.DataFrame:
    return pl.DataFrame(list(rows), schema=FLASH_SCHEMA)


class SeenByBoth:
    """One source of a flash seen by two satellites, by default at 25° N 100° W (GOES-East side)."""

    cadence = 0.01

    def __init__(self, name: str, lat: float = 25.0, lon: float = -100.0) -> None:
        self.name = name
        self.lat, self.lon = lat, lon
        self.product = Product(f"{name}/file.nc", NOW - timedelta(seconds=60))

    async def list_recent(self, now: datetime) -> list[Product]:
        return [self.product]

    async def fetch(self, product: Product) -> bytes:
        return product.key.encode()

    def parse(self, product: Product, data: bytes, received_at: datetime) -> IngestedFile:
        log = IngestLogRecord(
            key=product.key,
            source=self.name,  # type: ignore[arg-type]
            satellite="G19",
            product_start=product.start,
            product_end=product.start + timedelta(seconds=20),
            received_at=received_at,
            row_count=1,
            checksum="sha256:x",
            status="ok",
            parse_duration_ms=1.0,
            error=None,
        )
        return IngestedFile(flag_outside_owner(frame(flash(self.name, self.lat, self.lon))), log)


@pytest.mark.parametrize(
    ("sources", "owner"),
    [
        ([SeenByBoth("glm-east"), SeenByBoth("glm-west")], "glm-east"),
        ([SeenByBoth("mtg-li", 5.0, -30.0), SeenByBoth("glm-east", 5.0, -30.0)], "mtg-li"),
    ],
)
def test_a_flash_seen_by_two_sources_is_live_once_and_twice_in_silver(
    tmp_path: Path, sources: list[SeenByBoth], owner: str
) -> None:
    store, spool, metrics = MemoryStore(), Spool(tmp_path / "spool"), Metrics()
    clock = {"now": NOW}
    feed = LiveFeed(store, outbox=tmp_path / "outbox", clock=lambda: clock["now"])
    service = IngestLive(
        sources,  # type: ignore[arg-type]
        MemoryState(),
        spool,
        publisher=feed,
        metrics=metrics,
        clock=lambda: clock["now"],
    )

    async def scenario() -> None:
        for source in sources:
            await service.poll(source)
        clock["now"] += timedelta(seconds=30)
        await feed.flush()

    asyncio.run(scenario())

    manifest = LiveManifest.model_validate_json(store.objects["manifest.json"])
    chunks = [decode(gzip.decompress(store.objects[c.path])) for c in manifest.chunks]
    live_sources = [SOURCE_VALUES[i] for c in chunks for i in c.columns["source"].tolist()]
    assert live_sources == [owner]

    silver = to_silver(pl.concat(spool.read(b) for b in spool.pending()))
    flags = dict(zip(silver["source"], silver["quality"].to_list(), strict=True))
    other = next(s.name for s in sources if s.name != owner)
    assert flags == {owner: [], other: [OUTSIDE_OWNER_ZONE]}
    assert f'ingest_live_excluded_total{{source="{other}"}} 1' in metrics.render()


def run_both(
    tmp_path: Path,
    owner_gap: timedelta,
    east: SeenByBoth | None = None,
    west: SeenByBoth | None = None,
) -> tuple[LiveManifest, list[str], Metrics]:
    """The owner (East) then the other source ingest the same flash, `owner_gap` apart."""
    store, metrics = MemoryStore(), Metrics()
    clock = {"now": NOW}
    feed = LiveFeed(store, outbox=tmp_path / "outbox", clock=lambda: clock["now"])
    east, west = east or SeenByBoth("glm-east"), west or SeenByBoth("glm-west")
    service = IngestLive(
        [east, west],
        MemoryState(),
        Spool(tmp_path / "spool"),
        publisher=feed,
        metrics=metrics,
        clock=lambda: clock["now"],
    )

    async def scenario() -> None:
        await service.poll(east)
        await feed.flush()
        clock["now"] += owner_gap
        await service.poll(west)
        clock["now"] += timedelta(seconds=30)
        await feed.flush()

    asyncio.run(scenario())
    manifest = LiveManifest.model_validate_json(store.objects["manifest.json"])
    chunks = [decode(gzip.decompress(store.objects[c.path])) for c in manifest.chunks]
    return (
        manifest,
        [SOURCE_VALUES[i] for c in chunks for i in c.columns["source"].tolist()],
        metrics,
    )


def test_a_source_with_only_excluded_flashes_still_looks_alive(tmp_path: Path) -> None:
    manifest, live_sources, _ = run_both(tmp_path, timedelta(seconds=20))
    assert live_sources == ["glm-east"]
    west = next(s for s in manifest.sources if s.source == "glm-west")
    assert west.last_ingest_time == NOW + timedelta(seconds=20)


def test_flagged_flashes_stay_live_while_the_owner_is_down(tmp_path: Path) -> None:
    _, live_sources, metrics = run_both(tmp_path, timedelta(minutes=6))
    assert live_sources == ["glm-east", "glm-west"]
    assert "ingest_live_excluded_total" not in metrics.render()


@pytest.mark.parametrize(("gap", "live"), [(8, ["mtg-li"]), (16, ["mtg-li", "glm-east"])])
def test_mtg_stays_the_owner_between_its_10_min_files(
    tmp_path: Path, gap: int, live: list[str]
) -> None:
    mtg, east = SeenByBoth("mtg-li", 5.0, -30.0), SeenByBoth("glm-east", 5.0, -30.0)
    _, live_sources, _ = run_both(tmp_path, timedelta(minutes=gap), mtg, east)
    assert live_sources == live


def test_flags_only_flashes_owned_by_another_source() -> None:
    flagged = flag_outside_owner(
        frame(
            flash("glm-east", 30.0, -90.0),
            flash("glm-east", 30.0, -120.0, ("degraded",)),
            flash("glm-west", 30.0, -90.0),
            flash("glm-west", 30.0, -120.0),
            flash("glm-west", 0.0, 150.0),
            flash("mtg-li", 0.0, 10.0),
            flash("glm-east", 5.0, -30.0),
            flash("mtg-li", 5.0, -50.0),
            flash("mtg-li", 66.0, -45.0),
        )
    )
    assert flagged["quality"].to_list() == [
        [],
        ["degraded", OUTSIDE_OWNER_ZONE],
        [OUTSIDE_OWNER_ZONE],
        [],
        [],
        [],
        [OUTSIDE_OWNER_ZONE],
        [OUTSIDE_OWNER_ZONE],
        [],
    ]


def test_empty_file_stays_empty() -> None:
    assert flag_outside_owner(FLASH_SCHEMA.to_frame()).height == 0


def test_glm_west_file_flags_its_flashes_east_of_the_boundary() -> None:
    key = f"GLM-L2-LCFA/2026/281/18/{FIXTURE.name}"
    flashes = ingest_glm_file(FIXTURE.read_bytes(), key, "glm-west", NOW).flashes
    assert flashes.height
    outside = flashes["quality"].list.contains(OUTSIDE_OWNER_ZONE)
    boundary = sum(s.subpoint_lon for s in SATELLITES) / 2
    assert outside.to_list() == flashes["lon"].is_between(boundary, 0, closed="none").to_list()
    assert 0 < outside.sum() < flashes.height


def test_configured_subpoint_matches_the_file_metadata() -> None:
    with netCDF4.Dataset("glm.nc", memory=FIXTURE.read_bytes()) as ds:
        subpoint = float(ds.variables["nominal_satellite_subpoint_lon"][:])
    west = next(s for s in SATELLITES if s.source == "glm-west")
    assert abs(west.subpoint_lon - subpoint) < 0.01
