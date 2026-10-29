"""Finds, downloads and decodes the satellite files of one hourly composite slot (ADR 0023)."""

import logging
import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from functools import partial
from pathlib import Path
from typing import Protocol

import obstore
from obstore.store import ObjectStore

from scintille_ingest.mtg.discovery import Listed

from . import abi, ahi, fci
from .composite import Satellite, SkinAt, heights
from .disk import mapped

log = logging.getLogger("scintille_ingest.clouds")

GOES_BUCKETS = {"goes19": "noaa-goes19", "goes18": "noaa-goes18"}
HIMAWARI_BUCKET = "noaa-himawari9"
SCAN = timedelta(minutes=10)
"""Each satellite's full disk scan that starts within this time after the slot is used."""
DOWNLOADS = 8
ATTEMPTS = 3
_datastore = threading.BoundedSemaphore(4)
"""The EUMETSAT Data Store throttles parallel downloads; the live LI ingest shares the account."""


class FciStore(Protocol):
    """The EUMETSAT Data Store, as `mtg.discovery.EumdacStore` gives it."""

    def search(self, start: datetime, end: datetime) -> list[Listed]: ...

    def fetch(self, product_id: str, entry: str) -> bytes: ...


@dataclass(frozen=True)
class SlotFiles:
    slot: datetime
    abi: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    """Satellite to band to object key."""
    ahi: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    """Band to segment keys."""
    fci: tuple[str, tuple[str, ...]] | None = None
    """Product id and body chunk entries."""

    @property
    def complete_satellites(self) -> list[str]:
        out = [s for s, bands in self.abi.items() if {abi.VISIBLE, abi.INFRARED} <= set(bands)]
        if all(len(self.ahi.get(b, ())) == ahi.SEGMENTS for b in (ahi.VISIBLE, ahi.INFRARED)):
            out.append("himawari09")
        if self.fci and len(self.fci[1]) == fci.CHUNKS:
            out.append("mtg-i1")
        return out

    @property
    def complete(self) -> bool:
        return len(self.complete_satellites) == len(GOES_BUCKETS) + 2

    @property
    def product(self) -> str:
        """Names the inputs; a frame rendered from other inputs gets other texture names."""
        return f"composite-v1_{self.slot:%Y%m%dT%H%M}Z_{'+'.join(sorted(self.complete_satellites))}"


class Sources:
    def __init__(
        self,
        goes: Mapping[str, ObjectStore],
        himawari: ObjectStore,
        mtg: FciStore | None,
    ) -> None:
        self.goes = goes
        self.himawari = himawari
        self.mtg = mtg

    def find(self, slot: datetime) -> SlotFiles:
        abi_files: dict[str, dict[str, str]] = {}
        for satellite, store in self.goes.items():
            for goes in abi.list_files(store, slot, slot + SCAN):
                abi_files.setdefault(satellite, {}).setdefault(goes.band, goes.key)
        ahi_files: dict[str, list[str]] = {}
        for segment in ahi.list_files(self.himawari, slot):
            ahi_files.setdefault(segment.band, []).append(segment.key)
        chunks = None
        if self.mtg is not None:
            listed = [
                p
                for p in self.mtg.search(slot, slot + SCAN)
                if fci.product_start(p.product_id) >= slot
            ]
            if listed:
                first = min(listed, key=lambda p: fci.product_start(p.product_id))
                entries = tuple(sorted(e for e in first.entries if fci.is_body_chunk(e)))
                chunks = (first.product_id, entries)
        return SlotFiles(
            slot, abi_files, {b: tuple(sorted(k)) for b, k in ahi_files.items()}, chunks
        )

    def download(self, files: SlotFiles, directory: Path) -> dict[str, list[Path]]:
        """Files of the complete satellites, by satellite and channel (`<satellite>/<band>`)."""
        jobs: list[tuple[str, Callable[[Path], None], Path]] = []
        complete = files.complete_satellites
        for satellite, bands in files.abi.items():
            if satellite not in complete:
                continue
            for band, key in bands.items():
                store = self.goes[satellite]
                jobs.append(
                    (f"{satellite}/{band}", _getter(store, key), directory / Path(key).name)
                )
        if "himawari09" in complete:
            for band, keys in files.ahi.items():
                for key in keys:
                    jobs.append(
                        (
                            f"himawari09/{band}",
                            _getter(self.himawari, key),
                            directory / Path(key).name,
                        )
                    )
        if "mtg-i1" in complete and files.fci and self.mtg is not None:
            product, entries = files.fci
            mtg = self.mtg
            for entry in entries:
                save = partial(_save, mtg.fetch, product, entry)
                jobs.append(("mtg-i1/chunks", save, directory / entry))
        directory.mkdir(parents=True, exist_ok=True)

        def run(job: tuple[str, Callable[[Path], None], Path]) -> tuple[str, Path]:
            name, write, target = job
            for attempt in range(ATTEMPTS):
                try:
                    if name == "mtg-i1/chunks":
                        with _datastore:
                            write(target)
                    else:
                        write(target)
                    return name, target
                except Exception:
                    if attempt == ATTEMPTS - 1:
                        raise
                    log.warning("cloud download retried", extra={"fields": {"file": target.name}})
                    time.sleep(2**attempt)
            raise AssertionError("unreachable")

        out: dict[str, list[Path]] = {}
        with ThreadPoolExecutor(DOWNLOADS) as pool:
            for name, path in pool.map(run, jobs):
                out.setdefault(name, []).append(path)
        return out


def _getter(store: ObjectStore, key: str) -> Callable[[Path], None]:
    """Streams the object to a file, so big disks never sit whole in memory."""

    def write(target: Path) -> None:
        with target.open("wb") as file:
            for chunk in obstore.get(store, key).stream(min_chunk_size=8 << 20):
                file.write(chunk)

    return write


def _save(fetch: Callable[[str, str], bytes], product: str, entry: str, target: Path) -> None:
    target.write_bytes(fetch(product, entry))


def decode(
    downloaded: Mapping[str, list[Path]], directory: Path, skin_at: SkinAt
) -> list[Satellite]:
    """Decodes every complete satellite into memory-mapped disks under `directory`."""
    allocate = mapped(directory)
    satellites = []
    for satellite in GOES_BUCKETS:
        ir = downloaded.get(f"{satellite}/{abi.INFRARED}")
        vis = downloaded.get(f"{satellite}/{abi.VISIBLE}")
        if ir and vis:
            infrared = abi.read(ir[0], satellite, allocate)
            satellites.append(
                Satellite(
                    infrared, abi.read(vis[0], satellite, allocate), heights(infrared, skin_at)
                )
            )
    ir = downloaded.get(f"himawari09/{ahi.INFRARED}")
    vis = downloaded.get(f"himawari09/{ahi.VISIBLE}")
    if ir and vis:
        infrared = ahi.read(ir, "himawari09", allocate)
        satellites.append(
            Satellite(infrared, ahi.read(vis, "himawari09", allocate), heights(infrared, skin_at))
        )
    chunks = downloaded.get("mtg-i1/chunks")
    if chunks:
        infrared = fci.read(chunks, fci.INFRARED, allocate)
        satellites.append(
            Satellite(infrared, fci.read(chunks, fci.VISIBLE, allocate), heights(infrared, skin_at))
        )
    return satellites
