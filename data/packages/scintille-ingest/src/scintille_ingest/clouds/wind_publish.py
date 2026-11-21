"""Wind frames on R2 (ADR 0039): textures written once under `archive/wind/`, read by a short-lived
live manifest and by daily archive indexes."""

import hashlib
import itertools
import json
import logging
import re
from datetime import UTC, date, datetime, timedelta
from typing import ClassVar, Self

from pydantic import AwareDatetime, BaseModel, Field, model_validator
from scintille_contract.wind import (
    MAX_WIND_FRAME_BYTES,
    MAX_WIND_FRAMES,
    MAX_WIND_MANIFEST_BYTES,
    WIND_HEIGHT,
    WIND_LEVELS,
    WIND_LIVE_TEXTURE_PATTERN,
    WIND_RETENTION_DAYS,
    WIND_SCALES,
    WIND_SCHEMA_VERSION,
    WIND_TEXTURE_PATTERN,
    WIND_WIDTH,
)

from scintille_ingest.runtime.live_feed import LiveStore

from .publish import MANIFEST_HEADERS, TEXTURE_HEADERS

log = logging.getLogger("scintille_ingest.wind")

ATTRIBUTION = "Wind: NOAA NCEP GFS model forecast"
WINDOW = timedelta(hours=8)
"""Six hours back, the current hour and the next one."""
RETENTION = timedelta(days=WIND_RETENTION_DAYS)


class WindTexture(BaseModel):
    path: str
    """Relative to the manifest."""
    width: int
    height: int
    size_bytes: int = Field(strict=True, ge=1, le=MAX_WIND_FRAME_BYTES)
    scale_ms: float
    """Speed of bytes 1 and 255."""


class WindFrameRef(BaseModel):
    path_pattern: ClassVar[str] = WIND_LIVE_TEXTURE_PATTERN

    time: AwareDatetime
    """Valid time of the forecast, a whole hour."""
    published_at: AwareDatetime
    reference: str
    """GFS cycle and forecast hour."""
    levels: dict[str, WindTexture]

    @model_validator(mode="after")
    def valid_levels(self) -> Self:
        if self.time.minute or self.time.second or self.time.microsecond:
            raise ValueError("wind frame time is not a whole hour")
        if set(self.levels) != set(WIND_LEVELS):
            raise ValueError("wind frame levels differ from the contract")
        for level, texture in self.levels.items():
            match = re.fullmatch(self.path_pattern, texture.path)
            if (
                match is None
                or match.group(1) != level
                or (texture.width, texture.height) != (WIND_WIDTH, WIND_HEIGHT)
                or texture.scale_ms != WIND_SCALES[level]
            ):
                raise ValueError("invalid wind texture")
        return self


class WindManifest(BaseModel):
    generated_at: AwareDatetime
    window_seconds: int
    attribution: str
    frames: list[WindFrameRef]
    """Oldest first."""


class ArchiveWindFrame(WindFrameRef):
    path_pattern: ClassVar[str] = WIND_TEXTURE_PATTERN

    expires_at: AwareDatetime
    """Conservative availability limit, before the bucket's lifecycle grace period."""


class ArchiveWindManifest(BaseModel):
    schema_version: int = Field(
        default=WIND_SCHEMA_VERSION, strict=True, ge=WIND_SCHEMA_VERSION, le=WIND_SCHEMA_VERSION
    )
    day: date
    generated_at: AwareDatetime
    attribution: str = ATTRIBUTION
    frames: list[ArchiveWindFrame] = Field(max_length=MAX_WIND_FRAMES)

    @model_validator(mode="after")
    def valid_frames(self) -> Self:
        times = [f.time.astimezone(UTC) for f in self.frames]
        if any(t.date() != self.day for t in times):
            raise ValueError("archive wind manifest contains a different valid day")
        if any(a >= b for a, b in itertools.pairwise(times)):
            raise ValueError("archive wind frames are not one per hour, oldest first")
        return self


def texture_key(level: str, time: datetime, reference: str) -> str:
    """Relative to `archive/wind/`; a new forecast for the same hour never reuses a cached URL."""
    digest = hashlib.sha256(reference.encode()).hexdigest()[:8]
    return f"{level}/{time:%Y/%m/%d}/{time:%Y%m%dT%HZ}-{digest}.webp"


