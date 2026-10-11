"""Freshness of the public live manifest, read like a visitor would, reported to a heartbeat."""

import asyncio
import contextlib
import logging
import urllib.request
from collections.abc import Callable
from datetime import UTC, datetime

from scintille_contract.models import LiveManifest

from .heartbeat import Pinger

log = logging.getLogger("scintille_ingest.live_probe")

MANIFEST_URL = "https://data.scintille.app/live/manifest.json"
MAX_AGE = 180.0

Fetch = Callable[[str, float], bytes]


def http_get(url: str, timeout: float) -> bytes:
    request = urllib.request.Request(
        url, headers={"User-Agent": "scintille-live-probe", "Cache-Control": "no-cache"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body: bytes = response.read()
    return body


def manifest_age(document: bytes, now: datetime) -> float:
    """Seconds since the manifest was generated; raises ValueError on a broken one."""
    return (now - LiveManifest.model_validate_json(document).generated_at).total_seconds()


def check(
    url: str,
    max_age: float,
    *,
    fetch: Fetch = http_get,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    timeout: float = 10.0,
) -> tuple[bool, str]:
    """(fresh, message) for one read of the manifest."""
    try:
        age = manifest_age(fetch(url, timeout), now())
    except ValueError:
        return False, "invalid manifest"
    except Exception as error:
        return False, f"unreachable: {type(error).__name__}"
    if age > max_age:
        return False, f"stale: generated {age:.0f} s ago (max {max_age:.0f} s)"
    return True, f"fresh: generated {age:.0f} s ago"


class LiveProbe:
    def __init__(
        self,
        url: str = MANIFEST_URL,
        max_age: float = MAX_AGE,
        *,
        heartbeat: Pinger | None = None,
        every: float = 60.0,
        fetch: Fetch = http_get,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.url = url
        self.max_age = max_age
        self.heartbeat = heartbeat
        self.every = every
        self._fetch = fetch
        self._now = now
        self._stop = asyncio.Event()

    async def once(self) -> bool:
        fresh, message = await asyncio.to_thread(
            check, self.url, self.max_age, fetch=self._fetch, now=self._now
        )
        (log.info if fresh else log.warning)(
            "live manifest " + ("fresh" if fresh else "not fresh"),
            extra={"fields": {"detail": message}},
        )
        if self.heartbeat:
            await self.heartbeat.ping(fresh, message)
        return fresh

    async def run(self) -> None:
        while not self._stop.is_set():
            await self.once()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=self.every)

    def stop(self) -> None:
        self._stop.set()
