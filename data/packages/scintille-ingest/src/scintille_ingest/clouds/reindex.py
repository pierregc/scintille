"""Daily cloud indexes for archived textures published before the indexes existed (ADR 0025).
Nothing is uploaded but the indexes; a time already indexed is left as it is."""

import hashlib
import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

import obstore
from obstore.store import ObjectStore

from . import gfs, gmgsi
from .publish import (
    ARCHIVE_RETENTION,
    ATTRIBUTION,
    MANIFEST_HEADERS,
    ArchiveCloudFrame,
    ArchiveCloudManifest,
    CloudTexture,
    archive_path,
    texture_name,
)
from .texture import TIERS

log = logging.getLogger("scintille_ingest.clouds")

_NAME = re.compile(r"^(?P<time>\d{8}T\d{6}Z)-(?P<digest>[0-9a-f]{8})\.webp$")


@dataclass(frozen=True)
class ArchivedTexture:
    tier: str
    time: datetime
    digest: str
    size: int
    uploaded: datetime


def archived_textures(store: ObjectStore, day: date) -> list[ArchivedTexture]:
    found = []
    for tier in TIERS:
        prefix = f"archive/clouds/{tier}/{day:%Y/%m/%d}/"
        for batch in obstore.list(store, prefix=prefix, chunk_size=1000):
            for meta in batch:
                match = _NAME.match(meta["path"].removeprefix(prefix))
                if match is None:
                    continue
                time = datetime.strptime(match["time"], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
                found.append(
                    ArchivedTexture(
                        tier, time, match["digest"], meta["size"], meta["last_modified"]
                    )
                )
    return found


def product_for(noaa: ObjectStore, time: datetime, digest: str) -> str | None:
    """The upstream file whose name gave the texture its digest."""
    for batch in obstore.list(noaa, prefix=gmgsi.hour_prefix(time)):
        for meta in batch:
            name = meta["path"].rsplit("/", 1)[-1]
            if hashlib.sha256(name.encode()).hexdigest()[:8] == digest:
                return name
    return None


def reference_for(
    published: Callable[[str], datetime | None], time: datetime, uploaded: datetime
) -> str:
    """The newest GFS run that was online when the frame was published, as the collector chose."""
    pairs = gfs.candidates(time)
    for cycle, hours in pairs:
        online = published(gfs.grib_key(cycle, hours) + ".idx")
        if online is not None and online <= uploaded:
            return f"gfs {cycle:%Y%m%d%H} f{hours:03d}"
    cycle, hours = pairs[-1]
    return f"gfs {cycle:%Y%m%d%H} f{hours:03d}"


def frames_for_day(
    textures: list[ArchivedTexture],
    product: Callable[[datetime, str], str | None],
    reference: Callable[[datetime, datetime], str],
) -> list[ArchiveCloudFrame]:
    """One frame per observation time; a revised mosaic keeps its newest upload."""
    groups: dict[tuple[datetime, str], dict[str, ArchivedTexture]] = {}
    for texture in textures:
        groups.setdefault((texture.time, texture.digest), {})[texture.tier] = texture
    newest: dict[datetime, dict[str, ArchivedTexture]] = {}
    for (time, _), tiers in groups.items():
        if set(tiers) != set(TIERS):
            continue
        uploaded = max(t.uploaded for t in tiers.values())
        if time not in newest or uploaded > max(t.uploaded for t in newest[time].values()):
            newest[time] = tiers
    frames = []
    for time, tiers in sorted(newest.items()):
        first = next(iter(tiers.values()))
        name = product(time, first.digest)
        if name is None:
            log.warning(
                "no upstream file for archived texture", extra={"fields": {"time": str(time)}}
            )
            continue
        published = min(t.uploaded for t in tiers.values())
        frames.append(
            ArchiveCloudFrame(
                time=time,
                published_at=published,
                product=name,
                reference=reference(time, published),
                textures={
                    tier: CloudTexture(
                        path=f"../{archive_path(tier, time, texture_name(time, name))}",
                        width=TIERS[tier],
                        height=TIERS[tier] // 2,
                        size_bytes=t.size,
                    )
                    for tier, t in sorted(tiers.items())
                },
                expires_at=published + ARCHIVE_RETENTION,
            )
        )
    return frames


def reindex_day(
    store: ObjectStore,
    noaa: ObjectStore,
    forecasts: ObjectStore,
    day: date,
    now: datetime,
    dry_run: bool,
) -> int:
    """Adds the archived frames missing from the day's index; returns how many."""
    key = f"archive/clouds/manifests/{day}.json"
    try:
        existing = ArchiveCloudManifest.model_validate(
            json.loads(obstore.get(store, key).bytes().to_bytes())
        )
    except FileNotFoundError:
        existing = None
    known = {f.time for f in existing.frames} if existing else set()

    def online(path: str) -> datetime | None:
        try:
            return obstore.head(forecasts, path)["last_modified"]
        except FileNotFoundError:
            return None

    missing = [
        f
        for f in frames_for_day(
            [t for t in archived_textures(store, day) if t.time not in known],
            lambda time, digest: product_for(noaa, time, digest),
            lambda time, uploaded: reference_for(online, time, uploaded),
        )
        if f.expires_at > now
    ]
    if not missing:
        return 0
    frames = sorted([*(existing.frames if existing else []), *missing], key=lambda f: f.time)
    manifest = ArchiveCloudManifest(
        day=day,
        generated_at=now,
        attribution=existing.attribution if existing else ATTRIBUTION,
        frames=frames,
    )
    if not dry_run:
        obstore.put(store, key, manifest.model_dump_json().encode(), attributes=MANIFEST_HEADERS)
    log.info(
        "cloud archive index rebuilt", extra={"fields": {"day": str(day), "added": len(missing)}}
    )
    return len(missing)


def days_between(first: date, last: date) -> list[date]:
    return [first + timedelta(days=i) for i in range((last - first).days + 1)]
