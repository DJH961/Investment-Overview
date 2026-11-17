"""B-026: failed Tiingo calls spend budget and back off (market + NAV paths)."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain.tiingo_fallback import next_retry_delay
from investment_dashboard.repositories.tiingo_state_repo import TiingoDesktopState
from investment_dashboard.services.tiingo_fallback_runner import (
    FallbackCandidate,
    run_desktop_fallback,
)

_NOW = datetime(2026, 6, 23, 22, 0, 0)  # 18:00 ET, inside the NAV window
_DAY = date(2026, 6, 23)
_OLD = date(2026, 6, 22)


class _Flaky:
    """Fetcher that raises while ``failing`` and serves a fresh close otherwise."""

    def __init__(self, failing: bool = True) -> None:
        self.failing = failing
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, symbols: Sequence[str]) -> dict[str, dict[date, Decimal]]:
        self.calls.append(tuple(symbols))
        if self.failing:
            raise TimeoutError("tiingo down")
        return {s: {_DAY: Decimal("10")} for s in symbols}


def _laggard(fetch: _Flaky, state: TiingoDesktopState, now: datetime) -> None:
    run_desktop_fallback(
        candidates=[FallbackCandidate("FXAIX", is_nav=True, held_date=_OLD)],
        expected_market_date=_DAY,
        expected_nav_date=_DAY,
        primary_failed_symbols=set(),
        peer_published=True,
        peer_published_at=_NOW - timedelta(hours=1),
        canary_pick=None,
        state=state,
        now_utc=now,
        fetch_closes=fetch,
    )


def _market(fetch: _Flaky, state: TiingoDesktopState, now: datetime) -> None:
    run_desktop_fallback(
        candidates=[FallbackCandidate("SPY", is_nav=False, held_date=_OLD)],
        expected_market_date=_DAY,
        expected_nav_date=_DAY,
        primary_failed_symbols={"SPY"},
        peer_published=False,
        peer_published_at=None,
        canary_pick=None,
        state=state,
        now_utc=now,
        fetch_closes=fetch,
    )


def _canary(fetch: _Flaky, state: TiingoDesktopState, now: datetime) -> None:
    run_desktop_fallback(
        candidates=[FallbackCandidate("FXAIX", is_nav=True, held_date=_OLD)],
        expected_market_date=_DAY,
        expected_nav_date=_DAY,
        primary_failed_symbols=set(),
        peer_published=False,
        peer_published_at=None,
        canary_pick="FXAIX",
        state=state,
        now_utc=now,
        fetch_closes=fetch,
    )


@pytest.mark.parametrize(
    ("failures", "minutes"),
    [
        (0, 0),
        (1, 1),
        (2, 2),
        (3, 4),
        (4, 8),
        (5, 16),
        (6, 32),
        (7, 64),
        (8, 128),
        (9, 120),
        (500, 120),
    ],
)
def test_schedule_table(failures: int, minutes: int) -> None:
    assert next_retry_delay(failures) == timedelta(minutes=minutes)


@given(st.integers(min_value=0, max_value=10_000))
def test_schedule_is_monotonic_and_capped(n: int) -> None:
    assert timedelta(0) <= next_retry_delay(n) <= timedelta(hours=2)
    assert next_retry_delay(n) <= next_retry_delay(n + 1)


def test_nav_laggard_failure_spends_budget_and_waits_out_backoff() -> None:
    state = TiingoDesktopState()
    fetch = _Flaky()
    with pytest.raises(TimeoutError):
        _laggard(fetch, state, _NOW)
    assert state.day_used == 1  # a bad bet still costs
    assert state.hour_used == 1
    assert state.fetch_failures == {"FXAIX": 1}

    _laggard(fetch, state, _NOW + timedelta(seconds=30))  # inside 1 min: no call
    assert len(fetch.calls) == 1
    assert state.day_used == 1

    with pytest.raises(TimeoutError):
        _laggard(fetch, state, _NOW + timedelta(seconds=61))
    assert len(fetch.calls) == 2
    assert state.fetch_failures == {"FXAIX": 2}
    # Second failure waits 2 minutes from the failure instant.
    _laggard(fetch, state, _NOW + timedelta(seconds=61 + 100))
    assert len(fetch.calls) == 2


def test_success_resets_backoff() -> None:
    state = TiingoDesktopState()
    fetch = _Flaky()
    with pytest.raises(TimeoutError):
        _laggard(fetch, state, _NOW)
    fetch.failing = False
    _laggard(fetch, state, _NOW + timedelta(minutes=2))
    assert state.fetch_failures == {}
    assert state.retry_not_before == {}
    assert state.day_used == 2


def test_backoff_state_survives_a_reload() -> None:
    state = TiingoDesktopState()
    fetch = _Flaky()
    with pytest.raises(TimeoutError):
        _laggard(fetch, state, _NOW)
    reloaded = TiingoDesktopState.from_json(state.to_json())
    assert reloaded.fetch_failures == {"FXAIX": 1}
    assert reloaded.retry_not_before == state.retry_not_before
    _laggard(fetch, reloaded, _NOW + timedelta(seconds=10))
    assert len(fetch.calls) == 1


def test_market_failure_spends_and_backs_off() -> None:
    state = TiingoDesktopState()
    state.stale_since["SPY"] = _NOW - timedelta(hours=2)
    fetch = _Flaky()
    with pytest.raises(TimeoutError):
        _market(fetch, state, _NOW)
    assert state.day_used == 1
    assert state.fetch_failures == {"SPY": 1}
    # Past the 15 min market cooldown the 1 min backoff has long passed: retried.
    with pytest.raises(TimeoutError):
        _market(fetch, state, _NOW + timedelta(minutes=16))
    assert len(fetch.calls) == 2
    assert state.fetch_failures == {"SPY": 2}
    assert state.day_used == 2


def test_failed_canary_counts_probe_and_spend() -> None:
    state = TiingoDesktopState()
    fetch = _Flaky()
    with pytest.raises(TimeoutError):
        _canary(fetch, state, _NOW)
    assert state.canary_count_today == 1
    assert state.last_canary_at == _NOW
    assert state.day_used == 1
    assert state.fetch_failures == {"FXAIX": 1}


def test_canary_long_backoff_outlasts_cooldown() -> None:
    state = TiingoDesktopState()
    state.fetch_failures["FXAIX"] = 8
    state.retry_not_before["FXAIX"] = _NOW + timedelta(minutes=128)
    fetch = _Flaky()
    _canary(fetch, state, _NOW + timedelta(minutes=60))  # cooldown clear, backoff not
    assert fetch.calls == []
    with pytest.raises(TimeoutError):
        _canary(fetch, state, _NOW + timedelta(minutes=129))
    assert state.fetch_failures == {"FXAIX": 9}
    assert state.retry_not_before["FXAIX"] == _NOW + timedelta(minutes=129) + timedelta(hours=2)
