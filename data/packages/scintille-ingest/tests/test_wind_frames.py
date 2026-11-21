import asyncio
import functools
import io
import json
import re
import signal
from datetime import UTC, datetime, timedelta
from posixpath import normpath
from typing import Any

import eccodes  # type: ignore[import-untyped]
import numpy as np
import obstore
import pytest
from obstore.store import MemoryStore
from PIL import Image
from pydantic import ValidationError
from scintille_contract.wind import (
    MAX_WIND_FRAME_BYTES,
    WIND_HEIGHT,
    WIND_LEVELS,
    WIND_LIVE_TEXTURE_PATTERN,
    WIND_TEXTURE_PATTERN,
    WIND_WIDTH,
    decode_component,
    encode_component,
)
from scintille_ingest import cli
from scintille_ingest.clouds import gfs
from scintille_ingest.clouds.collector import CloudCollector
from scintille_ingest.clouds.gfs import GfsSkin
from scintille_ingest.clouds.publish import CloudPublisher
from scintille_ingest.clouds.wind import (
    FIELDS,
    WindCollector,
    WindField,
    backfill,
    component_bytes,
    encode,
    encode_level,
    newest_wind,
    read_wind,
    subsample,
    valid_hours,
)
from scintille_ingest.clouds.wind_publish import (
    ATTRIBUTION,
    ArchiveWindManifest,
    WindManifest,
    WindPublisher,
)
from scintille_ingest.runtime.live_feed import ObjectLiveStore
from scintille_ingest.runtime.metrics import Metrics

T0 = datetime(2026, 11, 21, 12, tzinfo=UTC)
WINDS = {"10m": (3.0, -4.0), "250hPa": (50.0, -20.0)}

INDEX = (
    "275:211000000:d=2026112106:HGT:250 mb:7 hour fcst:\n"
    "276:211187536:d=2026112106:UGRD:250 mb:7 hour fcst:\n"
    "277:211775191:d=2026112106:VGRD:250 mb:7 hour fcst:\n"
    "278:212367113:d=2026112106:ABSV:250 mb:7 hour fcst:\n"
    "586:423000000:d=2026112106:TMP:2 m above ground:7 hour fcst:\n"
    "588:423950112:d=2026112106:UGRD:10 m above ground:7 hour fcst:\n"
    "589:424912873:d=2026112106:VGRD:10 m above ground:7 hour fcst:\n"
    "590:425854720:d=2026112106:UGRD:100 m above ground:7 hour fcst:\n"
)


@functools.cache
def grib_message(value: float) -> bytes:
    """A constant field on the GFS 0.25° grid, north first."""
    handle = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
    try:
        for key, setting in {
            "Ni": 1440,
            "Nj": 721,
            "iDirectionIncrementInDegrees": 0.25,
            "jDirectionIncrementInDegrees": 0.25,
            "longitudeOfFirstGridPointInDegrees": 0.0,
            "longitudeOfLastGridPointInDegrees": 359.75,
            "latitudeOfFirstGridPointInDegrees": 90.0,
            "latitudeOfLastGridPointInDegrees": -90.0,
            "jScansPositively": 0,
        }.items():
            eccodes.codes_set(handle, key, setting)
        eccodes.codes_set_values(handle, np.full(721 * 1440, value))
        return bytes(eccodes.codes_get_message(handle))
    finally:
        eccodes.codes_release(handle)


def put_gfs(store: MemoryStore, cycle: datetime, hours: int, scale: float = 1.0) -> None:
    """A GFS file with the four wind fields among others, and its `.idx`."""
    fields = [(":PRMSL:mean sea level:", b"PRMSL")]
    for level, (u, v) in WINDS.items():
        upattern, vpattern = FIELDS[level]
        fields += [(upattern, grib_message(u * scale)), (vpattern, grib_message(v * scale))]
    fields.append((":UGRD:100 m above ground:", b"DECOY"))
    offset, lines, data = 0, [], b""
    for i, (pattern, message) in enumerate(fields, 1):
        lines.append(f"{i}:{offset}:d={cycle:%Y%m%d%H}{pattern}{hours} hour fcst:")
        offset += len(message)
        data += message
    key = gfs.grib_key(cycle, hours)
    obstore.put(store, key, data)
    obstore.put(store, key + ".idx", "\n".join(lines).encode())


def keys(store: MemoryStore) -> set[str]:
    return {meta["path"] for batch in obstore.list(store) for meta in batch}


