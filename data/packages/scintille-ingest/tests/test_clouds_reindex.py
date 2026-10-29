import json
from datetime import UTC, date, datetime, timedelta

import obstore
from obstore.store import MemoryStore
from scintille_ingest.clouds import gfs
from scintille_ingest.clouds.publish import ArchiveCloudManifest, texture_name
from scintille_ingest.clouds.reindex import (
    ArchivedTexture,
    frames_for_day,
    reference_for,
    reindex_day,
)

DAY = date(2026, 10, 15)
T = datetime(2026, 10, 15, 15, tzinfo=UTC)
PRODUCT = "GLOBCOMPLIR_v3r0_blend_s202610151500000_e202610151509599_c202610151533362.nc"
DIGEST = texture_name(T, PRODUCT).split("-")[1].removesuffix(".webp")


def texture(
    tier: str, uploaded: datetime, digest: str = DIGEST, time: datetime = T
) -> ArchivedTexture:
    return ArchivedTexture(tier, time, digest, 1000 if tier == "2k" else 4000, uploaded)


def test_reference_is_the_newest_run_online_at_publication() -> None:
    uploaded = T + timedelta(minutes=40)
    online = {gfs.grib_key(T.replace(hour=12), 3) + ".idx": T - timedelta(minutes=30)}
    assert reference_for(online.get, T, uploaded) == "gfs 2026101512 f003"
    late = {
        gfs.grib_key(T.replace(hour=12), 3) + ".idx": uploaded + timedelta(minutes=1),
        gfs.grib_key(T.replace(hour=6), 9) + ".idx": T - timedelta(hours=5),
    }
    assert reference_for(late.get, T, uploaded) == "gfs 2026101506 f009"


def test_a_revised_mosaic_keeps_its_newest_upload() -> None:
    early, late = T + timedelta(minutes=30), T + timedelta(minutes=90)
    textures = [
        texture("2k", early, "00000000"),
        texture("4k", early, "00000000"),
        texture("2k", late),
        texture("4k", late),
        texture("2k", late, time=T + timedelta(hours=1)),
    ]
    frames = frames_for_day(textures, lambda time, digest: PRODUCT, lambda t, u: "gfs x")
    assert len(frames) == 1
    frame = frames[0]
    assert (frame.product, frame.published_at, frame.expires_at) == (
        PRODUCT,
        late,
        late + timedelta(days=30),
    )
    assert frame.textures["4k"].path == f"../4k/2026/10/15/{texture_name(T, PRODUCT)}"
    assert (frame.textures["4k"].width, frame.textures["4k"].height) == (4096, 2048)


def test_reindex_adds_missing_frames_to_the_day() -> None:
    store, noaa, forecasts = MemoryStore(), MemoryStore(), MemoryStore()
    for tier in ("2k", "4k"):
        obstore.put(store, f"archive/clouds/{tier}/2026/10/15/{texture_name(T, PRODUCT)}", b"webp")
    obstore.put(noaa, f"GMGSI_LW/2026/10/15/15/{PRODUCT}", b"nc")
    now = datetime.now(UTC)
    assert reindex_day(store, noaa, forecasts, DAY, now, dry_run=True) == 1
    assert not list(obstore.list(store, prefix="archive/clouds/manifests/"))
    assert reindex_day(store, noaa, forecasts, DAY, now, dry_run=False) == 1
    body = obstore.get(store, "archive/clouds/manifests/2026-10-15.json").bytes().to_bytes()
    manifest = ArchiveCloudManifest.model_validate(json.loads(body))
    assert [f.time for f in manifest.frames] == [T]
    assert reindex_day(store, noaa, forecasts, DAY, now, dry_run=False) == 0
