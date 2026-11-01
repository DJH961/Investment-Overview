"""Tests for the data-pull narrative log (:mod:`pull_log`)."""

from __future__ import annotations

import logging
from datetime import date

import pytest

from investment_dashboard.adapters import _retry
from investment_dashboard.services import pull_log

_PULL_LOGGER = "investment_dashboard.pull"


@pytest.fixture(autouse=True)
def _clear_round() -> None:
    pull_log.reset()
    yield
    pull_log.reset()


def _messages(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == _PULL_LOGGER]


def test_begin_sets_current_and_prints_start_banner(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger=_PULL_LOGGER):
        round_ = pull_log.begin("Live price refresh", mode="auto (TTL-due only)")
    assert pull_log.current() is round_
    msgs = _messages(caplog)
    assert any("PULL" in m and "START" in m for m in msgs)
    assert any("trigger: Live price refresh" in m and "auto (TTL-due only)" in m for m in msgs)


def test_end_clears_current_and_summarises_settled(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger=_PULL_LOGGER):
        round_ = pull_log.begin("Live price refresh", mode="auto")
        round_.settled("yfinance", {"VTI": 2, "BND": 0})
        pull_log.end(round_)
    assert pull_log.current() is None
    msgs = _messages(caplog)
    # The settled line names only the symbols that actually got fresh closes.
    assert any("settled 1/2 symbol(s), 2 new close(s): VTI" in m for m in msgs)
    # The END summary rolls up the counts and demarcates the round.
    assert any(
        "summary:" in m and "2 close(s) written" in m and "1/2 symbol(s) fresh" in m for m in msgs
    )
    assert any("PULL" in m and "END" in m for m in msgs)


def test_provider_failed_and_suspect_raise_summary_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.INFO, logger=_PULL_LOGGER):
        round_ = pull_log.begin("Live price refresh", mode="auto")
        round_.requested_window("yfinance", ["VTI"], date(2024, 1, 1), date(2024, 1, 2))
        round_.provider_failed("yfinance", "boom")
        round_.suspect_data("yfinance", ["VTI"])
        pull_log.end(round_)
    records = [r for r in caplog.records if r.name == _PULL_LOGGER]
    # The FAILED + SUSPECT lines and the summary are all WARNING (so they toast).
    assert any(r.levelno == logging.WARNING and "FAILED" in r.getMessage() for r in records)
    assert any(r.levelno == logging.WARNING and "SUSPECT" in r.getMessage() for r in records)
    summary = next(r for r in records if "summary:" in r.getMessage())
    assert summary.levelno == logging.WARNING
    assert "failed: yfinance" in summary.getMessage()
    assert "1 suspect" in summary.getMessage()


def test_backoff_and_fallback_and_budget(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger=_PULL_LOGGER):
        round_ = pull_log.begin("Live price refresh", mode="auto")
        round_.backoff("yfinance batch", 1, 3, 0.5, reason="rate-limited")
        round_.fallback("tiingo", {"VWELX": 1}, ["canary VWELX fresh"])
        round_.budget(
            "tiingo",
            hour_remaining=7,
            hourly_cap=10,
            day_remaining=188,
            daily_cap=200,
        )
        pull_log.end(round_)
    msgs = _messages(caplog)
    assert any("backed off (rate-limited)" in m and "waiting 0.50s" in m for m in msgs)
    assert any(
        "tiingo FALLBACK covered 1 symbol(s)" in m and "canary VWELX fresh" in m for m in msgs
    )
    assert any("tiingo budget remaining: 7/10 this hour, 188/200 today" in m for m in msgs)
    assert any("1 via Tiingo" in m and "backoff x1" in m for m in msgs)


def test_round_scope_opens_and_closes() -> None:
    assert pull_log.current() is None
    with pull_log.round_scope("Startup price backfill", mode="startup") as round_:
        assert pull_log.current() is round_
    assert pull_log.current() is None


def test_finish_is_idempotent(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger=_PULL_LOGGER):
        round_ = pull_log.begin("x", mode="y")
        round_.finish()
        round_.finish()
    # Only one END banner even though finish() ran twice.
    ends = [m for m in _messages(caplog) if "END" in m]
    assert len(ends) == 1


def test_retry_routes_backoff_into_active_round(caplog: pytest.LogCaptureFixture) -> None:
    calls = {"n": 0}

    def _flaky() -> str:
        calls["n"] += 1
        if calls["n"] < 2:
            raise ValueError("transient")
        return "ok"

    with caplog.at_level(logging.INFO, logger=_PULL_LOGGER):
        round_ = pull_log.begin("Live price refresh", mode="auto")
        result = _retry.retry_call(_flaky, sleep=lambda _: None, description="yfinance")
        pull_log.end(round_)
    assert result == "ok"
    msgs = _messages(caplog)
    assert any("backed off (transient error" in m for m in msgs)
    assert any("backoff x1" in m for m in msgs)


def test_retry_backoff_falls_back_to_plain_warning_without_round(
    caplog: pytest.LogCaptureFixture,
) -> None:
    calls = {"n": 0}

    def _flaky() -> str:
        calls["n"] += 1
        if calls["n"] < 2:
            raise ValueError("transient")
        return "ok"

    with caplog.at_level(logging.WARNING, logger=_retry.__name__):
        result = _retry.retry_call(_flaky, sleep=lambda _: None, description="yfinance")
    assert result == "ok"
    assert any("backing off" in r.getMessage() for r in caplog.records if r.name == _retry.__name__)


def test_refresh_due_prices_emits_full_narrative(session, monkeypatch, caplog) -> None:
    """A real (un-wrapped) refresh auto-opens a round and narrates it START→END."""
    from datetime import UTC, datetime
    from decimal import Decimal

    from investment_dashboard.repositories import instruments_repo
    from investment_dashboard.services import prices_service

    instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    session.flush()

    now = datetime.now(UTC).replace(tzinfo=None)
    today = now.date()
    monkeypatch.setattr(
        prices_service, "fetch_closes", lambda *a, **k: {"VTI": {today: Decimal("100")}}
    )

    with caplog.at_level(logging.INFO, logger=_PULL_LOGGER):
        result = prices_service.refresh_due_prices(session, now=now, today=today)

    assert result["VTI"] == 1
    msgs = _messages(caplog)
    assert any("PULL" in m and "START" in m for m in msgs)
    assert any("trigger: Live price refresh" in m for m in msgs)
    assert any("yfinance: requesting 1 symbol(s)" in m and "VTI" in m for m in msgs)
    assert any("settled 1/1 symbol(s), 1 new close(s): VTI" in m for m in msgs)
    assert any("summary:" in m and "1 close(s) written" in m for m in msgs)
    assert any("PULL" in m and "END" in m for m in msgs)
    # The round is cleared once the auto-opened refresh returns.
    assert pull_log.current() is None