def publisher() -> tuple[WindPublisher, MemoryStore]:
    store = MemoryStore()
    return (
        WindPublisher(
            ObjectLiveStore(store, "live/wind/"), ObjectLiveStore(store, "archive/wind/")
        ),
        store,
    )


def live(store: MemoryStore) -> WindManifest:
    return WindManifest.model_validate_json(
        obstore.get(store, "live/wind/manifest.json").bytes().to_bytes()
    )


def archived(store: MemoryStore, day: str = "2026-11-21") -> ArchiveWindManifest:
    return ArchiveWindManifest.model_validate_json(
        obstore.get(store, f"archive/wind/manifests/{day}.json").bytes().to_bytes()
    )


TEXTURES = {"10m": b"ten", "250hPa": b"jet!"}


# Reading GFS


def test_field_ranges_of_the_four_wind_fields() -> None:
    ranges = {p: gfs.field_range(INDEX, p) for pair in FIELDS.values() for p in pair}
    assert ranges == {
        ":UGRD:10 m above ground:": (423950112, 424912873),
        ":VGRD:10 m above ground:": (424912873, 425854720),
        ":UGRD:250 mb:": (211187536, 211775191),
        ":VGRD:250 mb:": (211775191, 212367113),
    }


def test_subsample_keeps_the_poles_and_the_prime_meridian() -> None:
    lat = np.linspace(90, -90, 721, dtype=np.float32)
    lon = np.arange(1440, dtype=np.float32) * 0.25
    grid = lat[:, None] * 1000 + lon[None, :]
    out = subsample(grid)
    assert out.shape == (WIND_HEIGHT, WIND_WIDTH) == (361, 720)
    assert out[0, 0] == 90_000 and out[-1, 0] == -90_000
    assert out[180, 1] == pytest.approx(0.5)
    assert out[0, -1] == pytest.approx(90_000 + 359.5)
    with pytest.raises(ValueError):
        subsample(grid[:-1])


def test_read_wind_decodes_u_and_v_per_level() -> None:
    store = MemoryStore()
    cycle = datetime(2026, 11, 21, 6, tzinfo=UTC)
    put_gfs(store, cycle, 7)
    field = read_wind(store, cycle, 7)
    assert field.label == "gfs 2026112106 f007" and field.valid_time == T0 + timedelta(hours=1)
    for level, (u, v) in WINDS.items():
        assert field.levels[level][0].shape == (361, 720)
        assert float(field.levels[level][0].mean()) == pytest.approx(u)
        assert float(field.levels[level][1].mean()) == pytest.approx(v)


def test_newest_wind_falls_back_to_an_older_cycle_or_none() -> None:
    store = MemoryStore()
    put_gfs(store, datetime(2026, 11, 21, 6, tzinfo=UTC), 7)
    field = newest_wind(store, T0 + timedelta(hours=1))
    assert field is not None and field.label == "gfs 2026112106 f007"
    assert newest_wind(store, T0 + timedelta(hours=2)) is None


# Encoding


def test_component_bytes_match_the_contract() -> None:
    values = np.concatenate(
        [
            np.random.default_rng(1).normal(0, 30, 2000),
            np.array([0, 40, -40, 99, -99, 20 / 127, 40 * 0.5 / 127, 40 * 1.5 / 127]),
        ]
    ).astype(np.float32)
    expected = [encode_component(float(x), 40) for x in values]
    assert component_bytes(values, 40).tolist() == expected


def test_encode_level_round_trips_losslessly() -> None:
    rng = np.random.default_rng(2)
    u = rng.normal(0, 15, (WIND_HEIGHT, WIND_WIDTH)).astype(np.float32)
    v = rng.normal(0, 15, (WIND_HEIGHT, WIND_WIDTH)).astype(np.float32)
    data = encode_level(u, v, 40)
    assert len(data) <= MAX_WIND_FRAME_BYTES
    image = Image.open(io.BytesIO(data))
    assert image.format == "WEBP" and image.mode == "RGB"
    assert image.size == (WIND_WIDTH, WIND_HEIGHT)
    pixels = np.asarray(image)
    np.testing.assert_array_equal(pixels[..., 0], component_bytes(u, 40))
    np.testing.assert_array_equal(pixels[..., 1], component_bytes(v, 40))
    assert not pixels[..., 2].any()
    r, c = 100, 300
    assert abs(decode_component(int(pixels[r, c, 0]), 40) - u[r, c]) <= 40 / 127 / 2 + 1e-6
    assert abs(decode_component(int(pixels[r, c, 1]), 40) - v[r, c]) <= 40 / 127 / 2 + 1e-6


