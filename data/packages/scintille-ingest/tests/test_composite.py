import asyncio
import bz2
import io
import json
import math
from datetime import UTC, datetime, timedelta
from pathlib import Path

import netCDF4
import numpy as np
import pytest
from obstore.store import MemoryStore
from PIL import Image
from scintille_contract.cloud_archive import ARCHIVE_DETAIL_PATTERN
from scintille_ingest.clouds import abi, ahi, composite, fci, geos, pyramid, tiles
from scintille_ingest.clouds.collector import CompositeCollector, hour_slots
from scintille_ingest.clouds.disk import Disk, bilinear, mapped
from scintille_ingest.clouds.gfs import SkinTemperature
from scintille_ingest.clouds.publish import ArchiveCloudManifest, CloudManifest, CloudPublisher
from scintille_ingest.clouds.sources import Sources
from scintille_ingest.clouds.sun import cos_zenith, subsolar_point
from scintille_ingest.mtg.discovery import Listed
from scintille_ingest.runtime.live_feed import ObjectLiveStore

SLOT = datetime(2026, 10, 18, 14, tzinfo=UTC)
PRODUCT = (
    "W_XX-EUMETSAT-Darmstadt,IMG+SAT,MTI1+FCI-1C-RRAD-HRFI-FD--x-x---x_C_EUMT_20261018140243"
    "_IDPFI_OPE_20261018140006_20261018140923_N__O_0085_0000"
)
GOES_EAST = geos.View(-75.0, 35786023.0, "x")
MTG = geos.View(0.0, 35786400.0, "y")


@pytest.mark.parametrize("view", [GOES_EAST, MTG])
def test_scan_angles_and_ground_are_inverse(view: geos.View) -> None:
    lat = np.array([0.0, 38.5, -52.0, 10.0])
    lon = view.lon + np.array([0.0, 12.0, -40.0, 60.0])
    x, y, cos_vza = geos.scan_angles(lat, lon, 0.0, view)
    back_lat, back_lon = geos.ground(x, y, view)
    np.testing.assert_allclose(back_lat, lat, atol=1e-6)
    np.testing.assert_allclose(back_lon, (lon + 180) % 360 - 180, atol=1e-6)
    assert cos_vza[0] == pytest.approx(1.0)
    assert np.all(np.diff(cos_vza[[0, 1, 3]]) < 0)


def test_points_behind_the_limb_face_away() -> None:
    _, _, cos_vza = geos.scan_angles(
        np.array([0.0]), np.array([GOES_EAST.lon + 100]), 0.0, GOES_EAST
    )
    assert cos_vza[0] < 0
    lat, _ = geos.ground(np.array([0.2]), np.array([0.0]), GOES_EAST)
    assert np.isnan(lat[0])


def test_higher_points_appear_further_from_the_sub_satellite_point() -> None:
    lat, lon = np.array([30.0]), np.array([GOES_EAST.lon + 20])
    x0, y0, _ = geos.scan_angles(lat, lon, 0.0, GOES_EAST)
    x1, y1, _ = geos.scan_angles(lat, lon, 12_000.0, GOES_EAST)
    assert abs(x1[0]) > abs(x0[0]) and abs(y1[0]) > abs(y0[0])


def test_bilinear_is_exact_on_nodes_and_unknown_outside() -> None:
    grid = np.arange(12, dtype=np.float32).reshape(3, 4)
    values = bilinear(grid, np.array([0.0, 1.5, -0.1, 2.0]), np.array([0.0, 2.5, 0.0, 3.5]))
    assert values[0] == 0 and values[1] == pytest.approx(8.5)
    assert np.isnan(values[2]) and np.isnan(values[3])


def test_subsolar_point_follows_the_seasons() -> None:
    lat, lon = subsolar_point(datetime(2026, 3, 20, 12, tzinfo=UTC))
    assert abs(lat) < 0.5 and 0 < lon < 3
    lat, _ = subsolar_point(datetime(2026, 6, 21, 12, tzinfo=UTC))
    assert lat == pytest.approx(23.44, abs=0.05)
    cos = cos_zenith(np.array([0.0]), np.array([0.0]), (0.0, 0.0))
    assert cos[0] == pytest.approx(1.0)


