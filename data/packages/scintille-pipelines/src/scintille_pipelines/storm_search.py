"""Immutable bounded posting lists over the effective public catalog."""

import hashlib
import json
import unicodedata
from collections import defaultdict
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from typing import cast

import polars as pl
from scintille_contract.models import (
    SCHEMA_VERSION,
    StormSearchManifest,
    StormSearchMarker,
    StormSearchMeta,
    StormSearchPage,
    StormSearchPointer,
    StormSearchRecord,
    StormSearchRegion,
    StormSummary,
)

from .storm_catalog import JSON_HEADERS, CatalogStore

ROOT = "storms/search"
PAGE_BYTES = 65536
REGION_FILE = Path(__file__).with_name("storm-search-regions.json")


def words(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFKD", text)
    # Per-character lowercasing avoids context-sensitive Greek final sigma in JavaScript.
    normalized = "".join(
        c.lower() for c in normalized if not unicodedata.category(c).startswith("M")
    )
    normalized = "".join(c if c.isalnum() else " " for c in normalized)
    return sorted(set(normalized.split()))


def selector_key(selector: str) -> str:
    return hashlib.sha256(selector.encode()).hexdigest()


def search_records(storms: Sequence[StormSummary], names: pl.DataFrame) -> list[StormSearchRecord]:
    geography = json.loads(REGION_FILE.read_text())["groups"]
    regions = {code: region for region, codes in geography.items() for code in codes}
    naming = {row["storm_id"]: row for row in names.iter_rows(named=True)}
    if len(naming) != names.height:
        raise ValueError("duplicate storm naming data")
    records = []
    for storm in storms:
        row = naming.get(storm.storm_id)
        if row is None:
            raise ValueError(f"unresolved search location: {storm.slug}")
        text = " ".join(
            str(value)
            for value in (
                storm.label,
                storm.name,
                storm.country_code,
                *(row.get(key) for key in ("place", "region", "country_name", "sea")),
            )
            if value
        )
        records.append(
            StormSearchRecord(
                **storm.model_dump(
                    include={
                        "slug",
                        "label",
                        "t_start",
                        "t_end",
                        "country_code",
                        "level",
                        "level_name",
                        "flashes",
                        "peak_rate",
                    }
                ),
                region=cast(StormSearchRegion, regions.get(storm.country_code, "unassigned")),
                marker=StormSearchMarker(lat=row["lat"], lon=row["lon"]),
                words=words(text),
            )
        )
    return records


def publish_search(
    store: CatalogStore, records: Sequence[StormSearchRecord], now: datetime
) -> dict[str, int]:
    ordered = sorted(records, key=lambda r: (-r.t_start.timestamp(), r.slug))
    if len({r.slug for r in ordered}) != len(ordered):
        raise ValueError("duplicate search slug")
    digest = hashlib.sha256(SCHEMA_VERSION.encode())
    lists: dict[str, list[StormSearchRecord]] = defaultdict(list)
    for record in ordered:
        body = record.model_dump_json().encode()
        if len(body) > 8192:
            raise ValueError(f"oversized search record: {record.slug}")
        digest.update(body)
        for selector in [
            "all",
            f"region:{record.region}",
            f"level:{record.level}",
            *(f"word:{word}" for word in set(record.words)),
        ]:
            lists[selector].append(record)
    generation = digest.hexdigest()
    prefix = f"{ROOT}/{generation}"
    manifest_path = f"{prefix}/manifest.json"
    previous = store.get(f"{ROOT}/latest.json")
    if previous and StormSearchPointer.model_validate_json(previous).catalog_checked_at > now:
        raise ValueError("search pointer would move backwards")
    objects: dict[str, bytes] = {}
    # Include the empty all-list so a genuinely empty catalog is distinguishable from failure.
    lists.setdefault("all", [])
    for selector, members in lists.items():
        path = f"{prefix}/lists/{selector_key(selector)}"
        page: list[StormSearchRecord] = []
        pages = 0

        def flush(path: str = path) -> None:
            nonlocal pages, page
            body = StormSearchPage(page=pages, storms=page).model_dump_json().encode()
            if len(body) > PAGE_BYTES or pages >= 16777215:
                raise ValueError("search posting capacity exceeded")
            objects[f"{path}/{pages}.json"] = body
            pages += 1
            page = []

        size = 64
        for record in members:
            length = len(record.model_dump_json().encode()) + 1
            if page and (len(page) == 64 or size + length > PAGE_BYTES):
                flush()
                size = 64
            page.append(record)
            size += length
        if page:
            flush()
        objects[f"{path}/meta.json"] = (
            StormSearchMeta(selector=selector, count=len(members), page_count=pages)
            .model_dump_json()
            .encode()
        )
    manifest = StormSearchManifest(
        schema_version=SCHEMA_VERSION,
        generation=generation,
        published_at=now,
        last_observation_time=max((r.t_end for r in ordered), default=None),
        total_storms=len(ordered),
    )
    immutable = {**JSON_HEADERS, "Cache-Control": "public, max-age=31536000, immutable"}
    if not store.exists(manifest_path):
        for path, body in objects.items():
            store.put(path, body, immutable)
        store.put(manifest_path, manifest.model_dump_json().encode(), immutable)
    pointer = StormSearchPointer(
        schema_version=SCHEMA_VERSION, generation=generation, catalog_checked_at=now
    )
    store.put(f"{ROOT}/latest.json", pointer.model_dump_json().encode(), JSON_HEADERS)
    return {
        "search_records": len(ordered),
        "search_objects": len(objects) + 1,
        "search_bytes": sum(map(len, objects.values())),
        "search_unassigned": sum(r.region == "unassigned" for r in ordered),
    }