def test_encode_uses_each_level_scale() -> None:
    shape = (WIND_HEIGHT, WIND_WIDTH)
    levels = {
        level: (np.full(shape, 30, np.float32), np.full(shape, -60, np.float32))
        for level in WIND_LEVELS
    }
    textures = encode(WindField(levels, T0, 0))
    pixels = {k: np.asarray(Image.open(io.BytesIO(b)))[0, 0] for k, b in textures.items()}
    assert pixels["10m"].tolist() == [encode_component(30, 40), 1, 0]
    assert pixels["250hPa"].tolist() == [encode_component(30, 120), encode_component(-60, 120), 0]


# Publishing


def test_publish_writes_archive_textures_index_and_live_manifest() -> None:
    pub, store = publisher()
    now = T0 + timedelta(minutes=5)
    asyncio.run(pub.publish(T0, "gfs 2026112106 f006", TEXTURES, now))
    m = live(store)
    assert m.attribution == ATTRIBUTION and m.window_seconds == 8 * 3600
    [frame] = m.frames
    name = frame.levels["10m"].path.split("/")[-1]
    assert re.fullmatch(r"20261121T12Z-[0-9a-f]{8}\.webp", name)
    assert keys(store) == {
        "live/wind/manifest.json",
        f"archive/wind/10m/2026/11/21/{name}",
        f"archive/wind/250hPa/2026/11/21/{name}",
        "archive/wind/manifests/2026-11-21.json",
    }
    assert frame.levels["250hPa"].model_dump() == {
        "path": f"../../archive/wind/250hPa/2026/11/21/{name}",
        "width": 720,
        "height": 361,
        "size_bytes": 4,
        "scale_ms": 120,
    }
    day = archived(store)
    assert day.schema_version == 1 and day.attribution == ATTRIBUTION
    [entry] = day.frames
    assert entry.expires_at == now + timedelta(days=30)
    assert entry.reference == frame.reference and entry.time == frame.time == T0
    for level in WIND_LEVELS:
        live_path = frame.levels[level].path
        archive_path = entry.levels[level].path
        assert re.fullmatch(WIND_LIVE_TEXTURE_PATTERN, live_path)
        assert re.fullmatch(WIND_TEXTURE_PATTERN, archive_path)
        for root, path in (("live/wind/", live_path), ("archive/wind/manifests/", archive_path)):
            texture = obstore.get(store, normpath(root + path))
            assert texture.bytes().to_bytes() == TEXTURES[level]
            assert texture.attributes["Cache-Control"] == "public, max-age=31536000, immutable"
    manifest = obstore.get(store, "live/wind/manifest.json")
    assert manifest.attributes["Cache-Control"] == "public, max-age=60"


def test_live_manifest_keeps_eight_hours() -> None:
    pub, store = publisher()
    for h in range(10):
        time = T0 + timedelta(hours=h)
        asyncio.run(pub.publish(time, "gfs", TEXTURES, time))
    assert [f.time.hour for f in live(store).frames] == list(range(14, 22))
    assert len(archived(store).frames) == 10


def test_a_republished_hour_replaces_the_old_frame() -> None:
    pub, store = publisher()
    first = asyncio.run(pub.publish(T0, "gfs 2026112100 f012", TEXTURES, T0))
    later = T0 + timedelta(hours=1)
    asyncio.run(pub.publish(later, "gfs 2026112106 f007", TEXTURES, later))
    again = asyncio.run(pub.publish(T0, "gfs 2026112106 f006", TEXTURES, later))
    assert first.levels["10m"].path != again.levels["10m"].path
    assert [(f.time, f.reference) for f in live(store).frames] == [
        (T0, "gfs 2026112106 f006"),
        (later, "gfs 2026112106 f007"),
    ]
    assert [(f.time, f.reference) for f in archived(store).frames] == [
        (T0, "gfs 2026112106 f006"),
        (later, "gfs 2026112106 f007"),
    ]


def test_expired_frames_leave_the_daily_index() -> None:
    pub, store = publisher()
    asyncio.run(pub.archive_frame(T0, "old", TEXTURES, T0))
    late = T0 + timedelta(days=31)
    asyncio.run(pub.archive_frame(T0 + timedelta(hours=1), "late", TEXTURES, late))
    assert [f.reference for f in archived(store).frames] == ["late"]


