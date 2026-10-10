# Archive queries

`scintille_lake.access` reads `silver.flashes` through DuckDB attached to the Iceberg REST catalog
([lakehouse](lakehouse.md)). Filters on `event_time` and `source` prune partitions (day, source) and
data files (min/max of `event_time`), so one hour reads one hour of files.

```python
from datetime import UTC, datetime

import duckdb
import polars as pl
from scintille_lake.access import BBox, files_read, flashes
from scintille_lake.connect import duckdb_attach

con = duckdb.connect()
duckdb_attach(con)  # local Lakekeeper, or R2 Data Catalog from SCINTILLE_LAKE_* variables

t0 = datetime(2026, 7, 15, 18, tzinfo=UTC)
t1 = datetime(2026, 7, 15, 19, tzinfo=UTC)
congo = BBox(west=10, south=-10, east=35, north=10)

frame = pl.from_arrow(flashes(con, t0, t1, congo, sources=["mtg-li"]))
files_read(con, t0, t1, congo, sources=["mtg-li"])  # data files actually opened
```

- `BBox` with `west > east` crosses the antimeridian.
- Times must be timezone-aware; the interval is `[t0, t1)`.
- In a Dagster asset, take the connection from the `lake` resource: `with lake.duckdb() as con: ...`.
- `relation=` points the same query at another table expression, such as
  `iceberg_scan('<metadata.json>')` in tests.