def abi_file(path: Path, band: int, size: int = 64) -> Path:
    with netCDF4.Dataset(path, "w") as ds:
        ds.createDimension("y", size)
        ds.createDimension("x", size)
        ds.createDimension("band", 1)
        projection = ds.createVariable("goes_imager_projection", "i4")
        projection.longitude_of_projection_origin = -75.0
        projection.perspective_point_height = 35786023.0
        band_id = ds.createVariable("band_id", "i1", ("band",))
        band_id[:] = band
        step = 0.15 / size * 2
        for name, offset, scale in (("x", -0.15, step), ("y", 0.15, -step)):
            var = ds.createVariable(name, "i2", (name,))
            var.scale_factor = np.float32(scale)
            var.add_offset = np.float32(offset)
            var[:] = np.arange(size) * scale + offset
        rad = ds.createVariable("Rad", "i2", ("y", "x"), fill_value=np.int16(4095))
        rad.set_auto_maskandscale(False)
        rad.scale_factor = np.float32(0.5)
        rad.add_offset = np.float32(0.0)
        counts = np.full((size, size), 20, np.int16)
        counts[0, 0] = 4095
        rad[:] = counts
        if band == 2:
            ds.createVariable("kappa0", "f4")[()] = 0.01
        else:
            for name, value in (
                ("planck_fk1", 10000.0),
                ("planck_fk2", 1300.0),
                ("planck_bc1", 0.0),
                ("planck_bc2", 1.0),
            ):
                ds.createVariable(name, "f4")[()] = value
    return path


def test_abi_band_2_becomes_1_km_reflectance(tmp_path: Path) -> None:
    disk = abi.read(abi_file(tmp_path / "c02.nc", 2), "goes19")
    assert disk.kind == "reflectance" and disk.values.shape == (32, 32)
    assert np.isnan(disk.values[0, 0]) and disk.values[5, 5] == pytest.approx(0.1, abs=1e-3)
    assert disk.grid.dx == pytest.approx(2 * 0.15 / 64 * 2, rel=1e-3)


def test_abi_band_13_becomes_brightness_temperature(tmp_path: Path) -> None:
    disk = abi.read(abi_file(tmp_path / "c13.nc", 13), "goes19", mapped(tmp_path))
    expected = 1300.0 / math.log(10000.0 / 10.0 + 1)
    assert disk.kind == "bt" and disk.values[3, 3] == pytest.approx(expected, rel=1e-4)
    assert isinstance(disk.values, np.memmap)


def test_mapped_disks_travel_by_file_name(tmp_path: Path) -> None:
    import pickle

    disk = abi.read(abi_file(tmp_path / "c13.nc", 13), "goes19", mapped(tmp_path))
    data = pickle.dumps(disk)
    assert len(data) < 2000
    assert np.array_equal(pickle.loads(data).values, disk.values, equal_nan=True)


def ahi_segment(band: int, segment: int, rows: int = 8, cols: int = 16) -> bytes:
    blocks = []
    b2 = np.zeros(1, ahi._BLOCK2)
    b2[0] = (2, ahi._BLOCK2.itemsize, 16, cols, rows)
    b3 = np.zeros(1, ahi._BLOCK3)
    b3[0] = (
        3,
        ahi._BLOCK3.itemsize,
        140.7,
        1_000_000,
        1_000_000,
        cols / 2 + 0.5,
        rows + 0.5,
        42164.0,
    )
    calibration = ahi._BLOCK5_VISIBLE if band <= 6 else ahi._BLOCK5
    b5 = np.zeros(1, calibration)
    if band <= 6:
        b5[0] = (
            5,
            calibration.itemsize,
            band,
            0.64,
            11,
            65535,
            65534,
            0.5,
            0.0,
            0.002,
            0.0,
            0.0,
            0.0,
        )
    else:
        b5[0] = (
            5,
            calibration.itemsize,
            band,
            10.4,
            12,
            65535,
            65534,
            0.01,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            1.0,
            0.0,
            2.99792458e8,
            6.62606957e-34,
            1.3806488e-23,
        )
    b7 = np.zeros(1, ahi._BLOCK7)
    b7[0] = (7, ahi._BLOCK7.itemsize, 2, segment, 1 + (segment - 1) * rows)
    for block in (b2, b3, b5, b7):
        blocks.append(block.tobytes())
    b1 = np.zeros(1, ahi._BLOCK1)
    header = ahi._BLOCK1.itemsize + sum(len(b) for b in blocks)
    b1[0]["number"], b1[0]["length"], b1[0]["header_length"] = 1, ahi._BLOCK1.itemsize, header
    counts = np.full((rows, cols), 400, np.uint16)
    counts[0, 0] = 65534
    return bz2.compress(b1.tobytes() + b"".join(blocks) + counts.tobytes())


