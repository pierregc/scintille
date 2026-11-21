"""Freshness of the public live manifest and reachability of the site, read like a visitor would,
reported to a heartbeat."""

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
SITE_URL = "https://scintille.app/"
MAX_AGE = 180.0
# About 3 % of single reads fail; only repeated failures alert.
ATTEMPTS = 3
RETRY_DELAY = 10.0

Fetch = Callable[[str, float], bytes]


def http_get(url: str, timeout: float) -> bytes:
    request = urllib.request.Request(
        url, headers={"User-Agent": "scintille-live-probe", "Cache-Control": "no-cache"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body: bytes = response.read()
    return body


def describe(error: Exception) -> str:
    reason = getattr(error, "reason", None)
    return f"{type(error).__name__} ({reason})" if reason else type(error).__name__


def check_site(url: str, *, fetch: Fetch = http_get, timeout: float = 10.0) -> tuple[bool, str]:
    try:
        fetch(url, timeout)
    except Exception as error:
        return False, f"site unreachable: {describe(error)}"
    return True, "site up"


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
        return False, f"unreachable: {describe(error)}"
    if age > max_age:
        return False, f"stale: generated {age:.0f} s ago (max {max_age:.0f} s)"
    return True, f"fresh: generated {age:.0f} s ago"


class LiveProbe:
    def __init__(
        self,
        url: str = MANIFEST_URL,
        max_age: float = MAX_AGE,
        *,
        site_url: str | None = SITE_URL,
        heartbeat: Pinger | None = None,
        every: float = 60.0,
        attempts: int = ATTEMPTS,
        retry_delay: float = RETRY_DELAY,
        fetch: Fetch = http_get,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.url = url
        self.max_age = max_age
        self.site_url = site_url
        self.attempts = attempts
        self.retry_delay = retry_delay
        self.heartbeat = heartbeat
        self.every = every
        self._fetch = fetch
        self._now = now
        self._stop = asyncio.Event()

    def _read(self) -> tuple[bool, str]:
        fresh, message = check(self.url, self.max_age, fetch=self._fetch, now=self._now)
        if self.site_url:
            up, site = check_site(self.site_url, fetch=self._fetch)
            fresh, message = fresh and up, f"{message}; {site}"
        return fresh, message

    async def once(self) -> bool:
        for attempt in range(self.attempts):
            fresh, message = await asyncio.to_thread(self._read)
            if fresh or attempt == self.attempts - 1:
                break
            log.info("live probe retry", extra={"fields": {"detail": message}})
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=self.retry_delay)
            if self._stop.is_set():
                return fresh
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
