import copy
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from scintille_contract import compat
from scintille_contract.schema import SchemaSet, from_files, load_dir

CONTRACT_DIR = Path(__file__).parents[3] / "contract"

type Files = dict[str, Any]


def _base() -> SchemaSet:
    return load_dir(CONTRACT_DIR)


def _edit(edit: Callable[[Files], None], version: str | None = None) -> SchemaSet:
    files = copy.deepcopy(dict(_base().files))
    edit(files)
    if version is not None:
        files["common.schema.json"]["$defs"]["SchemaVersion"]["const"] = version
    return from_files(files)


def _flash(files: Files) -> Any:
    return files["flash.schema.json"]


def _drop_lat(files: Files) -> None:
    del _flash(files)["properties"]["lat"]
    _flash(files)["required"].remove("lat")


def _add_field(files: Files) -> None:
    _flash(files)["properties"]["polarity"] = {"type": "integer"}


def _reorder_sources(files: Files) -> None:
    files["common.schema.json"]["$defs"]["Source"]["enum"].reverse()


def _append_source(files: Files) -> None:
    files["common.schema.json"]["$defs"]["Source"]["enum"].append("fy4-lmi")


def _retype(files: Files) -> None:
    _flash(files)["properties"]["native_flash_id"]["type"] = "string"


def _reword(files: Files) -> None:
    _flash(files)["properties"]["lat"]["description"] = "Latitude."


def _change_scale(files: Files) -> None:
    columns = files["chunk.schema.json"]["$defs"]["ChunkColumns"]["properties"]
    columns["lat"]["x-binary"]["scale"] = 0.001


def _insert_column(files: Files) -> None:
    columns = files["chunk.schema.json"]["$defs"]["ChunkColumns"]["properties"]
    columns_list = list(columns.items())
    columns.clear()
    columns.update([("energy", {"type": "array"}), *columns_list])


def test_unchanged_contract_passes() -> None:
    assert compat.check(_base(), _base()) == []


@pytest.mark.parametrize(
    ("edit", "level"),
    [
        (_drop_lat, compat.Level.MAJOR),
        (_retype, compat.Level.MAJOR),
        (_reorder_sources, compat.Level.MAJOR),
        (_change_scale, compat.Level.MAJOR),
        (_insert_column, compat.Level.MAJOR),
        (_add_field, compat.Level.MINOR),
        (_append_source, compat.Level.MINOR),
        (_reword, compat.Level.PATCH),
    ],
)
def test_changes_are_classified(edit: Callable[[Files], None], level: compat.Level) -> None:
    changes = compat.diff(_base(), _edit(edit))
    assert max(change.level for change in changes) == level


@pytest.mark.parametrize("edit", [_drop_lat, _retype, _reorder_sources, _change_scale])
def test_breaking_change_needs_major_bump(edit: Callable[[Files], None]) -> None:
    assert compat.check(_base(), _edit(edit)) != []
    assert compat.check(_base(), _edit(edit, "1.1.0")) != []
    assert compat.check(_base(), _edit(edit, "2.0.0")) == []


def test_additive_change_needs_minor_bump() -> None:
    assert compat.check(_base(), _edit(_add_field, "1.0.1")) != []
    assert compat.check(_base(), _edit(_add_field, "1.1.0")) == []


def test_doc_change_needs_a_bump() -> None:
    assert compat.check(_base(), _edit(_reword)) != []
    assert compat.check(_base(), _edit(_reword, "1.0.1")) == []


def test_version_cannot_go_down() -> None:
    assert compat.check(_edit(_reword, "1.2.0"), _edit(_reword, "1.1.0")) != []
