"""Unit tests for the pure Tiingo fallback decision core.

These exercise every gate and the NAV two-tier logic across the scenarios the
design iterated on: pre-market, during market, after close waiting on NAV, peer
trickle, canary cooldown/cap, budget exhaustion, and elapsed-since-stamp firing.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from decimal import Decimal

from investment_dashboard.services.tiingo_fallback import (
    Budget,
    MarketSymbolState,
    NavAction,
    canary_score,
    choose_canary,
    decide_nav,
    eastern_day,
    first_probe_time,
    is_new_budget_day,
    market_symbol_eligible,
    nav_cooldown_for,
    now_eastern,
    select_within_budget,
)

# A summer UTC instant that maps to 18:00 Eastern (EDT, UTC-4): well inside the
# NAV-posting window. 22:00 UTC -> 18:00 ET.
_NAV_WINDOW_UTC = datetime(2026, 6, 23, 22, 0, 0)
# 20:00 UTC -> 16:00 ET: after close but before any NAV could post.
_PRE_NAV_UTC = datetime(2026, 6, 23, 20, 0, 0)


# --------------------------------------------------------------------------- #
# Timezone / budget-day helpers
# --------------------------------------------------------------------------- #
def test_now_eastern_converts_naive_utc() -> None:
    assert now_eastern(_NAV_WINDOW_UTC).time() == time(18, 0)


def test_eastern_day_rolls_over_at_local_midnight() -> None:
    # 03:00 UTC on the 24th is 23:00 ET on the 23rd.
    assert eastern_day(datetime(2026, 6, 24, 3, 0)) == date(2026, 6, 23)


def test_is_new_budget_day() -> None:
    assert is_new_budget_day(None, _NAV_WINDOW_UTC) is True
    same = datetime(2026, 6, 23, 14, 0)
    assert is_new_budget_day(same, _NAV_WINDOW_UTC) is False
    # Next ET day.
    assert is_new_budget_day(same, datetime(2026, 6, 24, 14, 0)) is True


# --------------------------------------------------------------------------- #
# Budget
# --------------------------------------------------------------------------- #
def test_budget_remaining_is_min_of_hour_and_day() -> None:
    assert Budget(hour_used=9, day_used=10).remaining() == 1  # hour binds
    assert Budget(hour_used=0, day_used=200).remaining() == 0  # day binds
    assert Budget(hour_used=10, day_used=0).has_room() is False


def test_select_within_budget_trims() -> None:
    assert select_within_budget(["A", "B", "C"], Budget(hour_used=8, day_used=0)) == ["A", "B"]
    assert select_within_budget(["A"], Budget(hour_used=10, day_used=0)) == []


# --------------------------------------------------------------------------- #
# Market-symbol gates (A–C)
# --------------------------------------------------------------------------- #
def _market(**kw: object) -> MarketSymbolState:
    base: dict[str, object] = dict(
        symbol="FXAIX",
        held_date=date(2026, 6, 19),
        expected_date=date(2026, 6, 22),
        primary_failed=False,
        stale_since=_NAV_WINDOW_UTC - timedelta(minutes=10),
        repeat_failure_confirmed=True,
    )
    base.update(kw)
    return MarketSymbolState(**base)  # type: ignore[arg-type]


def test_market_eligible_when_behind_and_confirmed() -> None:
    assert market_symbol_eligible(_market(), now_utc=_NAV_WINDOW_UTC) is True


def test_market_not_eligible_when_holding_expected_session() -> None:
    # yfinance errored, but we already hold the latest settled session -> not worth it.
    state = _market(held_date=date(2026, 6, 22), primary_failed=True)
    assert market_symbol_eligible(state, now_utc=_NAV_WINDOW_UTC) is False


def test_market_not_eligible_within_grace() -> None:
    state = _market(stale_since=_NAV_WINDOW_UTC - timedelta(minutes=1))
    assert market_symbol_eligible(state, now_utc=_NAV_WINDOW_UTC) is False


def test_market_not_eligible_without_confirmed_repeat_failure() -> None:
    state = _market(repeat_failure_confirmed=False)
    assert market_symbol_eligible(state, now_utc=_NAV_WINDOW_UTC) is False


def test_market_not_eligible_when_never_stale() -> None:
    state = _market(stale_since=None)
    assert market_symbol_eligible(state, now_utc=_NAV_WINDOW_UTC) is False


def test_market_eligible_fires_on_elapsed_after_app_reopen() -> None:
    # Stamp set long ago; the app was closed the whole time. On reopen the grace
    # is already elapsed and it fires immediately.
    state = _market(stale_since=_NAV_WINDOW_UTC - timedelta(hours=5))
    assert market_symbol_eligible(state, now_utc=_NAV_WINDOW_UTC) is True


# --------------------------------------------------------------------------- #
# NAV cooldown / first-probe helpers
# --------------------------------------------------------------------------- #
def test_nav_cooldown_window_vs_off() -> None:
    assert nav_cooldown_for(time(18, 0)) == timedelta(minutes=15)
    assert nav_cooldown_for(time(20, 0)) == timedelta(minutes=30)


def test_first_probe_time_uses_floor_then_grace() -> None:
    assert first_probe_time(None) == time(17, 45)
    # A later learned habit pushes it out.
    assert first_probe_time(time(18, 0)) == time(18, 15)
    # An earlier habit can't beat the 17:30 floor.
    assert first_probe_time(time(16, 0)) == time(17, 45)


# --------------------------------------------------------------------------- #
# NAV decision — Tier 1 (peer confirmation)
# --------------------------------------------------------------------------- #
def _budget() -> Budget:
    return Budget(hour_used=0, day_used=0)


def test_nav_waits_when_nothing_missing() -> None:
    d = decide_nav(
        missing_funds=[],
        peer_published=True,
        peer_published_at=None,
        canary_pick="FXAIX",
        earliest_habit=None,
        last_canary_at=None,
        canary_count_today=0,
        now_utc=_NAV_WINDOW_UTC,
        budget=_budget(),
    )
    assert d.action is NavAction.WAIT


def test_nav_tier1_waits_within_peer_grace() -> None:
    d = decide_nav(
        missing_funds=["FSKAX"],
        peer_published=True,
        peer_published_at=_NAV_WINDOW_UTC - timedelta(minutes=10),
        canary_pick="FXAIX",
        earliest_habit=None,
        last_canary_at=None,
        canary_count_today=0,
        now_utc=_NAV_WINDOW_UTC,
        budget=_budget(),
    )
    assert d.action is NavAction.WAIT
    assert "grace" in d.reason


def test_nav_tier1_fetches_laggards_after_peer_grace() -> None:
    d = decide_nav(
        missing_funds=["FSKAX", "FZROX"],
        peer_published=True,
        peer_published_at=_NAV_WINDOW_UTC - timedelta(minutes=35),
        canary_pick="FXAIX",
        earliest_habit=None,
        last_canary_at=None,
        canary_count_today=0,
        now_utc=_NAV_WINDOW_UTC,
        budget=_budget(),
    )
    assert d.action is NavAction.FETCH_LAGGARDS
    assert d.symbols == ("FSKAX", "FZROX")


def test_nav_tier1_laggards_capped_by_budget() -> None:
    d = decide_nav(
        missing_funds=["FSKAX", "FZROX", "FNILX"],
        peer_published=True,
        peer_published_at=_NAV_WINDOW_UTC - timedelta(minutes=35),
        canary_pick=None,
        earliest_habit=None,
        last_canary_at=None,
        canary_count_today=0,
        now_utc=_NAV_WINDOW_UTC,
        budget=Budget(hour_used=9, day_used=0),  # only 1 left
    )
    assert d.action is NavAction.FETCH_LAGGARDS
    assert d.symbols == ("FSKAX",)


# --------------------------------------------------------------------------- #
# NAV decision — Tier 2 (canary)
# --------------------------------------------------------------------------- #
def test_nav_tier2_waits_before_first_probe() -> None:
    d = decide_nav(
        missing_funds=["FSKAX"],
        peer_published=False,
        peer_published_at=None,
        canary_pick="FXAIX",
        earliest_habit=None,
        last_canary_at=None,
        canary_count_today=0,
        now_utc=_PRE_NAV_UTC,  # 16:00 ET, before 17:45
        budget=_budget(),
    )
    assert d.action is NavAction.WAIT
    assert "first-probe" in d.reason


def test_nav_tier2_canary_fires_in_window() -> None:
    d = decide_nav(
        missing_funds=["FSKAX"],
        peer_published=False,
        peer_published_at=None,
        canary_pick="FXAIX",
        earliest_habit=None,
        last_canary_at=None,
        canary_count_today=0,
        now_utc=_NAV_WINDOW_UTC,  # 18:00 ET
        budget=_budget(),
    )
    assert d.action is NavAction.CANARY
    assert d.symbols == ("FXAIX",)


def test_nav_tier2_respects_cooldown() -> None:
    d = decide_nav(
        missing_funds=["FSKAX"],
        peer_published=False,
        peer_published_at=None,
        canary_pick="FXAIX",
        earliest_habit=None,
        last_canary_at=_NAV_WINDOW_UTC - timedelta(minutes=5),  # < 15 min
        canary_count_today=1,
        now_utc=_NAV_WINDOW_UTC,
        budget=_budget(),
    )
    assert d.action is NavAction.WAIT
    assert "cooldown" in d.reason


def test_nav_tier2_canary_after_cooldown_elapsed() -> None:
    d = decide_nav(
        missing_funds=["FSKAX"],
        peer_published=False,
        peer_published_at=None,
        canary_pick="FXAIX",
        earliest_habit=None,
        last_canary_at=_NAV_WINDOW_UTC - timedelta(minutes=20),  # > 15 min
        canary_count_today=1,
        now_utc=_NAV_WINDOW_UTC,
        budget=_budget(),
    )
    assert d.action is NavAction.CANARY


def test_nav_tier2_hard_daily_cap() -> None:
    d = decide_nav(
        missing_funds=["FSKAX"],
        peer_published=False,
        peer_published_at=None,
        canary_pick="FXAIX",
        earliest_habit=None,
        last_canary_at=None,
        canary_count_today=8,  # at cap
        now_utc=_NAV_WINDOW_UTC,
        budget=_budget(),
    )
    assert d.action is NavAction.WAIT
    assert "cap" in d.reason


def test_nav_tier2_waits_without_candidate() -> None:
    d = decide_nav(
        missing_funds=["FSKAX"],
        peer_published=False,
        peer_published_at=None,
        canary_pick=None,
        earliest_habit=None,
        last_canary_at=None,
        canary_count_today=0,
        now_utc=_NAV_WINDOW_UTC,
        budget=_budget(),
    )
    assert d.action is NavAction.WAIT
    assert "candidate" in d.reason


def test_nav_budget_exhausted_blocks_everything() -> None:
    d = decide_nav(
        missing_funds=["FSKAX"],
        peer_published=False,
        peer_published_at=None,
        canary_pick="FXAIX",
        earliest_habit=None,
        last_canary_at=None,
        canary_count_today=0,
        now_utc=_NAV_WINDOW_UTC,
        budget=Budget(hour_used=10, day_used=0),
    )
    assert d.action is NavAction.WAIT
    assert "budget" in d.reason


# --- Smart canary selection (choose_canary / canary_score) -------------------


def test_canary_score_none_without_history() -> None:
    assert canary_score(()) is None


def test_canary_score_prefers_early_and_consistent() -> None:
    # A steady 17:40 publisher scores below a jittery one averaging later.
    steady = canary_score([time(17, 40), time(17, 40), time(17, 42)])
    jittery = canary_score([time(17, 40), time(18, 30), time(19, 0)])
    assert steady is not None
    assert jittery is not None
    assert steady < jittery


def test_choose_canary_cold_start_picks_largest_holding() -> None:
    # No habit anywhere → fall back to the largest holding by value.
    pick = choose_canary(
        ["FSKAX", "FXAIX", "FZROX"],
        holding_values={
            "FSKAX": Decimal("1000"),
            "FXAIX": Decimal("5000"),
            "FZROX": Decimal("250"),
        },
    )
    assert pick == "FXAIX"


def test_choose_canary_cold_start_ties_break_by_symbol() -> None:
    pick = choose_canary(
        ["FZROX", "FSKAX"],
        holding_values={"FZROX": Decimal("100"), "FSKAX": Decimal("100")},
    )
    assert pick == "FSKAX"


def test_choose_canary_prefers_habit_over_holding_size() -> None:
    # FXAIX is the biggest holding, but FSKAX reliably publishes earliest, so it
    # is the better probe (most likely already out by now).
    pick = choose_canary(
        ["FSKAX", "FXAIX"],
        holding_values={"FSKAX": Decimal("100"), "FXAIX": Decimal("9999")},
        publish_habits={
            "FSKAX": [time(17, 35), time(17, 36), time(17, 35)],
            "FXAIX": [time(18, 50), time(19, 10), time(18, 40)],
        },
    )
    assert pick == "FSKAX"


def test_choose_canary_habit_tiebreak_uses_largest_holding() -> None:
    # Identical publish habits → the larger holding wins the tiebreak.
    pick = choose_canary(
        ["FSKAX", "FXAIX"],
        holding_values={"FSKAX": Decimal("100"), "FXAIX": Decimal("9999")},
        publish_habits={
            "FSKAX": [time(17, 40)],
            "FXAIX": [time(17, 40)],
        },
    )
    assert pick == "FXAIX"


def test_choose_canary_funds_with_history_beat_unknowns() -> None:
    # A fund with *any* learned habit is preferred over an unmeasured one, even
    # if the unmeasured fund is larger — evidence beats a guess.
    pick = choose_canary(
        ["FSKAX", "FXAIX"],
        holding_values={"FSKAX": Decimal("100"), "FXAIX": Decimal("9999")},
        publish_habits={"FSKAX": [time(18, 0)]},
    )
    assert pick == "FSKAX"


def test_choose_canary_empty_is_none() -> None:
    assert choose_canary([]) is None
