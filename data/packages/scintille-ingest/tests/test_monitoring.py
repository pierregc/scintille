import asyncio
import time
import urllib.error
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from scintille_ingest.runtime.heartbeat import Heartbeat, heartbeat_from_env
from scintille_ingest.runtime.live_feed import LiveFeed
from scintille_ingest.runtime.live_probe import LiveProbe, check
from scintille_ingest.runtime.metrics import Metrics

NOW = datetime(2026, 7, 15, 18, 30, tzinfo=UTC)
URL = "https://hc-ping.example/abc"


class Recorder:
    def __init__(self, error: Exception | None = None, delay: float = 0.0) -> None:
        self.calls: list[tuple[str, bytes]] = []
        self.error = error
        self.delay = delay

    def __call__(self, url: str, body: bytes, timeout: float) -> None:
        self.calls.append((url, body))
        time.sleep(self.delay)
        if self.error:
            raise self.error


class FakePinger:
    def __init__(self, error: Exception | None = None) -> None:
        self.pings: list[tuple[bool, str]] = []
        self.error = error

    async def ping(self, ok: bool = True, message: str = "") -> bool:
        self.pings.append((ok, message))
        if self.error:
            raise self.error
        return True


def test_heartbeat_pings_success_and_fail_endpoints() -> None:
    send = Recorder()
    beat = Heartbeat(URL + "/", check="ingest-live", send=send)
    assert asyncio.run(beat.ping())
    assert asyncio.run(beat.ping(False, "stopped: glm-east"))
    assert send.calls == [(URL, b""), (URL + "/fail", b"stopped: glm-east")]
    assert (
        beat.metrics.counters[
            ("heartbeat_pings_total", (("check", "ingest-live"), ("status", "fail")))
        ]
        == 1
    )


@pytest.mark.parametrize(
    "send",
    [Recorder(urllib.error.URLError("down")), Recorder(TimeoutError()), Recorder(delay=0.3)],
)
def test_a_failed_ping_never_raises(send: Recorder) -> None:
    beat = Heartbeat(URL, check="ingest-live", send=send, timeout=0.05)
    assert asyncio.run(beat.ping()) is False
    assert beat.metrics.counters[("heartbeat_errors_total", (("check", "ingest-live"),))] == 1


def test_no_heartbeat_without_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SCINTILLE_HEALTHCHECK_URL", raising=False)
    assert heartbeat_from_env("SCINTILLE_HEALTHCHECK_URL", "ingest-live", Metrics()) is None
    monkeypatch.setenv("SCINTILLE_HEALTHCHECK_URL", URL)
    beat = heartbeat_from_env("SCINTILLE_HEALTHCHECK_URL", "ingest-live", Metrics())
    assert beat is not None and beat.url == URL


def manifest_at(tmp_path: Path, generated: datetime) -> bytes:
    feed = LiveFeed(None, outbox=tmp_path)  # type: ignore[arg-type]
    return feed.manifest(generated).model_dump_json().encode()


def test_fresh_manifest(tmp_path: Path) -> None:
    document = manifest_at(tmp_path, NOW - timedelta(seconds=40))
    fresh, message = check("u", 180, fetch=lambda url, timeout: document, now=lambda: NOW)
    assert fresh and message == "fresh: generated 40 s ago"


def test_stale_manifest(tmp_path: Path) -> None:
    document = manifest_at(tmp_path, NOW - timedelta(minutes=4))
    fresh, message = check("u", 180, fetch=lambda url, timeout: document, now=lambda: NOW)
    assert not fresh and message.startswith("stale: generated 240 s ago")


def test_unreachable_or_broken_manifest_is_not_fresh() -> None:
    def down(url: str, timeout: float) -> bytes:
        raise urllib.error.HTTPError(url, 404, "Not Found", None, None)  # type: ignore[arg-type]

    assert check("u", 180, fetch=down) == (False, "unreachable: HTTPError")
    assert check("u", 180, fetch=lambda url, timeout: b"{}") == (False, "invalid manifest")


def test_probe_reports_to_its_heartbeat(tmp_path: Path) -> None:
    pinger = FakePinger()
    stale = manifest_at(tmp_path, datetime.now(UTC) - timedelta(minutes=5))
    probe = LiveProbe("u", 180, heartbeat=pinger, fetch=lambda url, timeout: stale)
    assert asyncio.run(probe.once()) is False
    assert pinger.pings[0][0] is False and pinger.pings[0][1].startswith("stale")
