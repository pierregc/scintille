"""Local durable spool: per batch, its flashes and its ingest log rows, written atomically."""

import os
from collections.abc import Iterable
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path

import polars as pl


class Spool:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)

    def path(self, batch_id: str) -> Path:
        return self.directory / f"{batch_id}.parquet"

    def log_path(self, batch_id: str) -> Path:
        return self.directory / f"{batch_id}.log.parquet"

    def quarantine_path(self, batch_id: str) -> Path:
        return self.directory / f"{batch_id}.quarantine.parquet"

    def write(
        self,
        batch_id: str,
        flashes: pl.DataFrame,
        log: pl.DataFrame,
        quarantine: pl.DataFrame | None = None,
    ) -> Path:
        """Idempotent; the flashes file goes last, so its presence means the batch is complete."""
        self._write(self.log_path(batch_id), log)
        if quarantine is not None and quarantine.height:
            self._write(self.quarantine_path(batch_id), quarantine)
        return self._write(self.path(batch_id), flashes)

    def pending(self) -> list[str]:
        """Complete batches waiting for lake-writer, oldest first."""
        files = sorted(self._batches(), key=lambda f: (f[1].st_mtime, f[0].name))
        return [path.stem for path, _ in files]

    def oldest_pending_time(self) -> datetime | None:
        """When the oldest batch waiting for lake-writer was written."""
        oldest = min((stat.st_mtime for _, stat in self._batches()), default=None)
        return None if oldest is None else datetime.fromtimestamp(oldest, UTC)

    def _batches(self) -> list[tuple[Path, os.stat_result]]:
        return [f for f in _stats(self.directory.glob("*.parquet")) if f[0].name.count(".") == 1]

    def read(self, batch_id: str) -> pl.DataFrame:
        return pl.read_parquet(self.path(batch_id))

    def read_log(self, batch_id: str) -> pl.DataFrame:
        return pl.read_parquet(self.log_path(batch_id))

    def read_quarantine(self, batch_id: str) -> pl.DataFrame | None:
        path = self.quarantine_path(batch_id)
        return pl.read_parquet(path) if path.exists() else None

    def delete(self, batch_id: str) -> None:
        self.path(batch_id).unlink(missing_ok=True)
        self.log_path(batch_id).unlink(missing_ok=True)
        self.quarantine_path(batch_id).unlink(missing_ok=True)
        self._fsync_directory()

    def _write(self, final: Path, frame: pl.DataFrame) -> Path:
        partial = final.with_name(final.name + ".partial")
        frame.write_parquet(partial, compression="zstd")
        with partial.open("rb") as handle:
            os.fsync(handle.fileno())
        partial.replace(final)
        self._fsync_directory()
        return final

    def size_bytes(self) -> int:
        return sum(stat.st_size for _, stat in _stats(self.directory.glob("*.parquet")))

    def _fsync_directory(self) -> None:
        fd = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _stats(paths: Iterable[Path]) -> list[tuple[Path, os.stat_result]]:
    """The files still there: lake-writer deletes committed batches while they are listed."""
    found = []
    for path in paths:
        with suppress(FileNotFoundError):
            found.append((path, path.stat()))
    return found
