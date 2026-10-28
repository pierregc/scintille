import json
from datetime import timedelta
from itertools import pairwise
from pathlib import Path

import pytest
from scintille_contract.active import check, check_transition
from scintille_contract.models import ActiveStorms

ROOT = Path(__file__).parents[4]
FIXTURES = sorted((ROOT / "fixtures" / "storms" / "active").glob("*.json"))


def load(path: Path) -> ActiveStorms:
    return ActiveStorms.model_validate(json.loads(path.read_text(encoding="utf-8")))


SNAPSHOTS = [load(path) for path in FIXTURES]


def test_fixture_sequence_follows_the_contract() -> None:
    assert len(SNAPSHOTS) == 5
    for snapshot in SNAPSHOTS:
        assert check(snapshot) == []
    for previous, current in pairwise(SNAPSHOTS):
        assert check_transition(previous, current) == []


def test_fixtures_cover_every_transition() -> None:
    reasons = {entry.reason for s in SNAPSHOTS for entry in s.ended}
    assert reasons == {"expired", "merged", "replaced", "source-gap"}
    cells = [cell for s in SNAPSHOTS for cell in s.cells]
    assert any(cell.split_from for cell in cells)
    assert any(cell.merged for cell in cells)
    assert any(cell.previous_ids for cell in cells)
    first = {cell.id: cell.provisional for cell in SNAPSHOTS[0].cells + SNAPSHOTS[1].cells}
    assert any(first[cell.id] and not cell.provisional for cell in SNAPSHOTS[3].cells)


def test_late_file_replaces_a_provisional_id() -> None:
    before, after = SNAPSHOTS[0], SNAPSHOTS[1]
    replaced = next(e for e in after.ended if e.reason == "replaced")
    target = next(cell for cell in after.cells if cell.id == replaced.into)
    old = next(cell for cell in before.cells if cell.id == replaced.id)
    assert old.provisional and target.provisional
    assert target.t_start < old.t_start
    assert replaced.id in target.previous_ids


def test_source_gap_keeps_storms_then_ends_them() -> None:
    def until(snapshot: ActiveStorms, source: str) -> object:
        return next(f.observed_until for f in snapshot.sources if f.source == source)

    assert until(SNAPSHOTS[4], "mtg-li") == until(SNAPSHOTS[1], "mtg-li")
    assert until(SNAPSHOTS[4], "glm-east") != until(SNAPSHOTS[1], "glm-east")
    kept = {cell.id for cell in SNAPSHOTS[3].cells if cell.sources == ["mtg-li"]}
    ended = {e.id: e.reason for e in SNAPSHOTS[4].ended}
    assert kept and all(ended[i] == "source-gap" for i in kept)


def edit(snapshot: ActiveStorms, **changes: object) -> ActiveStorms:
    return ActiveStorms.model_validate(snapshot.model_dump() | changes)


def test_vanishing_storm_is_an_error() -> None:
    current = edit(SNAPSHOTS[1], ended=[])
    errors = check_transition(SNAPSHOTS[0], current)
    assert any("left without an ended entry" in e for e in errors)


def test_level_cannot_go_down() -> None:
    cells = [c.model_dump() for c in SNAPSHOTS[1].cells]
    cells[0]["level"] = 2
    errors = check_transition(SNAPSHOTS[0], edit(SNAPSHOTS[1], cells=cells))
    assert any("level went down" in e for e in errors)


def test_storm_past_expiry_is_an_error() -> None:
    late = SNAPSHOTS[2].published_at + timedelta(hours=1)
    sources = [
        s.model_dump() | {"observed_until": late} if s.source != "mtg-li" else s.model_dump()
        for s in SNAPSHOTS[2].sources
    ]
    errors = check(edit(SNAPSHOTS[2], sources=sources, published_at=late))
    assert any("should have expired" in e for e in errors)


@pytest.mark.parametrize("field", ["slug", "name"])
def test_provisional_storm_is_not_in_the_catalog(field: str) -> None:
    cells = [c.model_dump() for c in SNAPSHOTS[0].cells]
    provisional = next(c for c in cells if c["provisional"])
    provisional[field] = "2026-07-15-gulf" if field == "slug" else "Gulf"
    errors = check(edit(SNAPSHOTS[0], cells=cells))
    assert any("not in the catalog yet" in e for e in errors)
