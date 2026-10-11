import gzip
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
import scintille_contract
from scintille_contract import chunk, cli, synthetic
from scintille_contract.ids import flash_id
from scintille_contract.models import (
    CHUNK_COLUMNS_BINARY_LAYOUT,
    FlashRecord,
    LiveChunk,
    LiveManifest,
    OpsMetrics,
)

ROOT = Path(__file__).parents[4]
FEED = ROOT / "fixtures" / "live"


def test_package_is_importable() -> None:
    assert scintille_contract.__version__ == "0.1.0"


def test_generated_code_is_up_to_date() -> None:
    assert cli.check(ROOT, base=None) == 0


def test_base_schemas_are_read_from_git() -> None:
    base = cli.base_schemas("HEAD")
    assert base is not None
    assert set(base.files) == {path.name for path in (ROOT / "data/contract").glob("*.json")}
    assert cli.base_schemas("HEAD:does-not-exist") is None


def test_flash_id_is_deterministic() -> None:
    product = "OR_GLM-L2-LCFA_G19_s20261961800000_e20261961800200_c20261961800222.nc"
    first = flash_id("glm-east", product, 42)
    assert first == flash_id("glm-east", product, 42)
    assert len(first) == 32
    assert first != flash_id("glm-east", product, 43)
    assert first != flash_id("glm-west", product, 42)


def test_flash_record_validates() -> None:
    product = "OR_GLM-L2-LCFA_G19_s20261961800000_e20261961800200_c20261961800222.nc"
    event = datetime(2026, 7, 15, 18, 0, 0, 123456, tzinfo=UTC)
    record = FlashRecord(
        flash_id=flash_id("glm-east", product, 7),
        source="glm-east",
        product_file=product,
        native_flash_id=7,
        event_time=event,
        ingest_time=event + timedelta(seconds=31),
        lat=28.5,
        lon=-81.3,
        energy_raw=2.1e-14,
        energy_unit="J",
        intensity=0.42,
        area_km2=180.0,
        duration_ms=240.0,
        quality=[],
    )
    assert FlashRecord.model_validate_json(record.model_dump_json()) == record
    with pytest.raises(ValueError):
        FlashRecord.model_validate({**record.model_dump(), "lat": 91})


def _sample() -> chunk.Chunk:
    return synthetic.chunks(synthetic.generate())[60]


def test_chunk_round_trip_within_quantization() -> None:
    original = _sample()
    decoded = chunk.decode(chunk.encode(original))
    assert decoded.start == original.start
    assert decoded.count == original.count > 0
    for column in CHUNK_COLUMNS_BINARY_LAYOUT:
        before = np.asarray(original.columns[column.name], dtype=np.float64)
        if column.name in ("area_km2", "duration_ms"):
            before = before.clip(0, 65535)
        after = np.asarray(decoded.columns[column.name], dtype=np.float64)
        assert np.abs(before - after).max() <= column.scale / 2 + 1e-9, column.name


def test_chunk_columns_are_aligned() -> None:
    offset = chunk.HEADER.size
    for column in CHUNK_COLUMNS_BINARY_LAYOUT:
        itemsize = np.dtype(column.dtype).itemsize
        assert offset % itemsize == 0
        offset += itemsize


def test_chunk_start_needs_no_alignment_but_whole_seconds() -> None:
    item = _sample()
    shifted = chunk.Chunk(item.start + timedelta(seconds=7), item.columns)
    assert chunk.decode(chunk.encode(shifted)).start == shifted.start
    with pytest.raises(ValueError):
        chunk.encode(chunk.Chunk(item.start + timedelta(milliseconds=500), item.columns))


def test_chunk_json_matches_schema() -> None:
    parsed = LiveChunk.model_validate_json(chunk.to_json(_sample()))
    assert len(parsed.columns.lat) == _sample().count


def test_fixture_manifest_and_chunks_agree() -> None:
    manifest = LiveManifest.model_validate_json((FEED / "manifest.json").read_text())
    assert manifest.chunks[-1].end - manifest.chunks[0].start == timedelta(
        seconds=manifest.window_seconds
    )
    for previous, ref in zip(manifest.chunks, manifest.chunks[1:], strict=False):
        assert ref.start == previous.end
    for ref in manifest.chunks:
        data = (FEED / ref.path).read_bytes()
        assert len(data) == ref.size_bytes
        decoded = chunk.decode(gzip.decompress(data))
        assert decoded.start == ref.start
        assert decoded.count == ref.flash_count
    assert {status.source for status in manifest.sources} == {"glm-east", "glm-west", "mtg-li"}


def test_fixture_metrics_match_the_feed() -> None:
    manifest = LiveManifest.model_validate_json((FEED / "manifest.json").read_text())
    metrics = OpsMetrics.model_validate_json((FEED / "metrics.json").read_text())
    assert metrics.generated_at == manifest.generated_at
    published = sum(sum(s.flashes_per_minute) for s in metrics.sources)
    assert published == sum(ref.flash_count for ref in manifest.chunks)


def test_manifest_accepts_chunks_of_varying_duration() -> None:
    fixture = json.loads((FEED / "manifest.json").read_text())
    start = datetime(2026, 7, 15, 19, 0, tzinfo=UTC)
    refs = []
    for i, seconds in enumerate((30, 20, 20, 30)):
        end = start + timedelta(seconds=seconds)
        refs.append(
            {
                "start": start.isoformat(),
                "end": end.isoformat(),
                "path": f"chunks/{start:%Y%m%dT%H%M%SZ}-{i:02d}.bin.gz",
                "flash_count": 0,
                "size_bytes": 20,
                "event_min": None,
                "event_max": None,
            }
        )
        start = end
    manifest = LiveManifest.model_validate({**fixture, "chunks": refs})
    durations = [(ref.end - ref.start).total_seconds() for ref in manifest.chunks]
    assert durations == [30, 20, 20, 30]
    with pytest.raises(ValueError):
        LiveManifest.model_validate(
            {**fixture, "chunks": [{**refs[0], "path": "chunks/../x.bin.gz"}]}
        )
    with pytest.raises(ValueError):
        LiveManifest.model_validate({**fixture, "chunk_seconds": 0})


def test_fixtures_have_realistic_density_and_fit_budget() -> None:
    manifest = json.loads((FEED / "manifest.json").read_text())
    flashes = sum(ref["flash_count"] for ref in manifest["chunks"])
    assert 40 <= flashes / 3600 <= 50
    sizes = [ref["size_bytes"] for ref in manifest["chunks"]]
    worst_ten_minutes = max(sum(sizes[i : i + 20]) for i in range(len(sizes) - 19))
    assert worst_ten_minutes < 500_000
    assert sum(sizes) < 3_000_000
