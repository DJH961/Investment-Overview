"""The frozen-quote detector (2026-11-05: yfinance served unchanged quotes for 100 min)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain import feed_stall, market_hours
from investment_dashboard.domain.feed_stall import StallState, observe

T0 = datetime(2026, 11, 5, 17, 0, tzinfo=UTC)
A = {"VTI": Decimal("364.80"), "VOO": Decimal("620.10")}
B = {"VTI": Decimal("364.60"), "VOO": Decimal("620.00")}


def _pull(state: StallState, minute: int, quotes: dict[str, Decimal], *, mt_lag: int = 0):
    now = T0 + timedelta(minutes=minute)
    return observe(
        state,
        now=now,
        market_open=True,
        quotes=quotes,
        newest_market_time=now - timedelta(minutes=mt_lag),
    )


def test_moving_quotes_never_stall() -> None:
    state = StallState()
    for minute in range(30):
        state, change = _pull(state, minute, A if minute % 2 else B)
        assert change.started is None
        assert state.stalled_since is None


def test_unchanged_quotes_stall_after_four_minutes_and_recover() -> None:
    state, _ = _pull(StallState(), 0, A)
    starts = []
    for minute in range(1, 6):
        state, change = _pull(state, minute, A)
        if change.started:
            starts.append((minute, change.started))
    # Declared once, dated back to when the prices last moved.
    assert starts == [(4, T0)]
    state, change = _pull(state, 10, B)
    assert change.ended == (T0, T0 + timedelta(minutes=10))
    assert state.stalled_since is None


def test_old_market_time_stalls_even_if_a_value_flickers() -> None:
    state, _ = _pull(StallState(), 0, A)
    state, change = _pull(state, 1, B, mt_lag=6)
    assert change.started is not None
    # Moved values with a still-old market time do not end it.
    state, change = _pull(state, 2, A, mt_lag=7)
    assert change.ended is None
    assert state.stalled_since is not None


def test_market_close_ends_a_stall() -> None:
    state = StallState(signature=(), signature_since=T0, stalled_since=T0)
    state, change = observe(
        state, now=T0 + timedelta(hours=1), market_open=False, quotes=A, newest_market_time=None
    )
    assert change.ended == (T0, T0 + timedelta(hours=1))
    assert state == StallState()


def test_frozen_points_keep_first_point_of_long_runs_only() -> None:
    pts = [(T0 + timedelta(minutes=m), Decimal(m)) for m in range(5)]
    frozen = [(T0 + timedelta(minutes=m), Decimal("4")) for m in range(5, 12)]
    short = [(T0 + timedelta(minutes=12), Decimal("7")), (T0 + timedelta(minutes=13), Decimal("7"))]
    out = feed_stall.frozen_points([*pts, *frozen, *short])
    assert out == [t for t, _ in frozen]  # the run started at minute 4 (value 4)


@given(st.lists(st.integers(min_value=0, max_value=3), min_size=0, max_size=60))
def test_frozen_points_never_remove_a_value_change(values: list[int]) -> None:
    samples = [(T0 + timedelta(minutes=i), Decimal(v)) for i, v in enumerate(values)]
    dropped = set(feed_stall.frozen_points(samples))
    kept = [(t, v) for t, v in samples if t not in dropped]

    # Every point where the value changed (and the very first) is kept, so the
    # kept series has the same sequence of distinct values.
    def runs(seq: list[tuple[datetime, Decimal]]) -> list[Decimal]:
        out: list[Decimal] = []
        for _, v in seq:
            if not out or out[-1] != v:
                out.append(v)
        return out

    assert runs(kept) == runs(samples)


def test_merge_windows() -> None:
    a = (T0, T0 + timedelta(minutes=10))
    b = (T0 + timedelta(minutes=5), T0 + timedelta(minutes=20))
    c = (T0 + timedelta(hours=1), T0 + timedelta(hours=2))
    assert feed_stall.merge_windows([c, b, a]) == [(T0, T0 + timedelta(minutes=20)), c]


def test_live_needs_a_recent_price_not_just_a_recent_pull() -> None:
    now = T0
    recent_pull = now - timedelta(seconds=30)
    assert market_hours.is_live_now(market_open=True, last_update_at=recent_pull, now=now)
    # A pull 30 s ago that still brought a 5-minute-old price is not live.
    assert not market_hours.is_live_now(
        market_open=True,
        last_update_at=recent_pull,
        now=now,
        price_market_at=now - timedelta(minutes=5),
    )
    assert market_hours.is_live_now(
        market_open=True,
        last_update_at=recent_pull,
        now=now,
        price_market_at=now - timedelta(seconds=40),
    )
    # A pull several minutes ago is not live either (used to be 15 min).
    assert not market_hours.is_live_now(
        market_open=True, last_update_at=now - timedelta(minutes=4), now=now
    )
    assert not market_hours.is_live_now(
        market_open=True, last_update_at=recent_pull, now=now, feed_stalled=True
    )
