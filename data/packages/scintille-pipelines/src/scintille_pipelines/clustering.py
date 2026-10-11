"""ST-DBSCAN on flashes, and the storm cells it yields."""

import hashlib
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime

import numpy as np
import polars as pl
from numpy.typing import NDArray
from scipy.sparse import coo_matrix  # type: ignore[import-untyped]
from scipy.sparse.csgraph import connected_components  # type: ignore[import-untyped]
from scipy.spatial import ConvexHull, cKDTree  # type: ignore[import-untyped]

EARTH_RADIUS_KM = 6371.0088
KM_PER_DEGREE = np.pi * EARTH_RADIUS_KM / 180

Ints = NDArray[np.int64]
Floats = NDArray[np.float64]

SLABS_PER_EPS = 4


@dataclass(frozen=True)
class Params:
    """Two flashes are neighbours within `eps_km` on the sphere and `eps_minutes` in time."""

    eps_km: float
    eps_minutes: float
    min_pts: int

    def __str__(self) -> str:
        eps = f"eps_km={self.eps_km:g} eps_minutes={self.eps_minutes:g}"
        return f"st-dbscan {eps} min_pts={self.min_pts}"


def unit_xyz(lat: Floats, lon: Floats) -> Floats:
    phi, lam = np.radians(lat), np.radians(lon)
    return np.column_stack([np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)])


