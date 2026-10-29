"""Cloud frames on R2: immutable textures per tier under `live/clouds/`, a short-lived manifest,
and the same textures under `archive/clouds/` for replay."""

import hashlib
import json
import logging
import re
from collections.abc import Mapping
from datetime import UTC, date, datetime, timedelta

from pydantic import AwareDatetime, BaseModel, Field, model_validator
from scintille_contract.cloud_archive import (
    ARCHIVE_DETAIL_PATTERN,
    ARCHIVE_SCHEMA_VERSION,
    ARCHIVE_TEXTURE_PATTERN,
    CLOUD_TIERS,
    MAX_ARCHIVE_FRAMES,
    MAX_CLOUD_FRAME_BYTES,
)

from scintille_ingest.runtime.live_feed import LiveStore

from . import tiles
from .texture import TIERS

log = logging.getLogger("scintille_ingest.clouds")

ATTRIBUTION = "Clouds: NOAA NESDIS GMGSI (contains EUMETSAT Meteosat and JMA Himawari data)"
WINDOW = timedelta(hours=6)
ARCHIVE_RETENTION = timedelta(days=30)
DETAIL_RETENTION = timedelta(days=1)
"""Detail packs are the bulk of the archive; older replays keep the global textures."""
TEXTURE_HEADERS = {
    "Content-Type": "image/webp",
    "Cache-Control": "public, max-age=31536000, immutable",
}
MANIFEST_HEADERS = {"Content-Type": "application/json", "Cache-Control": "public, max-age=60"}
PACK_HEADERS = {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
}


class CloudTexture(BaseModel):
    path: str
    """Relative to the manifest; opaque."""
    width: int
    height: int
    size_bytes: int = Field(strict=True, ge=1, le=MAX_CLOUD_FRAME_BYTES)


class CloudHeights(BaseModel):
    """Cloud-top height tiles in the same pack, after the opacity index (ADR 0028)."""

    levels: list[int]
    max_km: float
    """Grayscale 0 to 255 maps onto 0 to `max_km` above sea level."""
    index_offset: int = Field(strict=True, ge=0)
    index_bytes: int = Field(strict=True, ge=0)
    """Same form as the opacity index, one pair per possible tile of `levels`."""
    reference: str
    """Temperature profile the heights come from, or the lapse rate fallback."""


class CloudDetail(BaseModel):
    """Finer tiles of the same frame, for close views (ADR 0023)."""

    path: str
    """Relative to the manifest: one object with an index, then the tiles (`tiles.pack`)."""
    tile_size: int
    border: int
    """Texels each tile repeats from its neighbours on every side."""
    levels: list[int]
    """Every level but the finest has all its tiles within ±`max_latitude`."""
    max_latitude: float
    fine: str
    """Finest level tiles present: base64 bitmap, row-major from the north-west, low bit first."""
    size_bytes: int = Field(strict=True, ge=0)
    index_bytes: int = Field(strict=True, ge=0)
    """Length of the index at the start of the object."""
    height: CloudHeights | None = None


class CloudFrameRef(BaseModel):
    time: AwareDatetime
    """Observation time of the mosaic, for the HUD."""
    published_at: AwareDatetime
    product: str
    """Upstream file name."""
    reference: str
    """Surface temperature field the opacity was computed against."""
    textures: dict[str, CloudTexture]
    detail: CloudDetail | None = None


class CloudManifest(BaseModel):
    generated_at: AwareDatetime
    window_seconds: int
    attribution: str
    frames: list[CloudFrameRef]
    """Oldest first."""


class ArchiveCloudFrame(CloudFrameRef):
    expires_at: AwareDatetime
    """Conservative availability limit, before the bucket's lifecycle grace period."""

    @model_validator(mode="after")
    def valid_textures(self) -> "ArchiveCloudFrame":
        for tier, texture in self.textures.items():
            if (
                tier not in CLOUD_TIERS
                or not re.fullmatch(ARCHIVE_TEXTURE_PATTERN, texture.path)
                or not 1 <= texture.size_bytes <= MAX_CLOUD_FRAME_BYTES
            ):
                raise ValueError("invalid archive cloud texture")
        if self.detail and not re.fullmatch(ARCHIVE_DETAIL_PATTERN, self.detail.path):
            raise ValueError("invalid archive cloud detail")
        return self


