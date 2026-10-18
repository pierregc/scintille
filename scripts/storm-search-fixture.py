"""Generate a synthetic R2 search fixture or benchmark in temporary storage.

Run from data/: uv run python ../scripts/storm-search-fixture.py --out /tmp/storm-search --count 10000
The default single-record fixture replays the existing synthetic Orlando storm.
Larger catalogs are search benchmarks only: their synthetic slugs do not have replay data.
"""

import argparse
import json
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from scintille_contract.models import SCHEMA_VERSION, StormSearchMarker, StormSearchRecord
from scintille_pipelines.storm_search import publish_search


class DirectoryStore:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.written_bytes = 0
        self.writes = 0

    def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
        target = self.directory / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        self.written_bytes += len(data)
        self.writes += 1

    def get(self, path: str) -> bytes | None:
        target = self.directory / path
        return target.read_bytes() if target.exists() else None

    def exists(self, path: str) -> bool:
        return (self.directory / path).exists()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--count', type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.count <= 100000:
        parser.error('count must be between 1 and 100000')
    root = Path(__file__).resolve().parents[1]
    fixture = json.loads((root / 'fixtures/storms/2026-07-15-orlando.json').read_text())
    summary = fixture['storm']
    now = datetime(2026, 10, 18, 12, tzinfo=UTC)
    records = []
    for i in range(args.count):
        records.append(StormSearchRecord(
            slug=summary['slug'] if args.count == 1 else f'synthetic-{i:06}',
            label=summary['label'] if args.count == 1 else f'Synthetic storm {i}',
            t_start=summary['t_start'] if args.count == 1 else now - timedelta(minutes=i),
            t_end=summary['t_end'] if args.count == 1 else now - timedelta(minutes=i) + timedelta(minutes=30),
            country_code='US', region='north-america', level=summary['level'] if args.count == 1 else 1 + i % 5,
            level_name=summary['level_name'] if args.count == 1 else ['Light', 'Moderate', 'Strong', 'Intense', 'Exceptional'][i % 5],
            flashes=summary['flashes'], peak_rate=summary['peak_rate'],
            marker=StormSearchMarker(lat=28.5, lon=-81.4),
            words=['florida', 'orlando', 'united', 'states', 'us'] if args.count == 1 else ['synthetic', 'us', 'united', 'states', f'place{i % 100}', f'region{i % 10}'],
        ))
    store = DirectoryStore(args.out)
    started = time.perf_counter()
    metrics = publish_search(store, records, now)
    elapsed = time.perf_counter() - started
    print(json.dumps({'schema_version': SCHEMA_VERSION, 'synthetic': True, 'count': args.count,
                      'seconds': round(elapsed, 3), 'objects_written': store.writes,
                      'bytes_written': store.written_bytes, 'words_per_storm': len(records[0].words), **metrics}))


if __name__ == '__main__':
    main()
