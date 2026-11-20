import asyncio
import json
import posixpath
import re
from datetime import UTC, datetime

import numpy as np
import obstore
import pytest
from obstore.store import MemoryStore
from scintille_contract.cloud_archive import ARCHIVE_COLD_TOPS_PATTERN
from scintille_ingest.clouds import cold_tops, composite, geos
from scintille_ingest.clouds.disk import Disk
from scintille_ingest.clouds.publish import ArchiveCloudManifest, CloudManifest, CloudPublisher
from scintille_ingest.runtime.live_feed import ObjectLiveStore

SLOT = datetime(2026, 11, 20, 6, tzinfo=UTC)
HIMAWARI = geos.View(140.7, 35785863.0, "y")
STEP = 2000.0 / 35785863.0
CELL = cold_tops.CELL_PX


def skin_at(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    return np.full(np.shape(lat), 300.0, np.float32)


def disk_around(lat: float, lon: float, height_km: float, cells: int = 3) -> Disk:
    """A disk whose middle cell is centred where the top `height_km` above the point is seen."""
    x, y, _ = geos.scan_angles(np.array([lat]), np.array([lon]), height_km * 1000, HIMAWARI)
    size = cells * CELL
    middle = (size - 1) / 2
    grid = geos.Grid(
        float(x[0]) - STEP * middle, STEP, float(y[0]) + STEP * middle, -STEP, size, size
    )
    values = np.full((size, size), 290.0, np.float32)
    return Disk(cold_tops.SATELLITE, "bt", HIMAWARI, grid, values, 2.0)


def cell(disk: Disk, row: int, col: int) -> np.ndarray:
    return disk.values[row * CELL : (row + 1) * CELL, col * CELL : (col + 1) * CELL]


def test_a_cold_cell_lands_under_its_top() -> None:
    top_km = (300.0 - 200.0) / 6.5
    disk = disk_around(25.0, 115.0, top_km)
    cell(disk, 1, 1)[:] = 200.0
    tops = cold_tops.detect(disk, composite.lapse(skin_at))
    assert len(tops) == 1
    assert tops.lat[0] == pytest.approx(25.0, abs=0.01)
    assert tops.lon[0] == pytest.approx(115.0, abs=0.01)
    assert tops.cold[0] == 1.0
    assert tops.min_bt[0] == 200.0
    naive_lat, _ = geos.ground(*disk.grid.angles(np.array([23.5]), np.array([23.5])), HIMAWARI)
    assert abs(naive_lat[0] - 25.0) > 0.05


def test_cells_need_enough_cold_pixels() -> None:
    disk = disk_around(25.0, 115.0, 12.0)
    cell(disk, 1, 1)[:2, :4] = 205.0
    cell(disk, 0, 0)[:1, :9] = 214.0
    cell(disk, 2, 2)[:, :] = 216.0
    tops = cold_tops.detect(disk, composite.lapse(skin_at))
    assert len(tops) == 1
    assert tops.cold[0] == pytest.approx(9 / CELL**2)


def test_lightning_sources_footprints_are_left_out() -> None:
    disk = disk_around(0.0, 175.0, 12.0)
    disk.values[:] = 200.0
    assert len(cold_tops.detect(disk, composite.lapse(skin_at))) == 0


def test_no_data_and_space_are_not_cold() -> None:
    disk = disk_around(25.0, 115.0, 12.0)
    disk.values[:] = np.nan
    assert len(cold_tops.detect(disk, composite.lapse(skin_at))) == 0


def test_publisher_writes_one_object_for_both_manifests() -> None:
    store = MemoryStore()
    pub = CloudPublisher(
        ObjectLiveStore(store, "live/clouds/"),
        ObjectLiveStore(store, "archive/clouds/"),
        attribution="test",
    )
    tops = cold_tops.ColdTops(
        *(np.array(v) for v in ([12.345, -8.0], [110.0, 150.5], [0.5, 1.0], [205.04, 199.0]))
    )
    asyncio.run(pub.publish(SLOT, "p", "gfs", {"2k": b"x"}, SLOT, tops=tops))
    live = CloudManifest.model_validate_json(
        obstore.get(store, "live/clouds/manifest.json").bytes().to_bytes()
    )
    day = ArchiveCloudManifest.model_validate_json(
        obstore.get(store, "archive/clouds/manifests/2026-11-20.json").bytes().to_bytes()
    )
    live_ref, day_ref = live.frames[0].cold_tops, day.frames[0].cold_tops
    assert live_ref is not None and day_ref is not None
    assert re.fullmatch(ARCHIVE_COLD_TOPS_PATTERN, day_ref.path)
    key = posixpath.normpath(posixpath.join("live/clouds", live_ref.path))
    assert key == posixpath.normpath(posixpath.join("archive/clouds/manifests", day_ref.path))
    data = obstore.get(store, key).bytes().to_bytes()
    assert live_ref.size_bytes == len(data) and live_ref.count == 2
    parsed = json.loads(data)
    assert parsed["satellite"] == "himawari09" and parsed["threshold_k"] == cold_tops.THRESHOLD_K
    assert parsed["tops"] == [[12.35, 110.0, 0.5, 205.0], [-8.0, 150.5, 1.0, 199.0]]


def test_frames_without_himawari_have_no_cold_tops() -> None:
    store = MemoryStore()
    pub = CloudPublisher(
        ObjectLiveStore(store, "live/clouds/"), ObjectLiveStore(store, "archive/clouds/")
    )
    frame = asyncio.run(pub.publish(SLOT, "p", "gfs", {"2k": b"x"}, SLOT))
    assert frame.cold_tops is None
