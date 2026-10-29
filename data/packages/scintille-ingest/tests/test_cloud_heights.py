import asyncio
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import obstore
import pytest
from obstore.store import MemoryStore
from scintille_ingest.clouds import composite, profile, tiles
from scintille_ingest.clouds.publish import CloudManifest, CloudPublisher
from scintille_ingest.runtime.live_feed import ObjectLiveStore

SLOT = datetime(2026, 10, 18, 14, tzinfo=UTC)


def atmosphere(surface_m: float = 0.0, inversion: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Ground then one level per km: 300 K cooling 6.5 K/km up to a 16 km tropopause."""
    z = np.array([surface_m, *np.arange(1000.0, 21000.0, 1000.0)], np.float32)
    t = np.where(z <= 16000, 300 - 6.5 * z / 1000, 196 + 2 * (z - 16000) / 1000).astype(np.float32)
    if inversion:
        t[2] = t[0] + 1
    return z[:, None], t[:, None]


def test_tops_sit_where_the_air_is_as_cold_as_the_cloud() -> None:
    z, t = atmosphere()
    km = profile.column_heights(z, t, np.array([235.0, 300.0, 310.0], np.float32))[:, 0] / 1000
    assert km == pytest.approx([10.0, 0.0, 0.0], abs=0.01)


def test_tops_colder_than_the_tropopause_overshoot_it() -> None:
    z, t = atmosphere()
    km = profile.column_heights(z, t, np.array([189.0], np.float32))[0, 0] / 1000
    assert km == pytest.approx(16 + 7 / profile.OVERSHOOT_K_PER_KM, abs=0.01)


def test_low_tops_stay_under_an_inversion() -> None:
    z, t = atmosphere(inversion=True)
    km = profile.column_heights(z, t, np.array([296.0], np.float32))[0, 0] / 1000
    assert 0.5 < km < 1.0


def test_levels_below_the_ground_are_ignored() -> None:
    rows, cols = 361, 720
    stacked = [np.full((rows, cols), 3000.0), np.full((rows, cols), 280.0)]
    for i, _ in enumerate(profile.LEVELS_HPA):
        height = 110.0 + 600 * i
        stacked += [np.full((rows, cols), height), np.full((rows, cols), 300 - 6.5 * height / 1000)]
    table = profile.HeightTable.of(np.stack(stacked).astype(np.float32), "test")
    lat, lon = np.array([10.0, -45.3]), np.array([-179.9, 359.9])
    km = table.at(np.array([280.0, np.nan], np.float32), lat, lon)
    assert km[0] == pytest.approx(3.0, abs=0.1) and np.isnan(km[1])
    colder = table.at(np.array([270.0], np.float32), lat[:1], lon[:1])[0]
    assert 3.0 < colder < 3.0 + 10 / 6.5 + 0.2


def test_profile_candidates_are_three_hourly() -> None:
    pairs = profile.candidates(datetime(2026, 10, 10, 13, tzinfo=UTC))
    assert [(c.hour, h) for c, h in pairs][:2] == [(12, 0), (6, 6)]
    assert profile.grib_key(*pairs[0]).endswith("gfs.t12z.pgrb2.0p50.f000")


def test_clear_sky_takes_the_nearby_tops() -> None:
    height = np.full((40, 40), 0.0, np.float32)
    height[15:25, 15:25] = 12.0
    opacity = np.zeros_like(height)
    opacity[15:25, 15:25] = 1
    filled = composite.fill_tops(height, opacity)
    assert filled[20, 20] == 12 and filled[20, 27] == pytest.approx(12, abs=0.01)
    assert filled[0, 0] == pytest.approx(12, abs=0.5) or filled[0, 0] == composite.DEFAULT_TOP_KM


def test_heights_follow_the_opacity_index_without_moving_it() -> None:
    opacity = {tiles.Key(4, 3, 5): b"op", tiles.Key(5, 9, 32): b"fine"}
    heights = {tiles.Key(4, 3, 5): b"top", tiles.Key(3, 1, 2): b"t3"}
    data = tiles.pack(opacity, heights)
    assert tiles.unpack(data, tiles.Key(4, 3, 5)) == b"op"
    assert tiles.unpack(data, tiles.Key(5, 9, 32)) == b"fine"
    assert tiles.unpack_height(data, tiles.Key(4, 3, 5)) == b"top"
    assert tiles.unpack_height(data, tiles.Key(3, 1, 2)) == b"t3"
    assert tiles.unpack_height(data, tiles.Key(4, 0, 0)) is None
    assert tiles.HEIGHT_SLOTS == 128 + 512
    assert len(tiles.pack(opacity)) == tiles.INDEX_SLOTS * 8 + 6


def test_height_tiles_round_trip_within_a_step() -> None:
    km = np.linspace(0, 20, 64 * 64, dtype=np.float32).reshape(64, 64)
    decoded = tiles.decode_height(tiles.encode_height(km))
    assert np.abs(decoded - km).mean() < 0.15


def test_manifest_describes_the_height_index() -> None:
    store = MemoryStore()
    pub = CloudPublisher(
        ObjectLiveStore(store, "live/clouds/"),
        ObjectLiveStore(store, "archive/clouds/"),
        attribution="test",
    )
    detail = {tiles.Key(3, 2, 8): b"a"}
    heights = {tiles.Key(3, 2, 8): b"h"}
    textures = {"2k": b"x", "4k": b"y"}
    asyncio.run(pub.publish(SLOT, "c", "gfs", textures, SLOT, detail, heights, "gfs 0p50"))
    live = CloudManifest.model_validate_json(
        obstore.get(store, "live/clouds/manifest.json").bytes().to_bytes()
    )
    ref = live.frames[0].detail
    assert ref is not None and ref.index_bytes == tiles.INDEX_SLOTS * 8
    assert ref.height is not None and ref.height.levels == [3, 4]
    assert ref.height.index_offset == tiles.INDEX_SLOTS * 8
    assert ref.height.index_bytes == 640 * 8 and ref.height.reference == "gfs 0p50"


def test_mapped_tables_travel_by_file_name(tmp_path: Path) -> None:
    import pickle

    km = np.arange(2 * 3 * 4, dtype=np.float16).reshape(2, 3, 4)
    table = profile.HeightTable(km, "test").mapped(tmp_path / "tops.npy")
    data = pickle.dumps(table)
    assert len(data) < 1000
    copy = pickle.loads(data)
    assert copy.label == "test" and np.array_equal(copy.km, km)
