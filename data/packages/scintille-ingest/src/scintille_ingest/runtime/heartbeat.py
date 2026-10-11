"""Healthchecks.io pings: best effort, a failed ping never reaches the caller."""

import asyncio
import logging
import os
import urllib.request
from collections.abc import Callable
from typing import Protocol

from .metrics import Metrics

log = logging.getLogger("scintille_ingest.heartbeat")


class Pinger(Protocol):
    async def ping(self, ok: bool = True, message: str = "") -> bool: ...


Send = Callable[[str, bytes, float], None]


def http_post(url: str, body: bytes, timeout: float) -> None:
    request = urllib.request.Request(
        url, data=body, method="POST", headers={"User-Agent": "scintille-ingest"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        response.read()


class Heartbeat:
    """Pings `url` when healthy, `url/fail` otherwise; the body shows up in the check's log."""

    def __init__(
        self,
        url: str,
        *,
        check: str,
        metrics: Metrics | None = None,
        timeout: float = 10.0,
        send: Send = http_post,
    ) -> None:
        self.url = url.rstrip("/")
        self.check = check
        self.metrics = metrics or Metrics()
        self.timeout = timeout
        self._send = send

    async def ping(self, ok: bool = True, message: str = "") -> bool:
        target = self.url if ok else self.url + "/fail"
        try:
            await asyncio.wait_for(
                asyncio.to_thread(self._send, target, message.encode(), self.timeout),
                self.timeout * 2,
            )
        except Exception as error:
            self.metrics.inc("heartbeat_errors_total", check=self.check)
            log.warning(
                "heartbeat ping failed",
                extra={"fields": {"check": self.check, "error": type(error).__name__}},
            )
            return False
        self.metrics.inc("heartbeat_pings_total", check=self.check, status="ok" if ok else "fail")
        return True


def heartbeat_from_env(variable: str, check: str, metrics: Metrics) -> Heartbeat | None:
    url = os.environ.get(variable)
    if not url:
        log.info("%s is not set: no heartbeat", variable)
        return None
    return Heartbeat(url, check=check, metrics=metrics)
