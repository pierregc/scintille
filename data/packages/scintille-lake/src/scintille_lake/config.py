"""Catalog connection settings, read from the environment."""

import os
from collections.abc import Mapping
from dataclasses import dataclass

LOCAL_URI = "http://localhost:8181/catalog"
LOCAL_WAREHOUSE = "scintille"


@dataclass(frozen=True)
class LakeConfig:
    """Iceberg REST catalog: local Lakekeeper by default, R2 Data Catalog in production."""

    uri: str = LOCAL_URI
    warehouse: str = LOCAL_WAREHOUSE
    token: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "LakeConfig":
        env = os.environ if env is None else env
        return cls(
            uri=env.get("SCINTILLE_LAKE_URI", LOCAL_URI),
            warehouse=env.get("SCINTILLE_LAKE_WAREHOUSE", LOCAL_WAREHOUSE),
            token=env.get("SCINTILLE_LAKE_TOKEN") or None,
        )

    def pyiceberg_properties(self) -> dict[str, str]:
        props = {"type": "rest", "uri": self.uri, "warehouse": self.warehouse}
        if self.token:
            props["token"] = self.token
        return props