def test_daily_index_follows_the_utc_valid_day() -> None:
    pub, store = publisher()
    local = datetime.fromisoformat("2026-11-22T00:30:00+02:00").replace(minute=0)
    asyncio.run(pub.publish(local, "gfs", TEXTURES, T0))
    assert archived(store, "2026-11-21").frames[0].time == datetime(2026, 11, 21, 22, tzinfo=UTC)


@pytest.mark.parametrize("invalid", [b'{"frames":', b'{"schema_version":1,"frames":[{}]}'])
def test_corrupt_daily_index_is_rebuilt(invalid: bytes) -> None:
    pub, store = publisher()
    obstore.put(store, "archive/wind/manifests/2026-11-21.json", invalid)
    asyncio.run(pub.publish(T0, "gfs", TEXTURES, T0))
    assert [f.time for f in archived(store).frames] == [T0]


def test_unknown_daily_index_version_is_preserved() -> None:
    pub, store = publisher()
    future = b'{"schema_version":2,"frames":"elsewhere"}'
    obstore.put(store, "archive/wind/manifests/2026-11-21.json", future)
    asyncio.run(pub.publish(T0, "gfs", TEXTURES, T0))
    key = "archive/wind/manifests/2026-11-21.json"
    assert obstore.get(store, key).bytes().to_bytes() == future
    assert [f.time for f in live(store).frames] == [T0]


def test_a_failed_archive_write_leaves_the_live_manifest_for_the_retry() -> None:
    store = MemoryStore()

    class Broken(ObjectLiveStore):
        async def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
            raise OSError("r2 down")

    pub = WindPublisher(ObjectLiveStore(store, "live/wind/"), Broken(store, "archive/wind/"))
    with pytest.raises(OSError):
        asyncio.run(pub.publish(T0, "gfs", TEXTURES, T0))
    assert pub.published() == set()
    assert "live/wind/manifest.json" not in keys(store)


def test_restore_continues_the_published_frames() -> None:
    pub, _ = publisher()
    asyncio.run(pub.publish(T0, "gfs", TEXTURES, T0))
    again = WindPublisher(pub.live, pub.archive)
    asyncio.run(again.restore())
    assert again.published() == {T0}


def test_archive_index_rejects_what_the_contract_forbids() -> None:
    pub, store = publisher()
    asyncio.run(pub.publish(T0, "gfs", TEXTURES, T0))
    key = "archive/wind/manifests/2026-11-21.json"
    good = json.loads(obstore.get(store, key).bytes().to_bytes())
    ArchiveWindManifest.model_validate(good)
    frame = good["frames"][0]

    def ten_metres(**change: object) -> dict[str, Any]:
        texture = {**frame["levels"]["10m"], **change}
        return {"frames": [{**frame, "levels": {**frame["levels"], "10m": texture}}]}

    cases: list[dict[str, Any]] = [
        {"frames": [frame, frame]},
        {"day": "2026-11-22"},
        {"frames": [{**frame, "time": "2026-11-21T12:30:00Z"}]},
        {"frames": [{**frame, "levels": {"10m": frame["levels"]["10m"]}}]},
        ten_metres(path=frame["levels"]["250hPa"]["path"]),
        ten_metres(path="../../x.webp"),
        ten_metres(width=1440),
        ten_metres(scale_ms=120),
        {"schema_version": 2},
    ]
    for change in cases:
        with pytest.raises(ValidationError):
            ArchiveWindManifest.model_validate({**good, **change})


# Collector


def test_valid_hours_run_from_six_hours_back_to_the_next_hour() -> None:
    hours = valid_hours(T0 + timedelta(minutes=10), timedelta(hours=8))
    assert hours[0] == T0 - timedelta(hours=6) and hours[-1] == T0 + timedelta(hours=1)
    assert len(hours) == 8


