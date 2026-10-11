"""Flags the flashes another source sees better (#34), from the static ownership mask."""

from collections.abc import Collection

import numpy as np
import polars as pl
from scintille_contract.ownership import SATELLITES, owner_index

from scintille_ingest.glm.parse import QUALITY

OUTSIDE_OWNER_ZONE = "outside-owner-zone"


def flag_outside_owner(flashes: pl.DataFrame) -> pl.DataFrame:
    """Adds the flag where the mask gives the point to another source; no owner, no flag."""
    names = np.array([s.source for s in SATELLITES] + [None], dtype=object)
    index = owner_index(flashes["lat"].to_numpy(), flashes["lon"].to_numpy())
    owner = pl.Series(names[index], dtype=pl.String)
    outside = owner.is_not_null() & (owner != flashes["source"].cast(pl.String))
    return flashes.with_columns(
        pl.when(outside)
        .then(pl.col("quality").list.concat(pl.lit([OUTSIDE_OWNER_ZONE], dtype=QUALITY)))
        .otherwise(pl.col("quality"))
        .alias("quality")
    )


def outside_owner_zone() -> pl.Expr:
    return pl.col("quality").list.contains(OUTSIDE_OWNER_ZONE)


def drop_owned_by(flashes: pl.DataFrame, live_sources: Collection[str]) -> pl.DataFrame:
    """Drops flagged flashes whose owner is live; while the owner is down they stay."""
    flagged = flashes.select(outside_owner_zone()).to_series().to_numpy()
    if not flagged.any():
        return flashes
    names = np.array([s.source for s in SATELLITES] + [None], dtype=object)
    owner = names[owner_index(flashes["lat"].to_numpy(), flashes["lon"].to_numpy())]
    owner_live = np.isin(owner, list(live_sources))
    return flashes.filter(pl.Series(~(flagged & owner_live)))
