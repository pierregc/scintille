"""Local durable spool: per batch, its flashes and its ingest log rows, written atomically."""

import os
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

    def write(self, batch_id: str, flashes: pl.DataFrame, log: pl.DataFrame) -> Path:
        """Idempotent; the flashes file goes last, so its presence means the batch is complete."""
        self._write(self.log_path(batch_id), log)
        return self._write(self.path(batch_id), flashes)

    def pending(self) -> list[str]:
        """Complete batches waiting for lake-writer, oldest first."""
        files = [p for p in self.directory.glob("*.parquet") if not p.name.endswith(".log.parquet")]
        return [p.stem for p in sorted(files, key=lambda p: (p.stat().st_mtime, p.name))]

    def read(self, batch_id: str) -> pl.DataFrame:
        return pl.read_parquet(self.path(batch_id))

    def read_log(self, batch_id: str) -> pl.DataFrame:
        return pl.read_parquet(self.log_path(batch_id))

    def delete(self, batch_id: str) -> None:
        self.path(batch_id).unlink(missing_ok=True)
        self.log_path(batch_id).unlink(missing_ok=True)
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
        return sum(p.stat().st_size for p in self.directory.glob("*.parquet"))

    def _fsync_directory(self) -> None:
        fd = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
