"""Bounded storm documents, immutable replay chunks, then indexes and sitemaps."""

import hashlib
import json
import logging
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Protocol
from xml.etree import ElementTree as ET

import obstore
import polars as pl
from obstore.store import ObjectStore
from scintille_contract.chunk import Chunk, compress, encode
from scintille_contract.models import (
    SCHEMA_VERSION,
    StormChunkRef,
    StormDetail,
    StormHighlights,
    StormIndexPage,
    StormReplay,
    StormSummary,
)
from scintille_ingest.runtime.live_feed import columns

DETAIL_MAX_BYTES = 256 * 1024
IO_THREADS = 16
INDEX_PAGE_SIZE = 50
CHUNK_FLASHES = 65536
SITEMAP_URLS = 50000
SITEMAP_BYTES = 50 * 1024 * 1024
XMLNS = "http://www.sitemaps.org/schemas/sitemap/0.9"
ET.register_namespace("", XMLNS)
JSON_HEADERS = {"Content-Type": "application/json", "Cache-Control": "public, max-age=60"}
CHUNK_HEADERS = {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
}
HIGHLIGHTS_PATH = "storms/highlights.json"
PURGE_PATH = "_pipeline/storms/purge.json"
PUBLISHED_PATH = "_pipeline/storms/published.json"
log = logging.getLogger(__name__)


class CatalogStore(Protocol):
    def put(self, path: str, data: bytes, headers: dict[str, str]) -> None: ...

    def get(self, path: str) -> bytes | None: ...

    def exists(self, path: str) -> bool: ...


class ObjectCatalogStore:
    def __init__(self, store: ObjectStore) -> None:
        self.store = store

    def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
        obstore.put(self.store, path, data, attributes=headers)

    def get(self, path: str) -> bytes | None:
        try:
            return obstore.get(self.store, path).bytes().to_bytes()
        except FileNotFoundError:
            return None

    def exists(self, path: str) -> bool:
        try:
            obstore.head(self.store, path)
            return True
        except FileNotFoundError:
            return False


def published_slugs(store: CatalogStore) -> set[str]:
    return set(json.loads(store.get(PUBLISHED_PATH) or b"[]"))


def selected_flashes(flashes: pl.DataFrame, tracks: pl.DataFrame) -> pl.DataFrame:
    """Track-window bounds selection, explicitly broader than exact cell membership."""
    selected = []
    for step in tracks.iter_rows(named=True):
        lon = pl.col("lon")
        longitude = (
            lon.is_between(step["west"], step["east"])
            if step["west"] <= step["east"]
            else (lon >= step["west"]) | (lon <= step["east"])
        )
        selected.append(
            flashes.filter(
                pl.col("event_time").is_between(
                    step["window_start"], step["window_end"], closed="left"
                )
                & pl.col("lat").is_between(step["south"], step["north"])
                & longitude
            )
        )
    if not selected:
        return flashes.clear()
    return pl.concat(selected).unique("flash_id").sort("event_time", "flash_id")


def replay_chunks(flashes: pl.DataFrame) -> tuple[StormReplay, dict[str, bytes]]:
    refs: list[StormChunkRef] = []
    objects: dict[str, bytes] = {}
    if not flashes.is_empty():
        hours = flashes.with_columns(pl.col("event_time").dt.truncate("1h").alias("hour"))
        for (hour,), frame in hours.partition_by("hour", as_dict=True, maintain_order=True).items():
            assert isinstance(hour, datetime)
            for part in frame.iter_slices(CHUNK_FLASHES):
                body = compress(encode(Chunk(hour, columns(part, hour))))
                path = f"storms/chunks/{hashlib.sha256(body).hexdigest()}.bin.gz"
                objects[path] = body
                first, last = part["event_time"].min(), part["event_time"].max()
                assert isinstance(first, datetime) and isinstance(last, datetime)
                refs.append(
                    StormChunkRef(
                        start=hour,
                        end=hour + timedelta(hours=1),
                        path=path,
                        flash_count=part.height,
                        size_bytes=len(body),
                        event_min=first,
                        event_max=last,
                    )
                )
    return StormReplay(selection="track-bounds", flash_count=flashes.height, chunks=refs), objects