class ArchiveCloudManifest(BaseModel):
    schema_version: int = Field(
        default=ARCHIVE_SCHEMA_VERSION,
        strict=True,
        ge=ARCHIVE_SCHEMA_VERSION,
        le=ARCHIVE_SCHEMA_VERSION,
    )
    day: date
    generated_at: AwareDatetime
    attribution: str = ATTRIBUTION
    frames: list[ArchiveCloudFrame] = Field(max_length=MAX_ARCHIVE_FRAMES)

    @model_validator(mode="after")
    def valid_observation_days(self) -> "ArchiveCloudManifest":
        if any(f.time.astimezone(UTC).date() != self.day for f in self.frames):
            raise ValueError("archive cloud manifest contains a different observation day")
        return self


def texture_name(time: datetime, product: str) -> str:
    """Time-sortable, and unique per upstream file so a revised mosaic never reuses a cached URL."""
    digest = hashlib.sha256(product.encode()).hexdigest()[:8]
    return f"{time:%Y%m%dT%H%M%SZ}-{digest}.webp"


def archive_path(tier: str, time: datetime, name: str) -> str:
    return f"{tier}/{time:%Y/%m/%d}/{name}"


def detail_path(time: datetime, name: str) -> str:
    """Tiles of a frame, under the archive root: written once, read by both manifests."""
    return f"detail/{time:%Y/%m/%d}/{name.removesuffix('.webp')}.tiles"