def test_ahi_segments_are_stacked_north_to_south(tmp_path: Path) -> None:
    paths = []
    for segment in (2, 1):
        path = tmp_path / f"b13_s{segment}.bz2"
        path.write_bytes(ahi_segment(13, segment))
        paths.append(path)
    disk = ahi.read(paths, "himawari09")
    assert disk.values.shape == (16, 16) and disk.kind == "bt"
    assert np.isnan(disk.values[0, 0]) and np.isnan(disk.values[8, 0])
    assert np.nanstd(disk.values) < 1e-3
    assert disk.grid.dy < 0 < disk.grid.dx


def test_ahi_band_3_is_halved(tmp_path: Path) -> None:
    path = tmp_path / "b03.bz2"
    path.write_bytes(ahi_segment(3, 1))
    disk = ahi.read([path], "himawari09")
    assert disk.kind == "reflectance" and disk.values.shape == (8, 8)
    assert float(disk.values[3, 3]) == pytest.approx(0.4, abs=1e-3)


def fci_chunk(path: Path, channel: str, size: int, first_row: int, rows: int) -> Path:
    with netCDF4.Dataset(path, "w") as ds:
        projection = ds.createGroup("data").createVariable("mtg_geos_projection", "i4")
        projection.longitude_of_projection_origin = 0.0
        projection.perspective_point_height = 35786400.0
        group = ds.createGroup(f"data/{channel}/measured")
        group.createDimension("x", size)
        group.createDimension("y", rows)
        step = 0.3 / size
        for name, length, scale, offset in (("x", size, -step, 0.15), ("y", rows, step, -0.15)):
            var = group.createVariable(name, "i2", (name,))
            var.set_auto_maskandscale(False)
            var.scale_factor = scale
            var.add_offset = offset
            var[:] = np.arange(length) + (1 if name == "x" else first_row)
        radiance = group.createVariable("effective_radiance", "u2", ("y", "x"), fill_value=65535)
        radiance.set_auto_maskandscale(False)
        radiance.scale_factor = np.float32(0.1)
        radiance.add_offset = np.float32(0.0)
        radiance[:] = np.full((rows, size), 1000, np.uint16)
        for name, position in (
            ("start_position_row", first_row),
            ("start_position_column", 1),
            ("end_position_row", first_row + rows - 1),
            ("end_position_column", size),
        ):
            group.createVariable(name, "u2")[()] = position
        for name, value in (
            ("radiance_to_bt_conversion_coefficient_wavenumber", 952.0),
            ("radiance_to_bt_conversion_coefficient_a", 1.0),
            ("radiance_to_bt_conversion_coefficient_b", 0.0),
            ("radiance_to_bt_conversion_constant_c1", 1.19104e-5),
            ("radiance_to_bt_conversion_constant_c2", 1.4387752),
            ("channel_effective_solar_irradiance", 500.0),
        ):
            group.createVariable(name, "f4")[()] = value
        state = ds.createGroup("state/celestial")
        state.createDimension("index", 2)
        state.createVariable("earth_sun_distance", "f4", ("index",))[:] = [149_597_870.7] * 2
    return path


