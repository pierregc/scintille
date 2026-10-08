"""Classification of schema changes and SemVer enforcement."""

from dataclasses import dataclass
from enum import IntEnum
from typing import Any

from scintille_contract.schema import VERSION_DEF, SchemaSet

_DOC_KEYS = {"description", "title", "$comment", "examples"}


class Level(IntEnum):
    PATCH = 1
    MINOR = 2
    MAJOR = 3


@dataclass(frozen=True)
class Change:
    level: Level
    path: str
    what: str

    def __str__(self) -> str:
        return f"[{self.level.name.lower()}] {self.path}: {self.what}"


def diff(base: SchemaSet, head: SchemaSet) -> list[Change]:
    """Changes from base to head, each classified by its impact on existing readers."""
    changes: list[Change] = []
    for file, base_root in base.files.items():
        if file not in head.files:
            changes.append(Change(Level.MAJOR, file, "schema file removed"))
            continue
        _compare(base_root, head.files[file], file, changes)
    changes += [
        Change(Level.MINOR, file, "schema file added")
        for file in head.files
        if file not in base.files
    ]
    return changes


def _compare(base: Any, head: Any, path: str, out: list[Change]) -> None:
    if isinstance(base, dict) and isinstance(head, dict):
        _compare_objects(base, head, path, out)
    elif isinstance(base, list) and isinstance(head, list) and len(base) == len(head):
        for i, (b, h) in enumerate(zip(base, head, strict=True)):
            _compare(b, h, f"{path}[{i}]", out)
    elif base != head:
        out.append(Change(Level.MAJOR, path, f"changed from {base!r} to {head!r}"))


def _compare_objects(
    base: dict[str, Any], head: dict[str, Any], path: str, out: list[Change]
) -> None:
    for key in sorted(base.keys() | head.keys()):
        sub = f"{path}/{key}"
        if key not in head:
            level = Level.PATCH if key in _DOC_KEYS else Level.MAJOR
            out.append(Change(level, sub, "removed"))
        elif key not in base:
            level = Level.PATCH if key in _DOC_KEYS else Level.MAJOR
            out.append(Change(level, sub, "added"))
        elif key in _DOC_KEYS:
            if base[key] != head[key]:
                out.append(Change(Level.PATCH, sub, "documentation changed"))
        elif key in ("properties", "$defs"):
            _compare_members(base[key], head[key], sub, out, ordered=key == "properties")
        elif key == "required":
            _compare_required(base[key], head[key], sub, out)
        elif key == "enum":
            _compare_enum(base[key], head[key], sub, out)
        elif key == "const" and path.endswith(f"/$defs/{VERSION_DEF}"):
            continue
        else:
            _compare(base[key], head[key], sub, out)


def _compare_members(
    base: dict[str, Any], head: dict[str, Any], path: str, out: list[Change], *, ordered: bool
) -> None:
    for name, node in base.items():
        if name not in head:
            out.append(Change(Level.MAJOR, f"{path}/{name}", "removed"))
        else:
            _compare(node, head[name], f"{path}/{name}", out)
    added = [name for name in head if name not in base]
    out += [Change(Level.MINOR, f"{path}/{name}", "added") for name in added]
    if ordered:
        kept = [name for name in head if name in base]
        if kept != [name for name in base if name in head]:
            out.append(Change(Level.MAJOR, path, "properties reordered"))
        first_added = min((list(head).index(n) for n in added), default=len(head))
        if any(list(head).index(n) > first_added for n in kept):
            out.append(Change(Level.MAJOR, path, "property inserted before existing ones"))


def _compare_required(base: list[str], head: list[str], path: str, out: list[Change]) -> None:
    for name in sorted(set(base) - set(head)):
        out.append(Change(Level.MAJOR, path, f"{name!r} is no longer required"))
    for name in sorted(set(head) - set(base)):
        out.append(Change(Level.MINOR, path, f"{name!r} is now required"))


def _compare_enum(base: list[Any], head: list[Any], path: str, out: list[Change]) -> None:
    if head[: len(base)] != base:
        out.append(Change(Level.MAJOR, path, "values removed, renamed or reordered"))
    elif len(head) > len(base):
        out.append(Change(Level.MINOR, path, f"values appended: {head[len(base) :]}"))


def parse_version(version: str) -> tuple[int, int, int]:
    major, minor, patch = (int(part) for part in version.split("."))
    return major, minor, patch


def required_level(base_version: str, head_version: str) -> Level | None:
    """Level of the version bump from base to head, or None if not bumped."""
    base, head = parse_version(base_version), parse_version(head_version)
    if head <= base:
        return None
    if head[0] > base[0]:
        return Level.MAJOR
    if head[1] > base[1]:
        return Level.MINOR
    return Level.PATCH


def check(base: SchemaSet, head: SchemaSet) -> list[str]:
    """Errors if head changes the contract without the matching version bump."""
    if parse_version(head.version) < parse_version(base.version):
        return [f"schema_version went down from {base.version} to {head.version}"]
    changes = diff(base, head)
    if not changes:
        return []
    needed = max(change.level for change in changes)
    bump = required_level(base.version, head.version)
    if bump is not None and bump >= needed:
        return []
    listing = [f"  {change}" for change in changes if change.level == needed]
    found = "no bump" if bump is None else f"a {bump.name.lower()} bump"
    return [
        f"schema_version {base.version} -> {head.version} is {found}, "
        f"but the changes need a {needed.name.lower()} bump:",
        *listing,
    ]