class CloudPublisher:
    """`live` and `archive` are stores rooted at `live/clouds/` and `archive/clouds/`."""

    def __init__(
        self,
        live: LiveStore,
        archive: LiveStore,
        window: timedelta = WINDOW,
        attribution: str = ATTRIBUTION,
    ) -> None:
        self.live = live
        self.archive = archive
        self.window = window
        self.attribution = attribution
        self.frames: list[CloudFrameRef] = []
        self.expired: set[str] = set()

    async def restore(self) -> None:
        data = await self.live.get("manifest.json")
        if data:
            self.frames = CloudManifest.model_validate_json(data).frames

    def published(self) -> dict[datetime, str]:
        return {frame.time: frame.product for frame in self.frames}

    async def publish(
        self,
        time: datetime,
        product: str,
        reference: str,
        textures: dict[str, bytes],
        now: datetime,
        detail: Mapping[tiles.Key, bytes] | None = None,
        heights: Mapping[tiles.Key, bytes] | None = None,
        heights_reference: str = "",
    ) -> CloudFrameRef:
        """Detail tiles, textures, then the manifest, then the archive copies. Live textures that
        left the window are deleted on the next publish, so cached manifests still resolve."""
        time = time.astimezone(UTC)
        name = texture_name(time, product)
        detail_ref = (
            await self._detail(time, name, detail, heights, heights_reference) if detail else None
        )
        refs = {}
        for tier, data in textures.items():
            path = f"{tier}/{name}"
            await self.live.put(path, data, TEXTURE_HEADERS)
            width = TIERS[tier]
            refs[tier] = CloudTexture(
                path=path, width=width, height=width // 2, size_bytes=len(data)
            )
        frame = CloudFrameRef(
            time=time,
            published_at=now,
            product=product,
            reference=reference,
            textures=refs,
            detail=detail_ref.model_copy(update={"path": f"../../archive/clouds/{detail_ref.path}"})
            if detail_ref
            else None,
        )
        before = self.frames
        frames = sorted([f for f in before if f.time != time] + [frame], key=lambda f: f.time)
        newest = frames[-1].time
        self.frames = [f for f in frames if newest - f.time < self.window]
        await self.live.put(
            "manifest.json", self.manifest(now).model_dump_json().encode(), MANIFEST_HEADERS
        )
        kept = {t.path for f in self.frames for t in f.textures.values()}
        for path in self.expired - kept:
            await self._delete(path)
        self.expired = {t.path for f in before for t in f.textures.values()} - kept
        await self._archive(frame, textures, now, detail_ref)
        await self._expire_details(now)
        return frame

    async def _detail(
        self,
        time: datetime,
        name: str,
        detail: Mapping[tiles.Key, bytes],
        heights: Mapping[tiles.Key, bytes] | None = None,
        heights_reference: str = "",
    ) -> CloudDetail:
        """Uploads the tiles as one object; the returned path is relative to the archive root."""
        path = detail_path(time, name)
        data = tiles.pack(detail, heights)
        await self.archive.put(path, data, PACK_HEADERS)
        return CloudDetail(
            path=path,
            tile_size=tiles.TILE,
            border=tiles.BORDER,
            levels=list(tiles.LEVELS),
            max_latitude=tiles.MAX_LATITUDE,
            fine=tiles.bitmap(detail, tiles.FINE_LEVEL),
            size_bytes=len(data),
            index_bytes=tiles.INDEX_SLOTS * 8,
            height=CloudHeights(
                levels=list(tiles.HEIGHT_LEVELS),
                max_km=tiles.HEIGHT_MAX_KM,
                index_offset=tiles.INDEX_SLOTS * 8,
                index_bytes=tiles.HEIGHT_SLOTS * 8,
                reference=heights_reference,
            )
            if heights is not None
            else None,
        )

    def manifest(self, now: datetime) -> CloudManifest:
        return CloudManifest(
            generated_at=now,
            window_seconds=int(self.window.total_seconds()),
            attribution=self.attribution,
            frames=self.frames,
        )

    async def _archive(
        self,
        frame: CloudFrameRef,
        textures: dict[str, bytes],
        now: datetime,
        detail: CloudDetail | None = None,
    ) -> None:
        try:
            key = f"manifests/{frame.time:%Y-%m-%d}.json"
            previous = await self.archive.get(key)
            frames: list[ArchiveCloudFrame] = []
            if previous:
                try:
                    payload = json.loads(previous)
                    version = payload.get("schema_version") if isinstance(payload, dict) else None
                    if isinstance(version, int) and version != ARCHIVE_SCHEMA_VERSION:
                        log.error("unsupported cloud archive version; preserving existing index")
                        return
                    restored = ArchiveCloudManifest.model_validate(payload)
                    if restored.day != frame.time.date():
                        raise ValueError("cloud archive index has the wrong day")
                    frames = restored.frames
                except ValueError:
                    log.warning("rebuilding invalid cloud archive index", exc_info=True)
            refs = {}
            for tier, data in textures.items():
                path = archive_path(tier, frame.time, texture_name(frame.time, frame.product))
                await self.archive.put(path, data, TEXTURE_HEADERS)
                refs[tier] = frame.textures[tier].model_copy(update={"path": f"../{path}"})
            kept = [f for f in frames if f.time != frame.time and f.expires_at > now]
            archived = ArchiveCloudFrame(
                **frame.model_dump(exclude={"textures", "detail"}),
                textures=refs,
                detail=detail.model_copy(update={"path": f"../{detail.path}"}) if detail else None,
                expires_at=now + ARCHIVE_RETENTION,
            )
            combined = sorted([*kept, archived], key=lambda f: f.time)
            if len(combined) > MAX_ARCHIVE_FRAMES:
                log.warning(
                    "cloud archive day capacity exceeded; retaining newest observations",
                    extra={"fields": {"day": str(frame.time.date()), "frames": len(combined)}},
                )
                combined = combined[-MAX_ARCHIVE_FRAMES:]
            manifest = ArchiveCloudManifest(
                day=frame.time.date(),
                generated_at=now,
                attribution=self.attribution,
                frames=combined,
            )
            await self.archive.put(key, manifest.model_dump_json().encode(), MANIFEST_HEADERS)
        except Exception:
            log.exception("cloud archive publication failed")

    async def _expire_details(self, now: datetime) -> None:
        """Deletes the detail packs published before the retention and unlists them."""
        cutoff = now - DETAIL_RETENTION
        for day in sorted({(cutoff - timedelta(days=1)).date(), cutoff.date()}):
            key = f"manifests/{day}.json"
            try:
                data = await self.archive.get(key)
                if not data:
                    continue
                manifest = ArchiveCloudManifest.model_validate_json(data)
                frames = []
                for frame in manifest.frames:
                    if frame.detail and frame.published_at < cutoff:
                        await self.archive.delete(frame.detail.path.removeprefix("../"))
                        frame = frame.model_copy(update={"detail": None})
                    frames.append(frame)
                if frames != manifest.frames:
                    updated = manifest.model_copy(update={"frames": frames, "generated_at": now})
                    await self.archive.put(
                        key, updated.model_dump_json().encode(), MANIFEST_HEADERS
                    )
            except Exception:
                log.exception("cloud detail expiry failed", extra={"fields": {"day": str(day)}})

    async def _delete(self, path: str) -> None:
        try:
            await self.live.delete(path)
        except Exception:
            log.exception("cloud texture delete failed", extra={"fields": {"path": path}})