def index_pages(storms: Sequence[StormSummary], now: datetime) -> list[StormIndexPage]:
    ordered = sorted(storms, key=lambda storm: (storm.t_start, storm.storm_id), reverse=True)
    count = max(1, (len(ordered) + INDEX_PAGE_SIZE - 1) // INDEX_PAGE_SIZE)
    last = max((storm.t_end for storm in ordered), default=None)
    return [
        StormIndexPage(
            schema_version=SCHEMA_VERSION,
            published_at=now,
            last_observation_time=last,
            page=page,
            page_size=INDEX_PAGE_SIZE,
            total_storms=len(ordered),
            total_pages=count,
            storms=ordered[page * INDEX_PAGE_SIZE : (page + 1) * INDEX_PAGE_SIZE],
        )
        for page in range(count)
    ]


def _xml(root: ET.Element, now: datetime, last: datetime | None) -> bytes:
    stamp = now.isoformat().replace("+00:00", "Z")
    observation = last.isoformat().replace("+00:00", "Z") if last else "unknown"
    metadata = (
        f"<!-- schema_version={SCHEMA_VERSION} published_at={stamp} "
        f"last_observation_time={observation} -->\n"
    ).encode()
    return b'<?xml version="1.0" encoding="utf-8"?>\n' + metadata + ET.tostring(root)


def sitemaps(
    storms: Sequence[StormSummary], now: datetime, region_codes: Sequence[str] = ()
) -> dict[str, bytes]:
    objects: dict[str, bytes] = {}
    last = max((storm.t_end for storm in storms), default=None)
    urls = [(f"https://scintille.app/storms/{s.slug}", s.t_end) for s in storms]
    urls.extend((f"https://scintille.app/live/{code.lower()}", now) for code in region_codes)
    root = ET.Element(f"{{{XMLNS}}}urlset")
    count = 0
    size = len(_xml(root, now, last))
    for location, modified in urls:
        element = ET.Element(f"{{{XMLNS}}}url")
        ET.SubElement(element, f"{{{XMLNS}}}loc").text = location
        ET.SubElement(element, f"{{{XMLNS}}}lastmod").text = modified.isoformat()
        element_size = len(ET.tostring(element))
        if count == SITEMAP_URLS or size + element_size > SITEMAP_BYTES:
            objects[f"sitemaps/pages-{len(objects)}.xml"] = _xml(root, now, last)
            root = ET.Element(f"{{{XMLNS}}}urlset")
            count = 0
            size = len(_xml(root, now, last))
        root.append(element)
        size += element_size
        count += 1
    objects[f"sitemaps/pages-{len(objects)}.xml"] = _xml(root, now, last)
    index = ET.Element(f"{{{XMLNS}}}sitemapindex")
    for path in objects:
        entry = ET.SubElement(index, f"{{{XMLNS}}}sitemap")
        ET.SubElement(entry, f"{{{XMLNS}}}loc").text = f"https://scintille.app/{path}"
        ET.SubElement(entry, f"{{{XMLNS}}}lastmod").text = now.isoformat()
    objects["sitemaps/index.xml"] = _xml(index, now, last)
    return objects


def content(document: StormDetail) -> dict[str, object]:
    result: dict[str, object] = document.model_dump(mode="json")
    result.pop("published_at")
    return result


def publish_catalog(
    store: CatalogStore,
    details: Sequence[StormDetail],
    chunks: dict[str, bytes],
    all_storms: Sequence[StormSummary],
    now: datetime,
    purge: Callable[[list[str]], bool],
    region_codes: Sequence[str] = (),
    highlights: Callable[[Sequence[StormSummary]], StormHighlights | None] | None = None,
) -> dict[str, int]:
    with ThreadPoolExecutor(IO_THREADS) as pool:
        paths = [f"storms/{detail.storm.slug}.json" for detail in details]
        stored = dict(zip(paths, pool.map(store.get, paths), strict=True))
        accepted = []
        skipped = set()
        previous_summaries: dict[str, StormSummary] = {}
        bodies = {}
        for detail in details:
            path = f"storms/{detail.storm.slug}.json"
            body = detail.model_dump_json().encode()
            if len(body) > DETAIL_MAX_BYTES:
                skipped.add(detail.storm.slug)
                log.warning(
                    "Skipping oversized storm metadata: %s (%d bytes)", detail.storm.slug, len(body)
                )
                previous = stored[path]
                if previous is not None:
                    previous_summaries[detail.storm.slug] = StormDetail.model_validate_json(
                        previous
                    ).storm
                continue
            accepted.append(detail)
            bodies[path] = body
        details = accepted
        all_storms = [
            previous_summaries.get(storm.slug, storm)
            for storm in all_storms
            if storm.slug not in skipped or storm.slug in previous_summaries
        ]
        published = published_slugs(store)
        # Validate every reference before the first mutation.
        refs = {ref.path for detail in details for ref in detail.replay.chunks} - chunks.keys()
        for path, found in zip(refs, pool.map(store.get, refs), strict=True):
            if found is None:
                raise ValueError(f"missing replay chunk: {path}")
        unknown = [
            f"storms/{storm.slug}.json"
            for storm in all_storms
            if storm.slug not in published and f"storms/{storm.slug}.json" not in bodies
        ]
        for path, found in zip(unknown, pool.map(store.get, unknown), strict=True):
            if found is None:
                raise ValueError(
                    f"missing storm detail: {path.removeprefix('storms/').removesuffix('.json')}"
                )
        pending = set(json.loads(store.get(PURGE_PATH) or b"[]"))
        referenced = {ref.path for detail in details for ref in detail.replay.chunks}
        list(
            pool.map(
                lambda path: store.put(path, chunks[path], CHUNK_HEADERS),
                referenced & chunks.keys(),
            )
        )
        changed = []
        for detail in details:
            path = f"storms/{detail.storm.slug}.json"
            previous = stored[path]
            if previous is not None:
                old = StormDetail.model_validate_json(previous)
                if content(old) == content(detail):
                    continue
                if old.storm.closed:
                    pending.update([f"storm:{detail.storm.slug}", "storms-index"])
                    for code in (old.storm.country_code, detail.storm.country_code):
                        if code:
                            pending.add(f"region:{code}")
            changed.append(path)
        # Save invalidation intent before writing the changed documents.
        if changed:
            store.put(PURGE_PATH, json.dumps(sorted(pending)).encode(), JSON_HEADERS)
        list(pool.map(lambda path: store.put(path, bodies[path], JSON_HEADERS), changed))
    published.update(storm.slug for storm in all_storms)
    store.put(PUBLISHED_PATH, json.dumps(sorted(published)).encode(), JSON_HEADERS)
    for page in index_pages(all_storms, now):
        store.put(f"storms/index/{page.page}.json", page.model_dump_json().encode(), JSON_HEADERS)
    picked = highlights(all_storms) if highlights is not None else None
    if picked is not None:
        store.put(HIGHLIGHTS_PATH, picked.model_dump_json().encode(), JSON_HEADERS)
    available_regions = [code for code in region_codes if store.exists(f"regions/{code}.json")]
    for path, body in sitemaps(all_storms, now, available_regions).items():
        store.put(path, body, {"Content-Type": "application/xml", "Cache-Control": "max-age=60"})
    tags = sorted(pending)
    # One batch per run; hourly retries stay within the Free request limit.
    batch = tags[:100]
    if batch:
        try:
            if purge(batch):
                pending.difference_update(batch)
        except OSError:
            log.exception("Cache purge transport failed; pending tags retry on the next run")
    store.put(PURGE_PATH, json.dumps(sorted(pending)).encode(), JSON_HEADERS)
    return {
        "changed": len(changed),
        "storms": len(all_storms),
        "skipped_storms": len(skipped),
        "pending_purge_tags": len(pending),
        "highlights": len(picked.highlights) if picked is not None else 0,
    }
