"""Synthetic but realistic live feed: storm cells over GOES GLM and MTG LI coverage."""

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from scintille_contract import chunk
from scintille_contract.models import (
    QUALITY_FLAG_VALUES,
    SCHEMA_VERSION,
    SOURCE_VALUES,
    ChunkRef,
    LiveManifest,
    SourceStatus,
)

WINDOW_START = datetime(2026, 7, 15, 18, 0, tzinfo=UTC)
WINDOW_SECONDS = 3600
SEED = 29
TARGET_RATE = 45.0
EARTH_RADIUS_KM = 6371.0

# Sub-satellite longitude, product file period (s), max central angle of usable coverage (deg).
SATELLITES = {
    "glm-east": (-75.2, 20, 50.0),
    "glm-west": (-137.2, 20, 50.0),
    "mtg-li": (0.0, 30, 60.0),
}
# Afternoon and evening convection at 18-19 UTC in July: lat range, lon range, weight.
REGIONS = (
    ((-5.0, 10.0), (10.0, 32.0), 0.20),
    ((8.0, 16.0), (-12.0, 10.0), 0.10),
    ((-10.0, 8.0), (-75.0, -50.0), 0.14),
    ((10.0, 22.0), (-100.0, -82.0), 0.12),
    ((25.0, 36.0), (-98.0, -78.0), 0.12),
    ((34.0, 46.0), (-105.0, -88.0), 0.07),
    ((25.0, 35.0), (-115.0, -103.0), 0.04),
    ((3.0, 10.0), (-112.0, -84.0), 0.04),
    ((40.0, 50.0), (2.0, 28.0), 0.08),
    ((3.0, 10.0), (-40.0, -15.0), 0.03),
    ((5.0, 16.0), (32.0, 46.0), 0.04),
    ((-30.0, -20.0), (-60.0, -45.0), 0.02),
)
OUTAGE_SOURCE = "glm-west"
OUTAGE_SECONDS = 240


@dataclass(frozen=True)
class Flashes:
    """Synthetic flashes; times are seconds relative to WINDOW_START."""

    event: NDArray[np.float64]
    ingest: NDArray[np.float64]
    lat: NDArray[np.float64]
    lon: NDArray[np.float64]
    area_km2: NDArray[np.float64]
    duration_ms: NDArray[np.float64]
    energy_raw: NDArray[np.float64]
    intensity: NDArray[np.float64]
    source: NDArray[np.uint8]
    quality: NDArray[np.uint8]
    file_start: NDArray[np.float64]
    native_id: NDArray[np.int64]


def _cells(rng: np.random.Generator) -> dict[str, NDArray[Any]]:
    weights = np.array([w for *_, w in REGIONS])
    n = 4000
    region = rng.choice(len(REGIONS), size=n, p=weights / weights.sum())
    lat_range = np.array([r[0] for r in REGIONS])[region]
    lon_range = np.array([r[1] for r in REGIONS])[region]
    peak = rng.lognormal(np.log(0.25), 1.0, n).clip(0.02, 6.0)
    life = rng.uniform(1800, 7200, n)
    birth = rng.uniform(-7500, WINDOW_SECONDS, n)
    mean_rate_in_window = (
        peak
        / 2
        * np.clip(
            (np.minimum(birth + life, WINDOW_SECONDS) - np.maximum(birth, 0)) / WINDOW_SECONDS, 0, 1
        )
    )
    keep = np.cumsum(mean_rate_in_window) <= TARGET_RATE
    speed_kmh = rng.uniform(10, 60, n)
    heading = rng.uniform(0, 2 * np.pi, n)
    return {
        "lat": rng.uniform(lat_range[:, 0], lat_range[:, 1])[keep],
        "lon": rng.uniform(lon_range[:, 0], lon_range[:, 1])[keep],
        "vlat": (speed_kmh * np.cos(heading) / 3600 / 111.2)[keep],
        "vlon": (speed_kmh * np.sin(heading) / 3600 / 111.2)[keep],
        "peak": peak[keep],
        "life": life[keep],
        "birth": birth[keep],
        "sigma_km": rng.lognormal(np.log(12), 0.5, n).clip(4, 60)[keep],
    }


def _central_angle(lat: NDArray[np.float64], lon: NDArray[np.float64], sub_lon: float) -> Any:
    return np.degrees(np.arccos(np.cos(np.radians(lat)) * np.cos(np.radians(lon - sub_lon))))


