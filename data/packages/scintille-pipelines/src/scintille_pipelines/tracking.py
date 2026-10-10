"""Storm cells of consecutive windows linked into storms."""

from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np
import polars as pl
from scipy.spatial import cKDTree  # type: ignore[import-untyped]

from .clustering import EARTH_RADIUS_KM, KM_PER_DEGREE, Floats, unit_xyz

HOUR = timedelta(hours=1)


@dataclass(frozen=True)
class TrackParams:
    """A cell continues a cell of the previous window when they are close in time and space.

    Close in space: the hulls intersect, or the discs with their areas overlap once the
    earlier one may have moved at `max_speed_kmh` during the gap between them.
    """

    max_speed_kmh: float
    max_gap_minutes: float

    def __str__(self) -> str:
        speed, gap = f"{self.max_speed_kmh:g}", f"{self.max_gap_minutes:g}"
        return f"tracking max_speed_kmh={speed} max_gap_minutes={gap}"


TIME = pl.Datetime("us", "UTC")
TRACK_SCHEMA = pl.Schema(
    {
        "storm_id": pl.String(),
        "storm_start": TIME,
        "window_start": TIME,
        "window_end": TIME,
        "cell_id": pl.String(),
        "previous_cell_id": pl.String(),
        "split_from": pl.String(),
        "merged": pl.List(pl.String()),
        "t_start": TIME,
        "t_end": TIME,
        "flash_count": pl.Int64(),
        "hour_flash_count": pl.Int64(),
        "lat": pl.Float64(),
        "lon": pl.Float64(),
        "west": pl.Float64(),
        "south": pl.Float64(),
        "east": pl.Float64(),
        "north": pl.Float64(),
        "area_km2": pl.Float64(),
        "hull": pl.String(),
        "sources": pl.List(pl.String()),
    }
)
TRACK_COLUMNS = tuple(TRACK_SCHEMA.names())


def _radius(df: pl.DataFrame) -> Floats:
    """Radius of the disc with the hull's area."""
    return np.sqrt(df["area_km2"].to_numpy() / np.pi)


def _diagonal(df: pl.DataFrame) -> Floats:
    width = (df["east"] - df["west"]).to_numpy() % 360
    height = (df["north"] - df["south"]).to_numpy()
    return np.asarray(np.hypot(width * np.cos(np.radians(df["lat"].to_numpy())), height))


def _ring(wkt: str) -> Floats:
    inner = wkt[wkt.index("((") + 2 : wkt.rindex("))")]
    return np.array([p.split() for p in inner.split(",")], np.float64)


def hulls_intersect(a: str, b: str) -> bool:
    """Convex WKT hulls intersect (separating axis test, on a plane around the first)."""
    p, q = _ring(a), _ring(b)
    lon0, lat0 = p[:, 0].mean(), p[:, 1].mean()
    polygons = []
    for ring in (p, q):
        x = ((ring[:, 0] - lon0 + 180) % 360 - 180) * np.cos(np.radians(lat0))
        polygons.append(np.column_stack([x, ring[:, 1]]))
    for poly in polygons:
        edges = np.diff(poly, axis=0)
        normals = np.column_stack([-edges[:, 1], edges[:, 0]])
        pa, pb = polygons[0] @ normals.T, polygons[1] @ normals.T
        if ((pa.max(axis=0) < pb.min(axis=0)) | (pb.max(axis=0) < pa.min(axis=0))).any():
            return False
    return True


def candidates(prev: pl.DataFrame, cells: pl.DataFrame, params: TrackParams) -> pl.DataFrame:
    """Pairs (i in `prev`, j in `cells`) that may be the same storm, with their distance."""
    empty = pl.DataFrame(schema={"i": pl.Int64, "j": pl.Int64, "km": pl.Float64})
    if prev.is_empty() or cells.is_empty():
        return empty
    ra, rb = _radius(prev), _radius(cells)
    reach = max(
        ra.max() + rb.max() + params.max_speed_kmh * params.max_gap_minutes / 60,
        (_diagonal(prev).max() + _diagonal(cells).max()) * KM_PER_DEGREE,
    )
    chord = 2 * np.sin(min(reach / (2 * EARTH_RADIUS_KM), np.pi / 2))
    xa = unit_xyz(prev["lat"].to_numpy(), prev["lon"].to_numpy())
    xb = unit_xyz(cells["lat"].to_numpy(), cells["lon"].to_numpy())
    found = cKDTree(xa).sparse_distance_matrix(cKDTree(xb), chord, output_type="ndarray")
    i, j = found["i"].astype(np.int64), found["j"].astype(np.int64)
    km = 2 * EARTH_RADIUS_KM * np.arcsin(np.clip(found["v"] / 2, 0, 1))
    end = prev["t_end"].dt.epoch("us").to_numpy()
    start = cells["t_start"].dt.epoch("us").to_numpy()
    gap_hours = (start[j] - end[i]) / 3.6e9
    in_time = gap_hours * 60 <= params.max_gap_minutes
    near = km <= ra[i] + rb[j] + params.max_speed_kmh * gap_hours.clip(0)
    ha, hb = prev["hull"].to_list(), cells["hull"].to_list()
    overlap = np.array(
        [
            bool(t and not n and hulls_intersect(ha[a], hb[b]))
            for a, b, t, n in zip(i, j, in_time, near, strict=True)
        ],
        bool,
    )
    keep = in_time & (near | overlap)
    return pl.DataFrame({"i": i[keep], "j": j[keep], "km": km[keep]})


