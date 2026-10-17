import asyncio
import io
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import eccodes  # type: ignore[import-untyped]
import netCDF4
import numpy as np
import obstore
import pytest
from obstore.store import MemoryStore
from PIL import Image
from scintille_ingest.clouds import gfs, gmgsi
from scintille_ingest.clouds.collector import CloudCollector
from scintille_ingest.clouds.gfs import GfsSkin, SkinTemperature
from scintille_ingest.clouds.gmgsi import Mosaic, counts_to_kelvin, parse_key, read_mosaic
from scintille_ingest.clouds.publish import (
    ATTRIBUTION,
    MANIFEST_HEADERS,
    TEXTURE_HEADERS,
    ArchiveCloudManifest,
    CloudManifest,
    CloudPublisher,
)
from scintille_ingest.clouds.texture import TIERS, encode_tiers, opacity, pixel_centers
from scintille_ingest.runtime.live_feed import ObjectLiveStore

T0 = datetime(2026, 10, 10, 0, tzinfo=UTC)
NAME = "GLOBCOMPLIR_v3r0_blend_s202610100000000_e202610100009599_c202610100034153.nc"


def gmgsi_name(time: datetime, created: datetime) -> str:
    return (
        f"GLOBCOMPLIR_v3r0_blend_s{time:%Y%m%d%H%M%S}0_e{time:%Y%m%d%H}09599"
        f"_c{created:%Y%m%d%H%M%S}0.nc"
    )