def test_fci_chunks_land_on_their_rows_with_east_growing_angles(tmp_path: Path) -> None:
    chunk = fci_chunk(tmp_path / "c2.nc", fci.INFRARED, 32, 17, 16)
    disk = fci.read([chunk], fci.INFRARED)
    assert np.all(np.isnan(disk.values[:16])) and np.all(np.isfinite(disk.values[16:]))
    assert disk.grid.dx > 0 and disk.grid.x0 < 0 and disk.grid.dy > 0
    assert 200 < float(np.nanmean(disk.values, dtype=np.float64)) < 300


def test_fci_visible_is_reflectance_factor(tmp_path: Path) -> None:
    chunk = fci_chunk(tmp_path / "c1.nc", fci.VISIBLE, 32, 1, 32)
    disk = fci.read([chunk], fci.VISIBLE)
    assert disk.values.shape == (16, 16)
    assert float(disk.values[4, 4]) == pytest.approx(math.pi * 100 / 500, rel=1e-3)


def test_fci_product_start() -> None:
    assert fci.product_start(PRODUCT) == datetime(2026, 10, 18, 14, 0, 6, tzinfo=UTC)


def uniform_disk(
    view: geos.View, value: float, kind: str = "bt", size: int = 256, km: float = 2.0
) -> Disk:
    step = 0.3 / size
    grid = geos.Grid(-0.15 + step / 2, step, 0.15 - step / 2, -step, size, size)
    return Disk("test", kind, view, grid, np.full((size, size), value, np.float32), km)  # type: ignore[arg-type]


