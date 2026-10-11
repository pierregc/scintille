"""Flags the flashes another source sees better (#34), from the static ownership mask."""

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