def _windows(
    xyz: Floats, t: Floats, chord: float, eps_s: float
) -> Iterator[tuple[int, Ints, Ints]]:
    """Neighbour pairs (i < j, local to the slab start), one short time slab at a time.

    `t` is sorted; pairs are found from the slab's points to everything up to `eps_s` later,
    so memory stays bounded by the densest slab.
    """
    slab = ((t - t[0]) // (eps_s / SLABS_PER_EPS)).astype(np.int64)
    for k in np.unique(slab):
        a, m = np.searchsorted(slab, [k, k + 1])
        b = int(np.searchsorted(t, t[m - 1] + eps_s, side="right"))
        found = cKDTree(xyz[a:m]).sparse_distance_matrix(
            cKDTree(xyz[a:b]), chord, output_type="ndarray"
        )
        i, j = found["i"].astype(np.int64), found["j"].astype(np.int64)
        keep = (j > i) & (t[a + j] - t[a + i] <= eps_s)
        yield int(a), i[keep], j[keep]


def st_dbscan(lat: Floats, lon: Floats, t: Floats, params: Params) -> Ints:
    """Cluster label per point, -1 for noise; `t` in seconds.

    `min_pts` counts the point itself; every cluster has at least `min_pts` points. Labels
    follow the time of each cluster's first point.
    """
    n = len(t)
    if n == 0:
        return np.empty(0, np.int64)
    order = np.argsort(t, kind="stable")
    ts = t[order]
    xyz = unit_xyz(lat[order], lon[order]) * EARTH_RADIUS_KM
    chord = 2 * EARTH_RADIUS_KM * np.sin(min(params.eps_km / (2 * EARTH_RADIUS_KM), np.pi / 2))
    eps_s = params.eps_minutes * 60

    degree = np.zeros(n, np.int64)
    for a, i, j in _windows(xyz, ts, chord, eps_s):
        counts = np.bincount(np.concatenate([i, j]))
        degree[a : a + len(counts)] += counts
    core = degree + 1 >= params.min_pts

    # Core components are found per window, then joined through their representatives.
    src: list[Ints] = []
    dst: list[Ints] = []
    border: list[Ints] = []
    anchor: list[Ints] = []
    for a, i, j in _windows(xyz, ts, chord, eps_s):
        ci, cj = core[a + i], core[a + j]
        both = ci & cj
        if both.any():
            ii, jj = i[both], j[both]
            size = int(max(ii.max(), jj.max())) + 1
            graph = coo_matrix((np.ones(len(ii), bool), (ii, jj)), shape=(size, size))
            _, comp = connected_components(graph, directed=False)
            nodes = np.unique(np.concatenate([ii, jj]))
            _, first = np.unique(comp[nodes], return_index=True)
            rep = np.empty(comp.max() + 1, np.int64)
            rep[comp[nodes[first]]] = nodes[first]
            src.append(nodes + a)
            dst.append(rep[comp[nodes]] + a)
        border += [j[ci & ~cj] + a, i[cj & ~ci] + a]
        anchor += [i[ci & ~cj] + a, j[cj & ~ci] + a]

    edges_a = np.concatenate([*src, np.empty(0, np.int64)])
    edges_b = np.concatenate([*dst, np.empty(0, np.int64)])
    graph = coo_matrix((np.ones(len(edges_a), bool), (edges_a, edges_b)), shape=(n, n))
    _, comp = connected_components(graph, directed=False)

    labels = np.full(n, -1, np.int64)
    labels[core] = comp[core]
    b = np.concatenate([*border, np.empty(0, np.int64)])
    c = np.concatenate([*anchor, np.empty(0, np.int64)])
    b, first = np.unique(b, return_index=True)
    labels[b] = comp[c[first]]

    # Border ties can leave a cluster below min_pts: it becomes noise.
    sizes = np.bincount(labels[labels >= 0], minlength=n)
    labels[(labels >= 0) & (sizes[labels.clip(0)] < params.min_pts)] = -1
    clustered = labels >= 0
    _, first_seen, inverse = np.unique(labels[clustered], return_index=True, return_inverse=True)
    rank = np.argsort(np.argsort(first_seen))
    labels[clustered] = rank[inverse]
    out = np.empty(n, np.int64)
    out[order] = labels
    return out


def cell_id(window_start: datetime, first_flash_id: str) -> str:
    return hashlib.sha1(f"{window_start.isoformat()}/{first_flash_id}".encode()).hexdigest()[:16]


def _hull(lon: Floats, lat: Floats, lon0: float, lat0: float) -> tuple[str, float]:
    """Convex hull as WKT (longitudes continuous around `lon0`) and its area in km²."""
    scale = np.cos(np.radians(lat0))
    xy = np.column_stack([(lon - lon0) * scale, lat - lat0]) * KM_PER_DEGREE
    if len(xy) < 3:
        ring = [*range(len(xy)), 0]
        area = 0.0
    else:
        hull = ConvexHull(xy, qhull_options="QJ")
        ring = [*hull.vertices, hull.vertices[0]]
        area = float(hull.volume)
    points = ", ".join(f"{lon[k]:.4f} {lat[k]:.4f}" for k in ring)
    return f"POLYGON(({points}))", area


def summarize(
    flashes: pl.DataFrame,
    labels: Ints,
    window_start: datetime,
    window_end: datetime,
    params: Params,
) -> pl.DataFrame:
    """One row per cluster: time range, centroid, bbox and hull."""
    xyz = unit_xyz(flashes["lat"].to_numpy(), flashes["lon"].to_numpy())
    df = (
        flashes.select("flash_id", "source", "event_time", "lat", "lon")
        .with_columns(label=labels, x=xyz[:, 0], y=xyz[:, 1], z=xyz[:, 2])
        .filter(pl.col("label") >= 0)
    )
    cells = (
        df.group_by("label")
        .agg(
            pl.col("flash_id").sort_by("event_time", "flash_id").first().alias("first_flash_id"),
            pl.col("event_time").min().alias("t_start"),
            pl.col("event_time").max().alias("t_end"),
            pl.len().cast(pl.Int64).alias("flash_count"),
            pl.col("x").mean(),
            pl.col("y").mean(),
            pl.col("z").mean(),
            pl.col("source").unique().sort().alias("sources"),
        )
        .with_columns(
            lat=pl.arctan2("z", (pl.col("x") ** 2 + pl.col("y") ** 2).sqrt()).degrees(),
            lon=pl.arctan2("y", "x").degrees(),
        )
        .drop("x", "y", "z")
        .sort("label")
    )
    df = (
        df.join(cells.select("label", pl.col("lon").alias("lon0")), on="label")
        .with_columns(dlon=(pl.col("lon") - pl.col("lon0") + 180) % 360 - 180)
        .sort("label")
    )
    bounds = (
        df.group_by("label")
        .agg(
            (pl.col("lon0").first() + pl.col("dlon").min()).alias("west"),
            pl.col("lat").min().alias("south"),
            (pl.col("lon0").first() + pl.col("dlon").max()).alias("east"),
            pl.col("lat").max().alias("north"),
        )
        .with_columns((pl.col(c) + 180) % 360 - 180 for c in ("west", "east"))
    )
    cells = cells.join(bounds, on="label").sort("label")

    splits = np.cumsum(cells["flash_count"].to_numpy())[:-1]
    lons = np.split(df["lon0"].to_numpy() + df["dlon"].to_numpy(), splits) if cells.height else []
    lats = np.split(df["lat"].to_numpy(), splits) if cells.height else []
    hulls = [
        _hull(lo, la, float(lo0), float(la0))
        for lo, la, lo0, la0 in zip(lons, lats, cells["lon"], cells["lat"], strict=True)
    ]
    ids = [cell_id(window_start, f) for f in cells["first_flash_id"]]
    return cells.select(
        pl.Series("cell_id", ids, pl.String),
        pl.lit(window_start).cast(pl.Datetime("us", "UTC")).alias("window_start"),
        pl.lit(window_end).cast(pl.Datetime("us", "UTC")).alias("window_end"),
        "t_start",
        "t_end",
        "flash_count",
        "lat",
        "lon",
        "west",
        "south",
        "east",
        "north",
        pl.Series("area_km2", [h[1] for h in hulls], pl.Float64),
        pl.Series("hull", [h[0] for h in hulls], pl.String),
        "sources",
        pl.lit(str(params)).alias("params"),
    )