def skin_at(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    return np.full(np.shape(lat), 300.0, np.float32)


def test_blend_weights_the_better_view_and_reports_coverage() -> None:
    east = composite.Satellite(
        uniform_disk(GOES_EAST, 260.0),
        None,
        composite.heights(uniform_disk(GOES_EAST, 260.0), composite.lapse(skin_at)),
    )
    mtg = composite.Satellite(
        uniform_disk(MTG, 220.0, km=1.0),
        None,
        composite.heights(uniform_disk(MTG, 220.0), composite.lapse(skin_at)),
    )
    lat = np.array([[0.0, 0.0, 0.0]])
    lon = np.array([[-75.0, -37.5, 0.0]])
    fields = composite.blend(lat, lon, [east, mtg])
    assert fields.bt[0, 0] == pytest.approx(260.0, abs=0.5)
    assert fields.bt[0, 2] == pytest.approx(220.0, abs=0.5)
    assert 220 < fields.bt[0, 1] < 260
    assert np.all(fields.coverage == 1)
    assert fields.fine[0, 2] == pytest.approx(1.0) and fields.fine[0, 0] == pytest.approx(
        0.0, abs=1e-3
    )


def test_visible_detail_never_adds_cloud_to_clear_sky() -> None:
    bt = np.full((1, 5), 300.0, np.float32)
    reflectance = np.array([[0.05, 0.4, 0.05, 0.6, 0.05]], np.float32)
    fields = composite.Fields(bt, reflectance, np.ones_like(bt), np.zeros_like(bt))
    value, fine = composite.opacity(fields, np.full_like(bt, 300.0), np.ones_like(bt))
    assert np.all(value == 0) and np.all(fine == 1)
    cloudy = composite.Fields(bt - 20, reflectance, np.ones_like(bt), np.zeros_like(bt))
    value, _ = composite.opacity(cloudy, np.full_like(bt, 300.0), np.ones_like(bt))
    assert value[0, 1] > value[0, 2] and value[0, 3] > value[0, 2]


def test_fallback_fills_where_no_disk_sees() -> None:
    bt = np.full((1, 2), np.nan, np.float32)
    fields = composite.Fields(bt, bt, np.zeros_like(bt), np.zeros_like(bt))
    value, fine = composite.opacity(
        fields, np.full_like(bt, 300.0), np.ones_like(bt), np.full_like(bt, 0.7)
    )
    assert np.allclose(value, 0.7) and np.all(fine == 0)


def test_tile_geometry() -> None:
    lat, lon = tiles.centers(5, 32, 9, 2)
    assert lat.size == lon.size == tiles.TILE + 4
    assert lat[2] == pytest.approx(90 - 9 * 5.625 - tiles.texel_degrees(5) / 2)
    assert lon[2] == pytest.approx(-180 + 32 * 5.625 + tiles.texel_degrees(5) / 2)
    assert tiles.in_band(5, 3) and not tiles.in_band(5, 2) and not tiles.in_band(4, 0)
    keys = {tiles.Key(5, 9, 32), tiles.Key(5, 0, 63), tiles.Key(4, 1, 1)}
    assert tiles.from_bitmap(tiles.bitmap(keys, 5), 5) == {k for k in keys if k.z == 5}


def test_block_renders_every_level_and_level_3_averages_level_4() -> None:
    disk = uniform_disk(GOES_EAST, 250.0)
    satellite = composite.Satellite(disk, None, composite.heights(disk, composite.lapse(skin_at)))
    skin = np.full((721, 1440), 300.0, np.float32)
    inputs = pyramid.Inputs((satellite,), skin, subsolar_point(SLOT))
    block = pyramid.block(inputs, 4, 3)
    levels = sorted({k.z for k in block.tiles})
    assert levels == [3, 4, 5]
    image = Image.open(io.BytesIO(block.tiles[tiles.Key(3, 3, 4)])).convert("L")
    assert image.size == (tiles.TILE + 2 * tiles.BORDER,) * 2
    assert block.overview is not None and block.overview.shape == (tiles.TILE, tiles.TILE)


def test_block_publishes_heights_of_levels_3_and_4() -> None:
    disk = uniform_disk(GOES_EAST, 250.0)
    top_at = composite.lapse(skin_at)
    satellite = composite.Satellite(disk, None, composite.heights(disk, top_at))
    inputs = pyramid.Inputs((satellite,), np.full((721, 1440), 300.0, np.float32), (0.0, 0.0))
    block = pyramid.block(inputs, 4, 3)
    assert {k.z for k in block.heights} == {3, 4}
    assert set(block.heights) == {k for k in block.tiles if k.z in (3, 4)}
    decoded = tiles.decode_height(block.heights[tiles.Key(3, 3, 4)])
    assert decoded.shape == (tiles.TILE + 2 * tiles.BORDER,) * 2
    assert float(np.median(decoded)) == pytest.approx(50 / 6.5, abs=0.2)


def publisher() -> tuple[CloudPublisher, MemoryStore]:
    store = MemoryStore()
    return (
        CloudPublisher(
            ObjectLiveStore(store, "live/clouds/"),
            ObjectLiveStore(store, "archive/clouds/"),
            attribution="test",
        ),
        store,
    )


def test_detail_tiles_are_written_once_and_both_manifests_point_to_them() -> None:
    import posixpath
    import re

    import obstore

    pub, store = publisher()
    detail = {tiles.Key(3, 2, 8): b"a", tiles.Key(5, 9, 32): b"bb"}
    asyncio.run(pub.publish(SLOT, "composite-v1", "gfs", {"2k": b"x", "4k": b"y"}, SLOT, detail))
    keys = {m["path"] for batch in obstore.list(store) for m in batch}
    packs = [k for k in keys if "/detail/" in k]
    assert len(packs) == 1 and packs[0].startswith("archive/clouds/detail/2026/10/18/")
    data = obstore.get(store, packs[0]).bytes().to_bytes()
    assert tiles.unpack(data, tiles.Key(5, 9, 32)) == b"bb"
    assert tiles.unpack(data, tiles.Key(4, 1, 1)) is None
    live = CloudManifest.model_validate_json(
        obstore.get(store, "live/clouds/manifest.json").bytes().to_bytes()
    )
    ref = live.frames[0].detail
    assert ref is not None and ref.size_bytes == len(data) and ref.index_bytes == 2688 * 8
    assert posixpath.normpath(posixpath.join("live/clouds", ref.path)) == packs[0]
    assert tiles.from_bitmap(ref.fine, 5) == {tiles.Key(5, 9, 32)}
    assert live.attribution == "test"
    archived = ArchiveCloudManifest.model_validate_json(
        obstore.get(store, "archive/clouds/manifests/2026-10-18.json").bytes().to_bytes()
    )
    archived_ref = archived.frames[0].detail
    assert archived_ref is not None and re.fullmatch(ARCHIVE_DETAIL_PATTERN, archived_ref.path)
    resolved = posixpath.normpath(posixpath.join("archive/clouds/manifests", archived_ref.path))
    assert resolved == packs[0]


def test_detail_packs_leave_the_archive_after_a_day() -> None:
    import obstore

    pub, store = publisher()
    textures = {"2k": b"x", "4k": b"y"}
    detail = {tiles.Key(3, 2, 8): b"a"}
    asyncio.run(pub.publish(SLOT, "first", "gfs", textures, SLOT, detail))
    later = SLOT + timedelta(hours=25)
    asyncio.run(pub.publish(later, "second", "gfs", textures, later, detail))
    packs = sorted(
        m["path"] for batch in obstore.list(store, prefix="archive/clouds/detail/") for m in batch
    )
    assert len(packs) == 1 and packs[0].startswith(
        f"archive/clouds/detail/2026/10/19/{later:%Y%m%dT%H%M%SZ}-"
    )
    day = ArchiveCloudManifest.model_validate_json(
        obstore.get(store, "archive/clouds/manifests/2026-10-18.json").bytes().to_bytes()
    )
    assert day.frames[0].detail is None and day.frames[0].textures


def test_pack_index_covers_every_level() -> None:
    assert tiles.INDEX_SLOTS == 128 + 512 + 2048
    assert tiles.index_slot(tiles.Key(3, 0, 0)) == 0
    assert tiles.index_slot(tiles.Key(4, 0, 0)) == 128
    assert tiles.index_slot(tiles.Key(5, 31, 63)) == tiles.INDEX_SLOTS - 1
    data = tiles.pack({tiles.Key(4, 3, 5): b"xyz"})
    offset, length = np.frombuffer(data, "<u4", 2, tiles.index_slot(tiles.Key(4, 3, 5)) * 8)
    assert data[offset : offset + length] == b"xyz" and length == 3


class FakeFci:
    def __init__(self, products: list[Listed]) -> None:
        self.products = products

    def search(self, start: datetime, end: datetime) -> list[Listed]:
        return [p for p in self.products if start <= fci.product_start(p.product_id) < end]

    def fetch(self, product_id: str, entry: str) -> bytes:
        return entry.encode()


def goes_key(sat: str, band: str, start: datetime) -> str:
    return (
        f"ABI-L1b-RadF/{start:%Y/%j/%H}/OR_ABI-L1b-RadF-M6{band}_G{sat}_s{start:%Y%j%H%M%S}0"
        f"_e{start:%Y%j%H%M%S}0_c{start:%Y%j%H%M%S}0.nc"
    )


def sources(with_fci: bool = True, segments: int = 10) -> Sources:
    goes = {}
    for sat, number in (("goes19", "19"), ("goes18", "18")):
        store = MemoryStore()
        for band in ("C02", "C13", "C07"):
            import obstore

            obstore.put(store, goes_key(number, band, SLOT + timedelta(seconds=20)), b"nc")
        goes[sat] = store
    himawari = MemoryStore()
    import obstore

    for band in ("B03", "B13"):
        for s in range(1, segments + 1):
            obstore.put(
                himawari,
                f"AHI-L1b-FLDK/{SLOT:%Y/%m/%d/%H%M}/HS_H09_{SLOT:%Y%m%d_%H%M}_{band}_FLDK_R10_S{s:02d}10.DAT.bz2",
                b"x",
            )
    entries = tuple(
        f"CHK-BODY-{i:04d}.nc".replace("CHK-BODY-", "x-CHK-BODY-") for i in range(1, 41)
    )
    mtg = FakeFci([Listed(PRODUCT, entries)]) if with_fci else None
    return Sources(goes, himawari, mtg)


def test_slot_files_know_which_satellites_are_complete() -> None:
    complete = sources().find(SLOT)
    assert complete.complete and complete.complete_satellites == [
        "goes19",
        "goes18",
        "himawari09",
        "mtg-i1",
    ]
    partial = sources(with_fci=False, segments=9).find(SLOT)
    assert partial.complete_satellites == ["goes19", "goes18"] and not partial.complete
    assert "goes18+goes19" in partial.product


def test_download_fetches_only_complete_satellites(tmp_path: Path) -> None:
    src = sources(segments=9)
    downloaded = src.download(src.find(SLOT), tmp_path)
    assert set(downloaded) == {
        "goes19/C02",
        "goes19/C13",
        "goes18/C02",
        "goes18/C13",
        "mtg-i1/chunks",
    }
    assert len(downloaded["mtg-i1/chunks"]) == 40


def test_hour_slots() -> None:
    slots = hour_slots(datetime(2026, 10, 18, 14, 25, tzinfo=UTC), timedelta(hours=3))
    assert slots == [SLOT - timedelta(hours=2), SLOT - timedelta(hours=1), SLOT]


class Rendered(CompositeCollector):
    rendered: list[datetime]

    def _render(self, downloaded, directory, skin, fallback, slot, table=None):  # type: ignore[no-untyped-def]
        self.rendered.append(slot)
        return pyramid.Rendered({tiles.Key(3, 0, 0): b"t"}, {"2k": b"a", "4k": b"b"})


class Skin:
    async def at(self, time: datetime) -> SkinTemperature:
        return SkinTemperature(np.zeros((2, 2), np.float32), time, 0)


def collector(src: Sources, now: datetime, tmp_path: Path) -> Rendered:
    pub, _ = publisher()
    c = Rendered(src, Skin(), None, pub, tmp_path, workers=1, clock=lambda: now)  # type: ignore[arg-type]
    c.rendered = []
    return c


def test_collector_waits_for_every_satellite_until_the_deadline(tmp_path: Path) -> None:
    early = collector(sources(with_fci=False), SLOT + timedelta(minutes=20), tmp_path)
    asyncio.run(early.poll())
    assert SLOT not in early.rendered
    late = collector(sources(with_fci=False), SLOT + timedelta(minutes=50), tmp_path)
    asyncio.run(late.poll())
    assert SLOT in late.rendered
    asyncio.run(late.poll())
    assert late.rendered.count(SLOT) == 1


def test_collector_renders_complete_slots_at_once(tmp_path: Path) -> None:
    c = collector(sources(), SLOT + timedelta(minutes=16), tmp_path)
    asyncio.run(c.poll())
    assert SLOT in c.rendered
    assert not any(tmp_path.iterdir())
    manifest = json.loads(asyncio.run(c.publisher.live.get("manifest.json")) or b"{}")
    assert manifest["frames"][-1]["detail"]["levels"] == [3, 4, 5]


def test_collector_clears_work_left_by_a_restart(tmp_path: Path) -> None:
    left = tmp_path / "20261018T1300" / "raw"
    left.mkdir(parents=True)
    (left / "disk.nc").write_bytes(b"x")
    c = collector(sources(with_fci=False), SLOT + timedelta(minutes=20), tmp_path)
    c.cadence = 0.01

    async def run_once() -> None:
        task = asyncio.create_task(c.run())
        await asyncio.sleep(0.05)
        c.stop()
        await task

    asyncio.run(run_once())
    assert not (tmp_path / "20261018T1300").exists()


def test_a_failed_chunk_is_downloaded_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import time

    monkeypatch.setattr(time, "sleep", lambda _: None)
    src = sources(segments=9)
    assert src.mtg is not None
    fetch = src.mtg.fetch
    failures = {"left": 2}

    def flaky(product: str, entry: str) -> bytes:
        if failures["left"] > 0:
            failures["left"] -= 1
            raise ConnectionError("reset")
        return fetch(product, entry)

    monkeypatch.setattr(src.mtg, "fetch", flaky)
    downloaded = src.download(src.find(SLOT), tmp_path)
    assert len(downloaded["mtg-i1/chunks"]) == 40 and failures["left"] == 0
