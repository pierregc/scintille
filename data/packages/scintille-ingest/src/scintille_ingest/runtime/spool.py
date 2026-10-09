"""Local durable spool: one Parquet file per batch, written atomically and fsynced."""

import os
from pathlib import Path

import polars as pl


class Spool:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)

    def path(self, batch_id: str) -> Path:
        return self.directory / f"{batch_id}.parquet"

    def write(self, batch_id: str, frame: pl.DataFrame) -> Path:
        """Idempotent: writing the same batch again replaces it with identical content."""
        final = self.path(batch_id)
        partial = final.with_suffix(".parquet.partial")
        frame.write_parquet(partial, compression="zstd")
        with partial.open("rb") as handle:
            os.fsync(handle.fileno())
        partial.replace(final)
        self._fsync_directory()
        return final

    def pending(self) -> list[str]:
        """Batch ids waiting for lake-writer, oldest first."""
        files = sorted(self.directory.glob("*.parquet"), key=lambda p: p.stat().st_mtime)
        return [p.stem for p in files]

    def read(self, batch_id: str) -> pl.DataFrame:
        return pl.read_parquet(self.path(batch_id))

    def delete(self, batch_id: str) -> None:
        self.path(batch_id).unlink(missing_ok=True)
        self._fsync_directory()

    def size_bytes(self) -> int:
        return sum(p.stat().st_size for p in self.directory.glob("*.parquet"))

    def _fsync_directory(self) -> None:
        fd = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