def link(prev: pl.DataFrame, cells: pl.DataFrame, params: TrackParams) -> pl.DataFrame:
    """Track rows of one window: each cell continues a storm of `prev` or starts one.

    Splits and merges keep the main branch: pairs are taken by decreasing combined flash
    count, each storm and each cell at most once. A cell split off a storm starts a new one
    (`split_from`); storms merged into a cell end there (`merged`). A new storm takes the id
    of its first cell.
    """
    cells = cells.sort("t_start", "cell_id")
    found = candidates(prev, cells, params)
    i, j = found["i"].to_numpy(), found["j"].to_numpy()
    pairs = (
        found.with_columns(
            size=prev["flash_count"].to_numpy()[i] + cells["flash_count"].to_numpy()[j],
            a=prev["cell_id"].gather(i),
            b=cells["cell_id"].gather(j),
        )
        .sort(["size", "km", "a", "b"], descending=[True, False, False, False])
        .select("i", "j")
        .rows()
    )
    parent: dict[int, int] = {}
    continued: set[int] = set()
    for i, j in pairs:
        if j not in parent and i not in continued:
            parent[j] = i
            continued.add(i)
    split_from: dict[int, int] = {}
    merged: dict[int, set[int]] = {}
    for i, j in pairs:
        if j not in parent:
            split_from.setdefault(j, i)
        elif i not in continued:
            merged.setdefault(j, set()).add(i)

    storms = prev["storm_id"].to_list()
    starts = prev["storm_start"].to_list()
    previous = prev["cell_id"].to_list()
    n = cells.height
    return cells.with_columns(
        pl.Series(
            "storm_id",
            [storms[parent[j]] if j in parent else cells["cell_id"][j] for j in range(n)],
            pl.String,
        ),
        pl.Series(
            "storm_start",
            [starts[parent[j]] if j in parent else cells["window_start"][j] for j in range(n)],
            TIME,
        ),
        pl.Series(
            "previous_cell_id", [previous[parent[j]] if j in parent else None for j in range(n)]
        ).cast(pl.String),
        pl.Series(
            "split_from", [storms[split_from[j]] if j in split_from else None for j in range(n)]
        ).cast(pl.String),
        pl.Series(
            "merged",
            [sorted({storms[i] for i in merged.get(j, ())}) for j in range(n)],
            pl.List(pl.String),
        ),
    ).select(TRACK_COLUMNS)


def track_range(
    prev: pl.DataFrame, cells: pl.DataFrame, start: datetime, end: datetime, params: TrackParams
) -> pl.DataFrame:
    """Track rows of the windows in [start, end), continuing the storms of `prev`."""
    frames = []
    for h in range(int((end - start) / HOUR)):
        hour = start + h * HOUR
        prev = link(prev, cells.filter(pl.col("window_start") == hour), params)
        frames.append(prev)
    return pl.concat(frames) if frames else prev.head(0)


def _wrap(lon: pl.Expr) -> pl.Expr:
    return (lon + 180) % 360 - 180


def summarize_storms(tracks: pl.DataFrame, tracked_until: datetime) -> pl.DataFrame:
    """One row per storm from all its track rows; closed once a later window was tracked."""
    xyz = unit_xyz(tracks["lat"].to_numpy(), tracks["lon"].to_numpy())
    own = pl.col("hour_flash_count").fill_null(pl.col("flash_count"))
    weight = own.cast(pl.Float64)
    steps = tracks.with_columns(
        x=xyz[:, 0],
        y=xyz[:, 1],
        z=xyz[:, 2],
        time=pl.col("t_start") + (pl.col("t_end") - pl.col("t_start")) / 2,
    ).sort("storm_id", "window_start")
    storms = (
        steps.group_by("storm_id")
        .agg(
            pl.col("storm_start").first(),
            pl.col("window_start").max().alias("last_window"),
            pl.col("t_start").min(),
            pl.col("t_end").max(),
            pl.len().cast(pl.Int64).alias("steps"),
            own.sum().alias("flash_count"),
            pl.col("flash_count").max().alias("max_cell_flashes"),
            pl.col("area_km2").max().alias("max_area_km2"),
            *((pl.col(c) * weight).sum().alias(c) for c in ("x", "y", "z")),
            pl.col("sources").explode().unique().sort().alias("sources"),
            pl.col("split_from").first(),
            pl.struct(
                "time",
                "lat",
                "lon",
                own.alias("flash_count"),
                "area_km2",
            ).alias("track"),
        )
        .with_columns(
            lat=pl.arctan2("z", (pl.col("x") ** 2 + pl.col("y") ** 2).sqrt()).degrees(),
            lon=pl.arctan2("y", "x").degrees(),
            closed=pl.col("last_window") < pl.lit(tracked_until).cast(TIME),
        )
    )
    width = (pl.col("east") - pl.col("west")) % 360
    west = _wrap(pl.col("west") - pl.col("lon0"))
    bounds = (
        steps.join(storms.select("storm_id", pl.col("lon").alias("lon0")), on="storm_id")
        .group_by("storm_id")
        .agg(
            (pl.col("lon0").first() + west.min()).alias("west"),
            pl.col("south").min(),
            (pl.col("lon0").first() + (west + width).max()).alias("east"),
            pl.col("north").max(),
        )
        .with_columns(_wrap(pl.col(c)) for c in ("west", "east"))
    )
    return storms.join(bounds, on="storm_id").select(STORM_COLUMNS).sort("storm_start", "storm_id")


STORM_COLUMNS = (
    "storm_id",
    "storm_start",
    "last_window",
    "t_start",
    "t_end",
    "closed",
    "steps",
    "flash_count",
    "max_cell_flashes",
    "max_area_km2",
    "lat",
    "lon",
    "west",
    "south",
    "east",
    "north",
    "sources",
    "split_from",
    "track",
)