def index_key(day: date) -> str:
    return f"manifests/{day:%Y-%m-%d}.json"


def encoded(manifest: BaseModel) -> bytes:
    data = manifest.model_dump_json().encode()
    if len(data) > MAX_WIND_MANIFEST_BYTES:
        raise ValueError("wind manifest over the size limit")
    return data


class WindPublisher:
    """`live` and `archive` are stores rooted at `live/wind/` and `archive/wind/`."""

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
        self.frames: list[WindFrameRef] = []

    async def restore(self) -> None:
        data = await self.live.get("manifest.json")
        if data:
            self.frames = WindManifest.model_validate_json(data).frames

    def published(self) -> set[datetime]:
        return {frame.time for frame in self.frames}

    async def publish(
        self, time: datetime, reference: str, textures: dict[str, bytes], now: datetime
    ) -> WindFrameRef:
        """Textures and the day's index, then the live manifest."""
        archived = await self.archive_frame(time, reference, textures, now)
        frame = WindFrameRef(
            **archived.model_dump(exclude={"levels", "expires_at"}),
            levels={
                level: texture.model_copy(
                    update={"path": f"../../archive/wind/{texture.path.removeprefix('../')}"}
                )
                for level, texture in archived.levels.items()
            },
        )
        frames = sorted(
            [f for f in self.frames if f.time != frame.time] + [frame], key=lambda f: f.time
        )
        newest = frames[-1].time
        manifest = WindManifest(
            generated_at=now,
            window_seconds=int(self.window.total_seconds()),
            attribution=self.attribution,
            frames=[f for f in frames if newest - f.time < self.window],
        )
        await self.live.put("manifest.json", encoded(manifest), MANIFEST_HEADERS)
        self.frames = manifest.frames
        return frame

    async def archive_frame(
        self, time: datetime, reference: str, textures: dict[str, bytes], now: datetime
    ) -> ArchiveWindFrame:
        """Writes the textures, then lists them in the index of their valid day, replacing the
        same hour and dropping expired frames."""
        time = time.astimezone(UTC)
        levels = {}
        for level in WIND_LEVELS:
            key = texture_key(level, time, reference)
            await self.archive.put(key, textures[level], TEXTURE_HEADERS)
            levels[level] = WindTexture(
                path=f"../{key}",
                width=WIND_WIDTH,
                height=WIND_HEIGHT,
                size_bytes=len(textures[level]),
                scale_ms=WIND_SCALES[level],
            )
        frame = ArchiveWindFrame(
            time=time,
            published_at=now,
            reference=reference,
            levels=levels,
            expires_at=now + RETENTION,
        )
        frames = await self.day_frames(time.date())
        if frames is None:
            return frame
        kept = [f for f in frames if f.time != time and f.expires_at > now]
        index = ArchiveWindManifest(
            day=time.date(),
            generated_at=now,
            attribution=self.attribution,
            frames=sorted([*kept, frame], key=lambda f: f.time),
        )
        await self.archive.put(index_key(time.date()), encoded(index), MANIFEST_HEADERS)
        return frame

    async def day_frames(self, day: date) -> list[ArchiveWindFrame] | None:
        """Frames of the day's index; None when its version is unknown and it is left alone."""
        data = await self.archive.get(index_key(day))
        if not data:
            return []
        try:
            payload = json.loads(data)
            version = payload.get("schema_version") if isinstance(payload, dict) else None
            if isinstance(version, int) and version != WIND_SCHEMA_VERSION:
                log.error(
                    "unsupported wind archive version; preserving existing index",
                    extra={"fields": {"day": str(day), "version": version}},
                )
                return None
            restored = ArchiveWindManifest.model_validate(payload)
            if restored.day != day:
                raise ValueError("wind archive index has the wrong day")
            return restored.frames
        except ValueError:
            log.warning(
                "rebuilding invalid wind archive index",
                extra={"fields": {"day": str(day)}},
                exc_info=True,
            )
            return []
