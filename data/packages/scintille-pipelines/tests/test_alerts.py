from datetime import UTC, datetime, timedelta

import pytest
from dagster import DagsterInstance, job, op
from scintille_pipelines import alerts
from scintille_pipelines.alerts import RETRY_GRACE, failing, pipeline_health

OUTCOMES: list[bool] = []


@op
def outcome() -> None:
    if not OUTCOMES.pop(0):
        raise RuntimeError("boom")


@job
def daily_gold() -> None:
    outcome()


@job
def flash_archive() -> None:
    outcome()


def run(instance: DagsterInstance, definition: object, ok: bool) -> None:
    OUTCOMES.append(ok)
    definition.execute_in_process(instance=instance, raise_on_error=False)  # type: ignore[attr-defined]


def later() -> datetime:
    return datetime.now(UTC) + RETRY_GRACE + timedelta(seconds=1)


def test_a_job_fails_after_its_threshold_of_consecutive_failures() -> None:
    with DagsterInstance.ephemeral() as instance:
        run(instance, flash_archive, False)
        run(instance, daily_gold, True)
        run(instance, daily_gold, False)
        assert failing(instance, "flash_archive", later())
        assert not failing(instance, "daily_gold", later())
        run(instance, daily_gold, False)
        assert failing(instance, "daily_gold", later())
        assert not failing(instance, "daily_gold", datetime.now(UTC))
        run(instance, daily_gold, True)
        assert not failing(instance, "daily_gold", later())
        assert not failing(instance, "never_ran", later())


def test_health_reports_stale_gold_and_failing_jobs() -> None:
    now = later()
    with DagsterInstance.ephemeral() as instance:
        assert pipeline_health(instance, ["daily_gold"], now - timedelta(minutes=5), now) == (
            True,
            "gold fresh, no job failing",
        )
        run(instance, flash_archive, False)
        healthy, message = pipeline_health(
            instance, ["daily_gold", "flash_archive"], now - timedelta(minutes=55), now
        )
        assert not healthy
        assert message == "gold last built 55 min ago; flash_archive failing"
        assert pipeline_health(instance, [], None, now) == (False, "gold last built never")


def test_ping_targets_fail_endpoint_and_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[tuple[str, bytes]] = []
    monkeypatch.setattr(alerts, "http_post", lambda url, body, timeout: sent.append((url, body)))
    assert not alerts.ping(True, "ok")
    monkeypatch.setenv(alerts.PIPELINES_HEALTHCHECK, "https://hc.test/abc/")
    assert alerts.ping(True, "ok") and alerts.ping(False, "gold stale")
    assert sent == [("https://hc.test/abc", b"ok"), ("https://hc.test/abc/fail", b"gold stale")]

    def down(url: str, body: bytes, timeout: float) -> None:
        raise OSError("unreachable")

    monkeypatch.setattr(alerts, "http_post", down)
    assert not alerts.ping(False, "gold stale")
