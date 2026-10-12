"""Loading of the JSON Schema files that define the contract."""

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

type Node = dict[str, Any]

SCHEMA_FILES = (
    "common.schema.json",
    "flash.schema.json",
    "manifest.schema.json",
    "chunk.schema.json",
    "metrics.schema.json",
    "coverage.schema.json",
    "storm.schema.json",
)
VERSION_DEF = "SchemaVersion"


@dataclass(frozen=True)
class NamedType:
    name: str
    file: str
    node: Node


@dataclass(frozen=True)
class SchemaSet:
    """All contract schemas, with named types in dependency order."""

    files: Mapping[str, Node]
    types: tuple[NamedType, ...]

    @property
    def version(self) -> str:
        return str(self.get(VERSION_DEF).node["const"])

    def get(self, name: str) -> NamedType:
        for named in self.types:
            if named.name == name:
                return named
        raise KeyError(name)


def load_dir(contract_dir: Path) -> SchemaSet:
    files = {
        name: json.loads((contract_dir / name).read_text(encoding="utf-8")) for name in SCHEMA_FILES
    }
    return from_files(files)


def from_files(files: Mapping[str, Node]) -> SchemaSet:
    types: list[NamedType] = []
    for file, root in files.items():
        for name, node in root.get("$defs", {}).items():
            types.append(NamedType(name, file, node))
        if "type" in root:
            types.append(NamedType(root["title"], file, root))
    names = [t.name for t in types]
    duplicates = {n for n in names if names.count(n) > 1}
    if duplicates:
        raise ValueError(f"duplicate type names: {sorted(duplicates)}")
    return SchemaSet(files=dict(files), types=tuple(types))


def ref_name(ref: str) -> str:
    """Type name targeted by a $ref such as `common.schema.json#/$defs/Source`."""
    match = re.fullmatch(r"(?:[\w.]+\.schema\.json)?#/\$defs/(\w+)", ref)
    if match is None:
        raise ValueError(f"unsupported $ref: {ref}")
    return match.group(1)


def upper_snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).upper()