def gmgsi_file(counts: np.ndarray, lat: np.ndarray, lon: np.ndarray) -> bytes:
    """A GMGSI-shaped netCDF: 2-D lat/lon, counts as float, a fill row in `dqf`."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "g.nc"
        with netCDF4.Dataset(path, "w") as ds:
            ds.createDimension("time", 1)
            ds.createDimension("yc", lat.size)
            ds.createDimension("xc", lon.size)
            data = ds.createVariable("data", "f4", ("time", "yc", "xc"), fill_value=-9999.0)
            dqf = ds.createVariable("dqf", "i1", ("time", "yc", "xc"), fill_value=-128)
            ds.createVariable("lat", "f4", ("yc", "xc"))[:] = np.repeat(lat[:, None], lon.size, 1)
            ds.createVariable("lon", "f4", ("yc", "xc"))[:] = np.repeat(lon[None, :], lat.size, 0)
            data[0] = counts
            flags = np.zeros(counts.shape, np.int8)
            flags[-1] = -128
            dqf[0] = flags
        return path.read_bytes()


def mercator_lat(n: int, edge: float = 72.7) -> np.ndarray:
    y = np.linspace(np.arcsinh(np.tan(np.radians(edge))), -np.arcsinh(np.tan(np.radians(edge))), n)
    return np.degrees(np.arctan(np.sinh(y)))


def gmgsi_lon(n: int) -> np.ndarray:
    """Like the real files: the first column holds +180, then -180 + step onwards."""
    lon = -180 + np.arange(1, n + 1) * 360 / n
    return np.roll(lon, 1)


def uniform_skin(kelvin: float) -> SkinTemperature:
    return SkinTemperature(np.full((721, 1440), kelvin, np.float32), T0 - timedelta(hours=6), 6)


def grib_message(values: np.ndarray, north_first: bool = True) -> bytes:
    handle = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
    try:
        nj, ni = values.shape
        for key, value in {
            "Ni": ni,
            "Nj": nj,
            "iDirectionIncrementInDegrees": 360 / ni,
            "jDirectionIncrementInDegrees": 180 / (nj - 1),
            "longitudeOfFirstGridPointInDegrees": 0.0,
            "longitudeOfLastGridPointInDegrees": 360 - 360 / ni,
            "latitudeOfFirstGridPointInDegrees": 90.0 if north_first else -90.0,
            "latitudeOfLastGridPointInDegrees": -90.0 if north_first else 90.0,
            "jScansPositively": 0 if north_first else 1,
        }.items():
            eccodes.codes_set(handle, key, value)
        eccodes.codes_set_values(handle, (values if north_first else values[::-1]).ravel())
        return bytes(eccodes.codes_get_message(handle))
    finally:
        eccodes.codes_release(handle)


# GMGSI


def test_parse_key() -> None:
    product = parse_key(f"GMGSI_LW/2026/10/10/00/{NAME}")
    assert product is not None
    assert product.time == T0
    assert product.created == datetime(2026, 10, 10, 0, 34, 15, tzinfo=UTC)
    assert product.name == NAME
    assert parse_key("GMGSI_LW/2026/10/10/00/GLOBCOMPSSR_v3r0_blend_s2026.nc") is None
    assert gmgsi.hour_prefix(T0) == "GMGSI_LW/2026/10/10/00/"


def test_counts_to_kelvin_follows_the_mcidas_ir_scale() -> None:
    kelvin = counts_to_kelvin(np.array([0, 80, 176, 177, 255], np.float32))
    np.testing.assert_allclose(kelvin, [330, 290, 242, 241, 163])


def test_read_mosaic_sorts_longitudes_and_masks_fill() -> None:
    lat, lon = mercator_lat(40), gmgsi_lon(80)
    counts = np.tile(np.arange(80, dtype=np.float32), (40, 1))
    mosaic = read_mosaic(gmgsi_file(counts, lat, lon))
    assert np.all(np.diff(mosaic.lon) > 0) and np.all(np.diff(mosaic.lat) < 0)
    assert mosaic.lon[-1] == pytest.approx(180)
    # The +180 column came first in the file; it is now last.
    assert mosaic.bt[0, -1] == pytest.approx(330)
    assert mosaic.bt[0, 0] == pytest.approx(330 - 0.5)
    assert np.isnan(mosaic.bt[-1]).all()


def test_list_products_keeps_the_newest_file_per_hour() -> None:
    store = MemoryStore()
    old = gmgsi_name(T0, T0 + timedelta(minutes=34))
    revised = gmgsi_name(T0, T0 + timedelta(minutes=50))
    nxt = gmgsi_name(T0 + timedelta(hours=1), T0 + timedelta(hours=1, minutes=34))
    for key in (f"GMGSI_LW/2026/10/10/00/{old}", f"GMGSI_LW/2026/10/10/00/{revised}"):
        obstore.put(store, key, b"x")
    obstore.put(store, f"GMGSI_LW/2026/10/10/01/{nxt}", b"x")
    obstore.put(store, "GMGSI_LW/2026/10/10/01/readme.txt", b"x")
    products = gmgsi.list_products(store, T0 + timedelta(hours=1, minutes=40), hours=3)
    assert [p.name for p in products] == [revised, nxt]
    assert all(p.last_modified is not None and p.etag for p in products)


# GFS


INDEX = (
    "1:0:d=2026101000:PRMSL:mean sea level:6 hour fcst:\n"
    "562:398000000:d=2026101000:VGRD:planetary boundary layer:6 hour fcst:\n"
    "563:399364535:d=2026101000:TMP:surface:6 hour fcst:\n"
    "564:399941845:d=2026101000:TSOIL:0-0.1 m below ground:6 hour fcst:\n"
)


def test_field_range() -> None:
    assert gfs.field_range(INDEX) == (399364535, 399941845)
    assert gfs.field_range(INDEX, ":TSOIL:0-0.1 m below ground:") == (399941845, None)
    with pytest.raises(KeyError):
        gfs.field_range(INDEX, ":TMP:2 m above ground:")


def test_candidates_newest_cycle_first() -> None:
    pairs = gfs.candidates(datetime(2026, 10, 10, 13, tzinfo=UTC))
    assert [(c.hour, h) for c, h in pairs] == [(12, 1), (6, 7), (0, 13), (18, 19)]
    assert gfs.grib_key(*pairs[0]) == "gfs.20261010/12/atmos/gfs.t12z.pgrb2.0p25.f001"


@pytest.mark.parametrize("north_first", [True, False])
def test_decode_field_returns_north_first(north_first: bool) -> None:
    values = np.linspace(200, 320, 19, dtype=np.float32)[:, None] * np.ones((1, 36), np.float32)
    decoded = gfs.decode_field(grib_message(values, north_first))
    assert decoded.shape == (19, 36)
    np.testing.assert_allclose(decoded, values, atol=0.01)


def gfs_store(cycle: datetime, hours: int, kelvin: float) -> MemoryStore:
    store = MemoryStore()
    message = grib_message(np.full((19, 36), kelvin, np.float32))
    key = gfs.grib_key(cycle, hours)
    obstore.put(store, key, b"PAD" + message + b"TAIL")
    index = f"1:0:d=x:PRMSL:sea:\n2:3:d=x:TMP:surface:\n3:{3 + len(message)}:d=x:TSOIL:\n"
    obstore.put(store, key + ".idx", index.encode())
    return store


def test_gfs_skin_falls_back_to_an_older_cycle() -> None:
    valid = datetime(2026, 10, 10, 13, tzinfo=UTC)
    skin = GfsSkin(gfs_store(datetime(2026, 10, 10, 6, tzinfo=UTC), 7, 290.0))
    field = asyncio.run(skin.at(valid + timedelta(minutes=9)))
    assert field.label == "gfs 2026101006 f007"
    assert field.valid_time == valid
    assert float(field.values.mean()) == pytest.approx(290.0, abs=0.01)


def test_gfs_skin_reuses_a_recent_field_when_gfs_is_missing() -> None:
    skin = GfsSkin(gfs_store(T0, 1, 280.0))
    first = asyncio.run(skin.at(T0 + timedelta(hours=1)))
    assert asyncio.run(skin.at(T0 + timedelta(hours=2))) is first
    with pytest.raises(LookupError):
        asyncio.run(skin.at(T0 + timedelta(days=2)))


# Texture


def test_opacity_against_the_surface_temperature() -> None:
    lat, lon = mercator_lat(300), np.sort(gmgsi_lon(600))
    bt = np.full((300, 600), 260.0, np.float32)
    bt[:, 300:] = 299.0
    bt[150, 10] = np.nan
    value = opacity(Mosaic(bt, lat, lon), uniform_skin(300.0), 512)
    out_lat, out_lon = pixel_centers(512)
    tropics = np.abs(out_lat) < 60
    cold = value[tropics][:, (out_lon > -170) & (out_lon < -10)]
    assert (cold > 0.999).mean() > 0.99
    assert value[128, np.argmin(np.abs(out_lon - (lon[10])))] == 0.0
    assert value[tropics][:, out_lon > 10].max() == 0.0
    assert value[np.abs(out_lat) > 72.7].max() == 0.0
    assert 0 < value[np.argmin(np.abs(out_lat - 70)), 100] < 1
    assert value.dtype == np.float32 and value.shape == (256, 512)


def test_opacity_has_no_seam_at_the_antimeridian() -> None:
    lat, lon = mercator_lat(200), np.sort(gmgsi_lon(720))
    ramp = 300 - 30 * (1 + np.cos(np.radians(lon))) / 2
    bt = np.tile(ramp.astype(np.float32), (200, 1))
    value = opacity(Mosaic(bt, lat, lon), uniform_skin(300.0), 1024)
    row = value[256]
    steps = np.abs(np.diff(np.concatenate([row, row[:1]])))
    assert steps[-1] <= steps[:-1].max() + 1e-4


def test_encode_tiers() -> None:
    value = np.zeros((2048, 4096), np.float32)
    value[:, :2048] = 1
    textures = encode_tiers(value)
    assert set(textures) == set(TIERS)
    for tier, data in textures.items():
        image = Image.open(io.BytesIO(data))
        assert image.format == "WEBP"
        assert image.size == (TIERS[tier], TIERS[tier] // 2)
        pixels = np.asarray(image.convert("L"))
        assert pixels[10, 10] > 250 and pixels[10, -10] < 5


# Publishing


def publisher() -> tuple[CloudPublisher, MemoryStore]:
    store = MemoryStore()
    return (
        CloudPublisher(
            ObjectLiveStore(store, "live/clouds/"), ObjectLiveStore(store, "archive/clouds/")
        ),
        store,
    )


def keys(store: MemoryStore) -> set[str]:
    return {meta["path"] for batch in obstore.list(store) for meta in batch}


def manifest(store: MemoryStore) -> CloudManifest:
    return CloudManifest.model_validate_json(
        obstore.get(store, "live/clouds/manifest.json").bytes().to_bytes()
    )


TEXTURES = {"2k": b"two", "4k": b"four!"}


def test_publish_writes_textures_archive_and_manifest() -> None:
    pub, store = publisher()
    now = T0 + timedelta(minutes=40)
    frame = asyncio.run(pub.publish(T0, NAME, "gfs 2026100918 f006", TEXTURES, now))
    name = frame.textures["2k"].path.split("/")[-1]
    assert name.startswith("20261010T000000Z-") and name.endswith(".webp")
    assert keys(store) == {
        "live/clouds/manifest.json",
        f"live/clouds/2k/{name}",
        f"live/clouds/4k/{name}",
        f"archive/clouds/2k/2026/10/10/{name}",
        f"archive/clouds/4k/2026/10/10/{name}",
        "archive/clouds/manifests/2026-10-10.json",
    }
    m = manifest(store)
    assert m.attribution == ATTRIBUTION and m.window_seconds == 6 * 3600
    assert [f.time for f in m.frames] == [T0]
    assert m.frames[0].textures["4k"].model_dump() == {
        "path": f"4k/{name}",
        "width": 4096,
        "height": 2048,
        "size_bytes": 5,
    }
    attrs = obstore.get(store, f"live/clouds/2k/{name}").attributes
    assert attrs["Cache-Control"] == TEXTURE_HEADERS["Cache-Control"]
    assert (
        obstore.get(store, "live/clouds/manifest.json").attributes["Cache-Control"]
        == (MANIFEST_HEADERS["Cache-Control"])
    )


def test_publish_keeps_a_six_hour_window_and_the_archive() -> None:
    pub, store = publisher()
    for h in range(8):
        time = T0 + timedelta(hours=h)
        asyncio.run(pub.publish(time, gmgsi_name(time, time), "gfs", TEXTURES, time))
    m = manifest(store)
    assert [f.time.hour for f in m.frames] == [2, 3, 4, 5, 6, 7]
    live = {k for k in keys(store) if k.startswith("live/clouds/2k/")}
    assert len(live) == 7
    assert len({k for k in keys(store) if k.startswith("archive/clouds/2k/")}) == 8


def test_revised_product_gets_a_new_path_and_replaces_the_frame() -> None:
    pub, store = publisher()
    first = asyncio.run(pub.publish(T0, gmgsi_name(T0, T0), "gfs", TEXTURES, T0))
    again = asyncio.run(
        pub.publish(T0, gmgsi_name(T0, T0 + timedelta(minutes=5)), "gfs", TEXTURES, T0)
    )
    assert first.textures["2k"].path != again.textures["2k"].path
    assert [f.product for f in manifest(store).frames] == [again.product]
    assert f"live/clouds/{first.textures['2k'].path}" in keys(store)
    asyncio.run(pub.publish(T0 + timedelta(hours=1), NAME, "gfs", TEXTURES, T0))
    assert f"live/clouds/{first.textures['2k'].path}" not in keys(store)


def test_archive_failure_does_not_block_the_live_frame() -> None:
    store = MemoryStore()

    class Broken(ObjectLiveStore):
        async def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
            raise OSError("r2 down")

    pub = CloudPublisher(ObjectLiveStore(store, "live/clouds/"), Broken(store, "archive/"))
    asyncio.run(pub.publish(T0, NAME, "gfs", TEXTURES, T0))
    assert [f.time for f in manifest(store).frames] == [T0]


def test_restore_continues_the_published_frames() -> None:
    pub, store = publisher()
    asyncio.run(pub.publish(T0, NAME, "gfs", TEXTURES, T0))
    again = CloudPublisher(
        ObjectLiveStore(store, "live/clouds/"), ObjectLiveStore(store, "archive/clouds/")
    )
    asyncio.run(again.restore())
    assert again.published() == {T0: NAME}


def archived_manifest(store: MemoryStore, day: str = "2026-10-10") -> ArchiveCloudManifest:
    return ArchiveCloudManifest.model_validate_json(
        obstore.get(store, f"archive/clouds/manifests/{day}.json").bytes().to_bytes()
    )


def test_archive_index_survives_restart_replaces_revisions_and_resolves_only_written_textures() -> (
    None
):
    from posixpath import normpath

    pub, store = publisher()
    asyncio.run(pub.publish(T0, NAME, "gfs", TEXTURES, T0))
    again = CloudPublisher(pub.live, pub.archive)
    later = T0 + timedelta(hours=1)
    asyncio.run(again.publish(later, gmgsi_name(later, later), "gfs", TEXTURES, later))
    revision = gmgsi_name(T0, later)
    asyncio.run(again.publish(T0, revision, "gfs", TEXTURES, later))
    archived = archived_manifest(store)
    assert archived.schema_version == 1
    assert [f.time for f in archived.frames] == [T0, later]
    assert archived.frames[0].product == revision
    assert archived.frames[0].expires_at == later + timedelta(days=30)
    for frame in archived.frames:
        for texture in frame.textures.values():
            path = normpath("archive/clouds/manifests/" + texture.path)
            assert (
                obstore.get(store, path).bytes().to_bytes()
                == TEXTURES["2k" if texture.width == 2048 else "4k"]
            )


@pytest.mark.parametrize("failed_prefix", ["2k/", "4k/", "manifests/"])
def test_partial_archive_never_publishes_a_new_index_or_breaks_live(failed_prefix: str) -> None:
    pub, store = publisher()
    asyncio.run(pub.publish(T0, NAME, "gfs", TEXTURES, T0))
    before = obstore.get(store, "archive/clouds/manifests/2026-10-10.json").bytes().to_bytes()

    class Broken(ObjectLiveStore):
        async def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
            if path.startswith(failed_prefix):
                raise OSError("archive copy interrupted")
            await super().put(path, data, headers)

    pub.archive = Broken(store, "archive/clouds/")
    later = T0 + timedelta(hours=1)
    asyncio.run(pub.publish(later, gmgsi_name(later, later), "gfs", TEXTURES, later))
    assert (
        obstore.get(store, "archive/clouds/manifests/2026-10-10.json").bytes().to_bytes() == before
    )
    assert manifest(store).frames[-1].time == later


def test_daily_archive_is_utc_partitioned_and_expires_old_refs() -> None:
    pub, store = publisher()
    offset = datetime.fromisoformat("2026-10-11T01:00:00+02:00")
    asyncio.run(pub.publish(offset, "offset.nc", "gfs", TEXTURES, T0))
    archived = archived_manifest(store)
    assert archived.frames[0].time == T0 + timedelta(hours=23)
    later = T0 + timedelta(days=31)
    asyncio.run(pub.publish(T0, "late-rebuild.nc", "gfs", TEXTURES, later))
    assert [f.product for f in archived_manifest(store).frames] == ["late-rebuild.nc"]


def test_historical_client_fixture_uses_the_archive_contract() -> None:
    root = Path(__file__).parents[4] / "fixtures/archive/clouds"
    archived = ArchiveCloudManifest.model_validate_json(
        (root / "manifests/2026-07-15.json").read_text()
    )
    for frame in archived.frames:
        for texture in frame.textures.values():
            assert (root / "manifests" / texture.path).stat().st_size == texture.size_bytes


@pytest.mark.parametrize("invalid", [b'{"frames":', b'{"schema_version":1,"frames":[{}]}'])
def test_corrupt_daily_index_recovers_without_blocking_live(invalid: bytes) -> None:
    pub, store = publisher()
    asyncio.run(pub.archive.put("manifests/2026-10-10.json", invalid, MANIFEST_HEADERS))
    asyncio.run(pub.publish(T0, NAME, "gfs", TEXTURES, T0))
    assert [f.time for f in archived_manifest(store).frames] == [T0]
    assert manifest(store).frames[0].time == T0


def test_unknown_daily_index_version_is_preserved() -> None:
    pub, store = publisher()
    future = b'{"schema_version":2,"new-format":["preserve"]}'
    asyncio.run(pub.archive.put("manifests/2026-10-10.json", future, MANIFEST_HEADERS))
    asyncio.run(pub.publish(T0, NAME, "gfs", TEXTURES, T0))
    assert (
        obstore.get(store, "archive/clouds/manifests/2026-10-10.json").bytes().to_bytes() == future
    )
    assert manifest(store).frames[0].time == T0


def test_over_capacity_day_advances_to_newest_observations(
    caplog: pytest.LogCaptureFixture,
) -> None:
    from scintille_contract.cloud_archive import MAX_ARCHIVE_FRAMES

    pub, store = publisher()
    for minute in range(MAX_ARCHIVE_FRAMES + 1):
        time = T0 + timedelta(minutes=minute)
        asyncio.run(pub.publish(time, gmgsi_name(time, time), "gfs", TEXTURES, time))
    archived = archived_manifest(store)
    assert len(archived.frames) == MAX_ARCHIVE_FRAMES
    assert archived.frames[0].time == T0 + timedelta(minutes=1)
    assert archived.frames[-1].time == T0 + timedelta(minutes=MAX_ARCHIVE_FRAMES)
    assert "capacity exceeded" in caplog.text


def test_producer_and_reader_share_contract_cases() -> None:
    import copy
    import json

    from pydantic import ValidationError
    from scintille_contract.cloud_archive import MAX_ARCHIVE_FRAMES

    root = Path(__file__).parents[4] / "fixtures/archive/clouds"
    fixture = json.loads((root / "manifests/2026-07-15.json").read_text())
    for case in json.loads((root / "contract-cases.json").read_text()):
        payload = copy.deepcopy(fixture)
        for change in case["changes"]:
            parent = payload
            for key in change["path"][:-1]:
                parent = parent[key]
            parent[change["path"][-1]] = change["value"]
        if case.get("repeat_frames_over_limit"):
            payload["frames"] = [payload["frames"][0]] * (MAX_ARCHIVE_FRAMES + 1)
        if case["accept"]:
            ArchiveCloudManifest.model_validate(payload)
        else:
            with pytest.raises(ValidationError):
                ArchiveCloudManifest.model_validate(payload)


# Collector


class FixedSkin(GfsSkin):
    def __init__(self) -> None:
        super().__init__(MemoryStore())

    async def at(self, time: datetime) -> SkinTemperature:
        return uniform_skin(300.0)


def test_collector_publishes_new_mosaics_once() -> None:
    source = MemoryStore()
    lat, lon = mercator_lat(60), gmgsi_lon(120)
    data = gmgsi_file(np.full((60, 120), 200.0, np.float32), lat, lon)
    for h in (-8, 0, 1):
        time = T0 + timedelta(hours=h)
        name = gmgsi_name(time, time + timedelta(minutes=34))
        obstore.put(source, f"{gmgsi.hour_prefix(time)}{name}", data)
    pub, store = publisher()
    now = T0 + timedelta(hours=1, minutes=40)
    collector = CloudCollector(source, FixedSkin(), pub, clock=lambda: now)
    assert asyncio.run(collector.poll()) == 2
    assert asyncio.run(collector.poll()) == 0
    frames = manifest(store).frames
    assert [f.time for f in frames] == [T0, T0 + timedelta(hours=1)]
    assert frames[0].reference == "gfs 2026100918 f006"
    texture = obstore.get(store, f"live/clouds/{frames[0].textures['2k'].path}").bytes()
    pixels = np.asarray(Image.open(io.BytesIO(texture.to_bytes())).convert("L"))
    assert pixels.shape == (1024, 2048)
    assert pixels[512].min() > 250
    assert collector.metrics.counters[("cloud_frames_total", ())] == 2


def test_a_failing_mosaic_does_not_block_newer_ones() -> None:
    source = MemoryStore()
    lat, lon = mercator_lat(60), gmgsi_lon(120)
    good = gmgsi_file(np.full((60, 120), 200.0, np.float32), lat, lon)
    for h, data in ((0, b"corrupt"), (1, good)):
        time = T0 + timedelta(hours=h)
        obstore.put(source, f"{gmgsi.hour_prefix(time)}{gmgsi_name(time, time)}", data)
    pub, store = publisher()
    now = T0 + timedelta(hours=1, minutes=40)
    collector = CloudCollector(source, FixedSkin(), pub, clock=lambda: now)
    with pytest.raises(RuntimeError):
        asyncio.run(collector.poll())
    assert [f.time for f in manifest(store).frames] == [T0 + timedelta(hours=1)]


@pytest.mark.network
def test_latest_gmgsi_files_are_listed() -> None:
    from scintille_ingest.glm.discovery import public_store

    products = gmgsi.list_products(public_store(gmgsi.BUCKET), datetime.now(UTC), hours=4)
    assert products
    assert all(p.key.startswith("GMGSI_LW/") for p in products)


def test_client_fixture_matches_the_manifest_model() -> None:
    root = Path(__file__).parents[4] / "fixtures" / "live" / "clouds"
    manifest = CloudManifest.model_validate_json((root / "manifest.json").read_text())
    assert manifest.attribution == ATTRIBUTION
    for frame in manifest.frames:
        for texture in frame.textures.values():
            image = Image.open(root / texture.path)
            assert image.size == (texture.width, texture.height)
            assert (root / texture.path).stat().st_size == texture.size_bytes