def generate(seed: int = SEED) -> Flashes:
    rng = np.random.default_rng(seed)
    cells = _cells(rng)
    seconds = np.arange(-180, WINDOW_SECONDS, dtype=np.float64)
    phase = (seconds[None, :] - cells["birth"][:, None]) / cells["life"][:, None]
    envelope = np.where((phase > 0) & (phase < 1), np.sin(np.pi * phase) ** 2, 0)
    counts = rng.poisson(cells["peak"][:, None] * envelope)
    cell, second = np.nonzero(counts)
    repeat = counts[cell, second]
    cell, second = np.repeat(cell, repeat), np.repeat(second, repeat)
    n = len(cell)
    event = seconds[second] + rng.uniform(0, 1, n)

    age = event - cells["birth"][cell]
    lat_c = cells["lat"][cell] + cells["vlat"][cell] * age
    lon_c = cells["lon"][cell] + cells["vlon"][cell] * age
    spread = cells["sigma_km"][cell] / 111.2
    lat = np.clip(lat_c + rng.normal(0, 1, n) * spread, -89.9, 89.9)
    lon = lon_c + rng.normal(0, 1, n) * spread / np.cos(np.radians(lat))
    lon = (lon + 180) % 360 - 180

    angles = np.stack([_central_angle(lat, lon, sub) for sub, *_ in SATELLITES.values()])
    limits = np.array([limit for *_, limit in SATELLITES.values()])[:, None]
    covered = angles < limits
    source = np.argmin(np.where(covered, angles, np.inf), axis=0).astype(np.uint8)
    visible = covered.any(axis=0)
    edge = np.take_along_axis(angles, source[None, :].astype(np.intp), 0)[0] > limits[source, 0] - 6
    quality = (
        (rng.uniform(0, 1, n) < 0.01).astype(np.uint8)
        | (edge.astype(np.uint8) << 1)
        | ((covered.sum(axis=0) > 1).astype(np.uint8) << 2)
    )

    period = np.array([p for _, p, _ in SATELLITES.values()], dtype=np.float64)[source]
    file_start = np.floor(event / period) * period
    file_key = file_start * 4 + source
    keys, file_of = np.unique(file_key, return_inverse=True)
    latency = rng.uniform(12, 35, len(keys))[file_of]
    ingest = file_start + period + latency
    native_id = np.zeros(n, dtype=np.int64)
    order = np.lexsort((event, file_of))
    rank = np.arange(n) - np.searchsorted(file_of[order], file_of[order])
    native_id[order] = rank

    area = rng.lognormal(np.log(150), 0.9, n).clip(10, 20000)
    duration = rng.lognormal(np.log(250), 0.8, n).clip(2, 5000)
    is_li = source == SOURCE_VALUES.index("mtg-li")
    noise = rng.lognormal(0, 0.7, n)
    energy = np.where(is_li, 40.0, 2e-14) * (area / 150) ** 0.8 * noise
    lo, hi = np.where(is_li, 0.0, -15.5), np.where(is_li, 4.0, -11.5)
    intensity = np.clip((np.log10(energy) - lo) / (hi - lo), 0, 1)

    outage = (source == SOURCE_VALUES.index(OUTAGE_SOURCE)) & (
        ingest >= WINDOW_SECONDS - OUTAGE_SECONDS
    )
    keep = visible & ~outage & (ingest >= 0) & (ingest < WINDOW_SECONDS)
    order = np.argsort(event[keep], kind="stable")
    return Flashes(
        event=event[keep][order],
        ingest=ingest[keep][order],
        lat=lat[keep][order],
        lon=lon[keep][order],
        area_km2=area[keep][order],
        duration_ms=duration[keep][order],
        energy_raw=energy[keep][order],
        intensity=intensity[keep][order],
        source=source[keep][order],
        quality=quality[keep][order],
        file_start=file_start[keep][order],
        native_id=native_id[keep][order],
    )


def chunks(flashes: Flashes) -> list[chunk.Chunk]:
    """Split flashes by 30-second ingest window, each sorted by event time."""
    index = np.floor(flashes.ingest / chunk.CHUNK_SECONDS).astype(np.int64)
    result = []
    for i in range(WINDOW_SECONDS // chunk.CHUNK_SECONDS):
        sel = index == i
        start = i * chunk.CHUNK_SECONDS
        columns = {
            "event_offset_ms": np.rint((flashes.event[sel] - start) * 1000),
            "lat": flashes.lat[sel],
            "lon": flashes.lon[sel],
            "area_km2": flashes.area_km2[sel],
            "duration_ms": flashes.duration_ms[sel],
            "intensity": flashes.intensity[sel],
            "source": flashes.source[sel],
            "quality": flashes.quality[sel],
        }
        result.append(chunk.Chunk(WINDOW_START + timedelta(seconds=start), columns))
    return result


def _at(seconds: float) -> datetime:
    return WINDOW_START + timedelta(microseconds=round(seconds * 1e6))


def manifest(flashes: Flashes, refs: list[ChunkRef]) -> LiveManifest:
    statuses = []
    for i, name in enumerate(SOURCE_VALUES):
        sel = flashes.source == i
        delayed = name == OUTAGE_SOURCE
        statuses.append(
            SourceStatus(
                source=name,
                state="delayed" if delayed else "live",
                last_event_time=_at(float(flashes.event[sel].max())),
                last_ingest_time=_at(float(flashes.ingest[sel].max())),
            )
        )
    return LiveManifest(
        schema_version=SCHEMA_VERSION,
        generated_at=WINDOW_START + timedelta(seconds=WINDOW_SECONDS),
        chunk_seconds=30,
        window_seconds=3600,
        chunks=refs,
        sources=statuses,
    )


def write_feed(out: Path) -> None:
    """Write manifest.json and chunks/ for the fixture window."""
    flashes = generate()
    (out / "chunks").mkdir(parents=True, exist_ok=True)
    for stale in (out / "chunks").glob("*.bin.gz"):
        stale.unlink()
    refs = []
    for item in chunks(flashes):
        data = chunk.compress(chunk.encode(item))
        path = chunk.chunk_name(item.start)
        (out / path).write_bytes(data)
        start = (item.start - WINDOW_START).total_seconds()
        offsets = item.columns["event_offset_ms"]
        refs.append(
            ChunkRef(
                start=item.start,
                path=path,
                flash_count=item.count,
                size_bytes=len(data),
                event_min=_at(start + offsets.min() / 1000) if item.count else None,
                event_max=_at(start + offsets.max() / 1000) if item.count else None,
            )
        )
    document = manifest(flashes, refs).model_dump(mode="json")
    (out / "manifest.json").write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    flags = ", ".join(QUALITY_FLAG_VALUES)
    print(f"wrote {len(refs)} chunks, {len(flashes.event)} flashes (quality bits: {flags})")
