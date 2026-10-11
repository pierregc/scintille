"""Cloud frames on R2: immutable textures per tier under `live/clouds/`, a short-lived manifest,
and the same textures under `archive/clouds/` for replay."""

import hashlib
import logging
from datetime import datetime, timedelta

from pydantic import AwareDatetime, BaseModel

from scintille_ingest.runtime.live_feed import LiveStore

from .texture import TIERS

log = logging.getLogger("scintille_ingest.clouds")

ATTRIBUTION = "Clouds: NOAA NESDIS GMGSI (contains EUMETSAT Meteosat and JMA Himawari data)"
WINDOW = timedelta(hours=6)
TEXTURE_HEADERS = {
    "Content-Type": "image/webp",
    "Cache-Control": "public, max-age=31536000, immutable",
}
MANIFEST_HEADERS = {"Content-Type": "application/json", "Cache-Control": "public, max-age=60"}


class CloudTexture(BaseModel):
    path: str
    """Relative to the manifest; opaque."""
    width: int
    height: int
    size_bytes: int


class CloudFrameRef(BaseModel):
    time: AwareDatetime
    """Observation time of the mosaic, for the HUD."""
    published_at: AwareDatetime
    product: str
    """Upstream file name."""
    reference: str
    """Surface temperature field the opacity was computed against."""
    textures: dict[str, CloudTexture]


class CloudManifest(BaseModel):
    generated_at: AwareDatetime
    window_seconds: int
    attribution: str
    frames: list[CloudFrameRef]
    """Oldest first."""


def texture_name(time: datetime, product: str) -> str:
    """Time-sortable, and unique per upstream file so a revised mosaic never reuses a cached URL."""
    digest = hashlib.sha256(product.encode()).hexdigest()[:8]
    return f"{time:%Y%m%dT%H%M%SZ}-{digest}.webp"


def archive_path(tier: str, time: datetime, name: str) -> str:
    return f"{tier}/{time:%Y/%m/%d}/{name}"


class CloudPublisher:
    """`live` and `archive` are stores rooted at `live/clouds/` and `archive/clouds/`."""

    def __init__(self, live: LiveStore, archive: LiveStore, window: timedelta = WINDOW) -> None:
        self.live = live
        self.archive = archive
        self.window = window
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
    ) -> CloudFrameRef:
        """Textures, then the manifest, then the archive copies. Live textures that left the
        window are deleted on the next publish, so cached manifests still resolve."""
        name = texture_name(time, product)
        refs = {}
        for tier, data in textures.items():
            path = f"{tier}/{name}"
            await self.live.put(path, data, TEXTURE_HEADERS)
            width = TIERS[tier]
            refs[tier] = CloudTexture(
                path=path, width=width, height=width // 2, size_bytes=len(data)
            )
        frame = CloudFrameRef(
            time=time, published_at=now, product=product, reference=reference, textures=refs
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
        for tier, data in textures.items():
            await self._archive(archive_path(tier, time, name), data)
        return frame

    def manifest(self, now: datetime) -> CloudManifest:
        return CloudManifest(
            generated_at=now,
            window_seconds=int(self.window.total_seconds()),
            attribution=ATTRIBUTION,
            frames=self.frames,
        )

    async def _archive(self, path: str, data: bytes) -> None:
        try:
            await self.archive.put(path, data, TEXTURE_HEADERS)
        except Exception:
            log.exception("cloud archive write failed", extra={"fields": {"path": path}})

    async def _delete(self, path: str) -> None:
        try:
            await self.live.delete(path)
        except Exception:
            log.exception("cloud texture delete failed", extra={"fields": {"path": path}})
