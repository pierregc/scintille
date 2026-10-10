"""`lake-writer`: drains the spool into the lakehouse. The commit itself arrives with #39."""

import asyncio
import contextlib
import logging
from collections.abc import Callable

from .metrics import Metrics
from .spool import Spool

log = logging.getLogger("scintille_ingest.lake_writer")

Commit = Callable[[Spool, list[str]], None]


def log_only(spool: Spool, batches: list[str]) -> None:
    """Placeholder until #39: reports the backlog and leaves the spool untouched."""
    log.info(
        "spool backlog", extra={"fields": {"batches": len(batches), "bytes": spool.size_bytes()}}
    )


class LakeWriter:
    def __init__(
        self,
        spool: Spool,
        commit: Commit = log_only,
        interval: float = 300.0,
        metrics: Metrics | None = None,
    ) -> None:
        self.spool = spool
        self.commit = commit
        self.interval = interval
        self.metrics = metrics or Metrics()
        self._stop = asyncio.Event()

    def drain_once(self) -> int:
        batches = self.spool.pending()
        self.metrics.set("spool_batches", len(batches))
        if batches:
            self.commit(self.spool, batches)
        return len(batches)

    async def run(self) -> None:
        while not self._stop.is_set():
            try:
                self.drain_once()
            except Exception:
                self.metrics.inc("lake_writer_errors_total")
                log.exception("drain failed; the spool keeps the batches")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=self.interval)

    def stop(self) -> None:
        self._stop.set()
