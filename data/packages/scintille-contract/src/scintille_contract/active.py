"""Rules of storms/active.json (ADR 0021), for one snapshot and for two successive ones."""

from collections.abc import Iterable
from datetime import datetime, timedelta

from scintille_contract.models import ActiveCell, ActiveStorms, Source

EXPIRE_AFTER = timedelta(minutes=30)
OVERLAP = timedelta(minutes=30)
SOURCE_GAP_AFTER = timedelta(hours=1)
ENDED_KEPT = timedelta(hours=2)
PATH_SPAN = timedelta(hours=2)


def frontier(snapshot: ActiveStorms, sources: Iterable[Source]) -> datetime | None:
    """Newest data among `sources`: a storm is judged on the sources that see it."""
    wanted = set(sources)
    times = [
        s.observed_until
        for s in snapshot.sources
        if s.source in wanted and s.observed_until is not None
    ]
    return max(times, default=None)


def _cell_errors(snapshot: ActiveStorms, cell: ActiveCell) -> list[str]:
    errors = []
    name = f"cell {cell.id}"
    until = frontier(snapshot, cell.sources)
    if until is None:
        return [f"{name}: none of its sources has data"]
    if cell.t_start > cell.t_end or cell.t_end > until:
        errors.append(f"{name}: times outside its sources' data")
    if until - cell.t_end >= EXPIRE_AFTER:
        errors.append(f"{name}: no flash for {EXPIRE_AFTER} of data, should have expired")
    if snapshot.published_at - until > SOURCE_GAP_AFTER:
        errors.append(f"{name}: sources silent for over {SOURCE_GAP_AFTER}, should have ended")
    if cell.level < snapshot.min_level:
        errors.append(f"{name}: level below min_level")
    authoritative = snapshot.authoritative_until
    if cell.provisional:
        if cell.slug is not None or cell.name is not None:
            errors.append(f"{name}: a provisional storm is not in the catalog yet")
        if authoritative is not None and cell.t_start < authoritative - OVERLAP:
            errors.append(f"{name}: provisional but started before the open hour")
    elif authoritative is None or cell.t_start >= authoritative:
        errors.append(f"{name}: final id for a storm the catalog has not tracked")
    if len(cell.hull) > 2 and cell.hull[0] != cell.hull[-1]:
        errors.append(f"{name}: hull ring not closed")
    times = [p.time for p in cell.path]
    if times != sorted(times) or any(
        t > cell.t_end or t < snapshot.published_at - PATH_SPAN for t in times
    ):
        errors.append(f"{name}: path out of order or out of span")
    if cell.id in cell.previous_ids:
        errors.append(f"{name}: lists itself in previous_ids")
    return errors


def check(snapshot: ActiveStorms) -> list[str]:
    """Errors of one snapshot; empty when it follows the contract."""
    errors = []
    ids = [cell.id for cell in snapshot.cells]
    if len(ids) != len(set(ids)):
        errors.append("duplicate cell ids")
    ranks = [(-cell.level, -cell.flashes) for cell in snapshot.cells]
    if ranks != sorted(ranks):
        errors.append("cells not sorted strongest first")
    for cell in snapshot.cells:
        errors += _cell_errors(snapshot, cell)
    gone = [e.ended_at for e in snapshot.ended]
    if gone != sorted(gone, reverse=True):
        errors.append("ended not sorted newest first")
    for entry in snapshot.ended:
        name = f"ended {entry.id}"
        if entry.id in ids and entry.reason != "source-gap":
            errors.append(f"{name}: still listed in cells")
        age = snapshot.published_at - entry.ended_at
        if age < timedelta(0) or age > ENDED_KEPT:
            errors.append(f"{name}: ended_at outside the last {ENDED_KEPT}")
        if (entry.into is None) == (entry.reason in ("merged", "replaced")):
            errors.append(f"{name}: into must be set exactly for merged and replaced")
        if entry.into is not None and age == timedelta(0) and entry.into not in ids:
            errors.append(f"{name}: continues as {entry.into}, which is not listed")
    return errors


def check_transition(previous: ActiveStorms, current: ActiveStorms) -> list[str]:
    """Errors between two successive snapshots: nothing vanishes, nothing goes back."""
    errors = []
    if current.published_at <= previous.published_at:
        errors.append("published_at did not advance")
    before = {s.source: s.observed_until for s in previous.sources}
    for source in current.sources:
        old = before.get(source.source)
        if old is not None and (source.observed_until is None or source.observed_until < old):
            errors.append(f"source {source.source}: observed_until went back")
    cells = {cell.id: cell for cell in current.cells}
    ended = {entry.id: entry for entry in current.ended}
    for cell in previous.cells:
        now = cells.get(cell.id)
        if now is not None:
            if now.level < cell.level:
                errors.append(f"cell {cell.id}: level went down")
            if now.provisional and not cell.provisional:
                errors.append(f"cell {cell.id}: final id became provisional")
        elif cell.id not in ended:
            errors.append(f"cell {cell.id}: left without an ended entry")
        elif ended[cell.id].ended_at != current.published_at:
            errors.append(f"cell {cell.id}: ended_at is not this snapshot")
    for entry in previous.ended:
        kept = current.published_at - entry.ended_at <= ENDED_KEPT
        if kept and entry.id not in ended and entry.id not in cells:
            errors.append(f"ended {entry.id}: dropped before {ENDED_KEPT}")
    for entry in current.ended:
        if entry.reason == "replaced" and entry.ended_at == current.published_at:
            target = cells.get(entry.into or "")
            if target is None or entry.id not in target.previous_ids:
                errors.append(f"ended {entry.id}: replacement does not list it in previous_ids")
    return errors