def test_collector_publishes_missing_hours_once_gfs_has_them() -> None:
    source = MemoryStore()
    cycle = datetime(2026, 11, 21, 6, tzinfo=UTC)
    for hours in range(7):
        put_gfs(source, cycle, hours)
    pub, store = publisher()
    asyncio.run(pub.publish(T0 - timedelta(hours=5), "gfs earlier", TEXTURES, T0))
    now = T0 + timedelta(minutes=10)
    collector = WindCollector(source, pub, clock=lambda: now)
    assert asyncio.run(collector.poll()) == 6
    assert asyncio.run(collector.poll()) == 0
    frames = live(store).frames
    assert [f.time.hour for f in frames] == [6, 7, 8, 9, 10, 11, 12]
    assert frames[1].reference == "gfs earlier"
    assert frames[-1].reference == "gfs 2026112106 f006"
    texture = obstore.get(store, normpath("live/wind/" + frames[-1].levels["250hPa"].path))
    pixel = np.asarray(Image.open(io.BytesIO(texture.bytes().to_bytes())))[100, 100]
    assert pixel.tolist() == [encode_component(50, 120), encode_component(-20, 120), 0]
    assert collector.metrics.counters[("wind_frames_total", ())] == 6
    assert collector.metrics.gauges[("wind_frame_age_seconds", ())] == 600
    put_gfs(source, cycle, 7)
    assert asyncio.run(collector.poll()) == 1
    assert live(store).frames[-1].time == T0 + timedelta(hours=1)
    assert collector.metrics.gauges[("wind_frame_age_seconds", ())] == -3000


def test_a_failing_hour_does_not_block_the_others() -> None:
    source = MemoryStore()
    cycle = datetime(2026, 11, 21, 6, tzinfo=UTC)
    for hours in range(8):
        put_gfs(source, cycle, hours)
    key = gfs.grib_key(cycle, 3)
    obstore.put(source, key, b"x" * obstore.head(source, key)["size"])
    pub, store = publisher()
    collector = WindCollector(source, pub, clock=lambda: T0 + timedelta(minutes=10))
    with pytest.raises(RuntimeError):
        asyncio.run(collector.poll())
    assert len(live(store).frames) == 7
    assert T0 - timedelta(hours=3) not in pub.published()


def test_backfill_archives_past_hours_without_the_live_manifest() -> None:
    source = MemoryStore()
    day = T0.date()
    midnight = datetime(2026, 11, 21, tzinfo=UTC)
    for hours in range(6):
        put_gfs(source, midnight, hours)
    pub, store = publisher()
    asyncio.run(pub.archive_frame(midnight + timedelta(hours=2), "kept", TEXTURES, midnight))
    later = midnight + timedelta(days=1)
    assert asyncio.run(backfill(source, pub, [day], clock=lambda: later)) == 5
    frames = archived(store).frames
    assert [f.time.hour for f in frames] == [0, 1, 2, 3, 4, 5]
    assert frames[0].reference == "gfs 2026112100 f000"
    assert frames[2].reference == "kept"
    assert not any(k.startswith("live/") for k in keys(store))
    assert asyncio.run(backfill(source, pub, [day], clock=lambda: later)) == 0


def test_wind_failures_never_stop_the_cloud_collector() -> None:
    class CountingClouds(CloudCollector):
        polls = 0

        async def poll(self) -> int:
            self.polls += 1
            return await super().poll()

    class CrashingWind(WindCollector):
        async def run(self) -> None:
            raise RuntimeError("wind crashed")

    class FailingWind(WindCollector):
        async def poll(self) -> int:
            raise OSError("gfs down")

    store = MemoryStore()
    metrics = Metrics()
    clouds = CountingClouds(
        MemoryStore(),
        GfsSkin(MemoryStore()),
        CloudPublisher(
            ObjectLiveStore(store, "live/clouds/"), ObjectLiveStore(store, "archive/clouds/")
        ),
        metrics=metrics,
        cadence=0.01,
    )

    class Unreachable(ObjectLiveStore):
        async def get(self, path: str) -> bytes | None:
            raise OSError("r2 down")

    failing = FailingWind(
        MemoryStore(),
        WindPublisher(Unreachable(store, "live/wind/"), Unreachable(store, "archive/wind/")),
        metrics=metrics,
        cadence=0.01,
        max_backoff=0.01,
    )

    async def scenario() -> None:
        await CrashingWind(MemoryStore(), publisher()[0], metrics=metrics).start()
        running = asyncio.create_task(cli.serve_with_wind(0, clouds, failing, metrics))
        await asyncio.sleep(0.2)
        assert clouds.healthy()
        assert clouds.polls > 3
        signal.raise_signal(signal.SIGTERM)
        await asyncio.wait_for(running, 5)

    asyncio.run(scenario())
    assert metrics.counters[("wind_errors_total", ())] > 3
    assert not clouds.healthy()
