"""Rows read and query time of the nearby search on a D1 database (ADR 0027).

uv run --project data python docs/analysis/search/measure.py scintille-search-preview > out.json
Needs SCINTILLE_D1_TOKEN and SCINTILLE_CF_ACCOUNT_ID. Runs the Worker's candidate query through the
D1 REST API, so rows_read and the SQL time are D1's own figures.
"""

import json
import os
import re
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from scintille_pipelines.storm_search import D1Rest, query_tiles

PLACES = {
    "Lyon": (45.8, 4.8),
    "Paris": (48.9, 2.3),
    "Istanbul": (41.0, 29.0),
    "Orlando": (28.5, -81.4),
    "Sao Paulo": (-23.5, -46.6),
    "Kinshasa": (-4.3, 15.3),
    "Jakarta": (-6.2, 106.8),
    "Suva": (-18.1, 178.4),
    "Tromso": (69.6, 19.0),
}
QUERIES = [(72, 200), (168, 500), (168, 3000)]
SOURCE = Path(__file__).parents[3] / "web" / "src" / "search" / "search.ts"
CANDIDATES = re.search(r"CANDIDATES = `(.*?)`;", SOURCE.read_text(), re.S)[1].replace(
    "${SLACK_KM}", "1"
)  # type: ignore[index]


def main() -> None:
    db = D1Rest.from_env(dict(os.environ) | {"SCINTILLE_D1_DATABASE": sys.argv[1]})
    assert db is not None
    now = int(datetime.now(UTC).timestamp())
    rows = []
    for name, (lat, lon) in PLACES.items():
        for hours, km in QUERIES:
            tiles = query_tiles(lat, lon, km)
            start = now - hours * 3600
            keys = [[day, t] for day in range(start // 86400, now // 86400 + 1) for t in tiles]
            began = time.perf_counter()
            params = [json.dumps(keys), str(start), str(now), "4001", str(lat), str(lon), str(km)]
            (result,) = db.run([(CANDIDATES, params)])
            rows.append(
                {
                    "place": name,
                    "hours": hours,
                    "km": km,
                    "keys": len(keys),
                    "candidates": len(result.rows),
                    "rows_read": result.rows_read,
                    "candidate_bytes": len(json.dumps(result.rows)),
                    "rest_ms": round((time.perf_counter() - began) * 1000),
                }
            )
    print(json.dumps({"measured_at": datetime.now(UTC).isoformat(), "queries": rows}, indent=1))


if __name__ == "__main__":
    main()
