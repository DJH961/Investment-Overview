"""Tests for the desktop Tiingo fallback orchestration runner."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime, timedelta
from decimal import Decimal

from investment_dashboard.repositories.tiingo_state_repo import TiingoDesktopState
from investment_dashboard.services.tiingo_fallback_runner import (
    FallbackCandidate,
    run_desktop_fallback,
)

_NOW = datetime(2026, 6, 23, 22, 0, 0)  # 18:00 ET, inside NAV window
_MARKET_DATE = date(2026, 6, 23)
_NAV_DATE = date(2026, 6, 23)


class _FakeFetcher:
    """Records calls and serves canned closes per symbol."""

    def __init__(self, data: Mapping[str, Mapping[date, Decimal]]) -> None:
        self._data = data
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, symbols: Sequence[str]) -> dict[str, dict[date, Decimal]]:
        self.calls.append(tuple(symbols))
        return {s: dict(self._data.get(s, {})) for s in symbols}

    @property
    def total_symbols(self) -> int:
        return sum(len(c) for c in self.calls)


def _confirmed_market_state(symbol: str) -> TiingoDesktopState:
    """State where ``symbol`` was already stale in a prior cycle."""
    state = TiingoDesktopState()
    state.stale_since[symbol] = _NOW - timedelta(hours=2)
    return state


# --------------------------------------------------------------------------- #
# Market path
# --------------------------------------------------------------------------- #
def test_market_fetches_confirmed_stale_symbol() -> None:
    state = _confirmed_market_state("FXAIX")
    fetcher = _FakeFetcher({"FXAIX": {_MARKET_DATE: Decimal("180.5")}})
    out = run_desktop_fallback(
        candidates=[FallbackCandidate("FXAIX", is_nav=False, held_date=date(2026, 6, 20))],
        expected_market_date=_MARKET_DATE,
        expected_nav_date=_NAV_DATE,
        primary_failed_symbols={"FXAIX"},
        peer_published=False,
        peer_published_at=None,
        canary_pick=None,
        state=state,
        now_utc=_NOW,
        fetch_closes=fetcher,
    )
    assert out.switched is True
    assert out.closes["FXAIX"][_MARKET_DATE] == Decimal("180.5")
    assert state.day_used == 1
    assert "FXAIX" not in state.stale_since  # cleared on success


def test_market_skips_when_first_seen_stale_this_cycle() -> None:
    # No prior stale stamp -> not a confirmed repeat failure -> hold off.
    state = TiingoDesktopState()
    fetcher = _FakeFetcher({"FXAIX": {_MARKET_DATE: Decimal("180.5")}})
    out = run_desktop_fallback(
        candidates=[FallbackCandidate("FXAIX", is_nav=False, held_date=date(2026, 6, 20))],
        expected_market_date=_MARKET_DATE,
        expected_nav_date=_NAV_DATE,
        primary_failed_symbols={"FXAIX"},
        peer_published=False,
        peer_published_at=None,
        canary_pick=None,
        state=state,
        now_utc=_NOW,
        fetch_closes=fetcher,
    )
    assert out.switched is False
    assert fetcher.calls == []
    assert state.stale_since["FXAIX"] == _NOW  # stamped for next cycle


def test_market_capped_by_budget() -> None:
    state = TiingoDesktopState()
    for s in ("A", "B", "C"):
        state.stale_since[s] = _NOW - timedelta(hours=2)
    state.hour_used = 9  # only 1 call left
    fetcher = _FakeFetcher({s: {_MARKET_DATE: Decimal("1")} for s in ("A", "B", "C")})
    out = run_desktop_fallback(
        candidates=[
            FallbackCandidate(s, is_nav=False, held_date=date(2026, 6, 20)) for s in ("A", "B", "C")
        ],
        expected_market_date=_MARKET_DATE,
        expected_nav_date=_NAV_DATE,
        primary_failed_symbols={"A", "B", "C"},
        peer_published=False,
        peer_published_at=None,
        canary_pick=None,
        state=state,
        now_utc=_NOW,
        fetch_closes=fetcher,
    )
    assert fetcher.total_symbols == 1
    assert len(out.used_symbols) == 1


# --------------------------------------------------------------------------- #
# NAV path — peer laggards
# --------------------------------------------------------------------------- #
def test_nav_peer_laggards_fetched_after_grace() -> None:
    state = TiingoDesktopState()
    fetcher = _FakeFetcher({"FSKAX": {_NAV_DATE: Decimal("160.0")}})
    out = run_desktop_fallback(
        candidates=[FallbackCandidate("FSKAX", is_nav=True, held_date=date(2026, 6, 22))],
        expected_market_date=_MARKET_DATE,
        expected_nav_date=_NAV_DATE,
        primary_failed_symbols=set(),
        peer_published=True,
        peer_published_at=_NOW - timedelta(minutes=35),
        canary_pick="FXAIX",
        state=state,
        now_utc=_NOW,
        fetch_closes=fetcher,
    )
    assert out.closes["FSKAX"][_NAV_DATE] == Decimal("160.0")
    assert state.day_used == 1


def test_nav_peer_waits_within_grace() -> None:
    state = TiingoDesktopState()
    fetcher = _FakeFetcher({"FSKAX": {_NAV_DATE: Decimal("160.0")}})
    out = run_desktop_fallback(
        candidates=[FallbackCandidate("FSKAX", is_nav=True, held_date=date(2026, 6, 22))],
        expected_market_date=_MARKET_DATE,
        expected_nav_date=_NAV_DATE,
        primary_failed_symbols=set(),
        peer_published=True,
        peer_published_at=_NOW - timedelta(minutes=5),
        canary_pick="FXAIX",
        state=state,
        now_utc=_NOW,
        fetch_closes=fetcher,
    )
    assert out.switched is False
    assert fetcher.calls == []


# --------------------------------------------------------------------------- #
# NAV path — canary then promote
# --------------------------------------------------------------------------- #
def test_nav_canary_fresh_promotes_to_laggards() -> None:
    state = TiingoDesktopState()
    fetcher = _FakeFetcher(
        {
            "FXAIX": {_NAV_DATE: Decimal("180.0")},  # canary, fresh
            "FSKAX": {_NAV_DATE: Decimal("160.0")},
            "FZROX": {_NAV_DATE: Decimal("20.0")},
        }
    )
    out = run_desktop_fallback(
        candidates=[
            FallbackCandidate("FXAIX", is_nav=True, held_date=date(2026, 6, 22)),
            FallbackCandidate("FSKAX", is_nav=True, held_date=date(2026, 6, 22)),
            FallbackCandidate("FZROX", is_nav=True, held_date=date(2026, 6, 22)),
        ],
        expected_market_date=_MARKET_DATE,
        expected_nav_date=_NAV_DATE,
        primary_failed_symbols=set(),
        peer_published=False,
        peer_published_at=None,
        canary_pick="FXAIX",
        state=state,
        now_utc=_NOW,
        fetch_closes=fetcher,
    )
    assert set(out.used_symbols) == {"FXAIX", "FSKAX", "FZROX"}
    assert state.canary_count_today == 1
    assert state.day_used == 3  # 1 canary + 2 promoted
    assert state.earliest_habit is not None
    # The fresh canary's publish time is learned per-fund for future picks.
    assert "FXAIX" in state.publish_habits
    assert state.publish_habits["FXAIX"]


def test_nav_canary_stale_aborts_without_promote() -> None:
    state = TiingoDesktopState()
    fetcher = _FakeFetcher(
        {"FXAIX": {date(2026, 6, 22): Decimal("179.0")}}  # canary stale (old date)
    )
    out = run_desktop_fallback(
        candidates=[
            FallbackCandidate("FXAIX", is_nav=True, held_date=date(2026, 6, 22)),
            FallbackCandidate("FSKAX", is_nav=True, held_date=date(2026, 6, 22)),
        ],
        expected_market_date=_MARKET_DATE,
        expected_nav_date=_NAV_DATE,
        primary_failed_symbols=set(),
        peer_published=False,
        peer_published_at=None,
        canary_pick="FXAIX",
        state=state,
        now_utc=_NOW,
        fetch_closes=fetcher,
    )
    assert out.switched is False  # canary date != expected -> nothing merged
    assert state.canary_count_today == 1  # probe still counted
    assert state.day_used == 1
    assert fetcher.calls == [("FXAIX",)]  # no promote fetch


def test_no_candidates_is_noop() -> None:
    state = TiingoDesktopState()
    fetcher = _FakeFetcher({})
    out = run_desktop_fallback(
        candidates=[],
        expected_market_date=_MARKET_DATE,
        expected_nav_date=_NAV_DATE,
        primary_failed_symbols=set(),
        peer_published=False,
        peer_published_at=None,
        canary_pick=None,
        state=state,
        now_utc=_NOW,
        fetch_closes=fetcher,
    )
    assert out.switched is False
    assert fetcher.calls == []


# --------------------------------------------------------------------------- #
# Manual refresh — bypasses timing gates only
# --------------------------------------------------------------------------- #
def test_manual_market_bypasses_confirmed_repeat_gate() -> None:
    # First-seen-stale this cycle: the automatic path holds off (gate C), but a
    # manual refresh fetches immediately since newer data exists.
    state = TiingoDesktopState()
    fetcher = _FakeFetcher({"FXAIX": {_MARKET_DATE: Decimal("180.5")}})
    out = run_desktop_fallback(
        candidates=[FallbackCandidate("FXAIX", is_nav=False, held_date=date(2026, 6, 20))],
        expected_market_date=_MARKET_DATE,
        expected_nav_date=_NAV_DATE,
        primary_failed_symbols={"FXAIX"},
        peer_published=False,
        peer_published_at=None,
        canary_pick=None,
        state=state,
        now_utc=_NOW,
        fetch_closes=fetcher,
        manual=True,
    )
    assert out.switched is True
    assert out.closes["FXAIX"][_MARKET_DATE] == Decimal("180.5")
    assert state.day_used == 1


def test_manual_market_still_skips_when_up_to_date() -> None:
    # Worth-it gate B is NOT bypassed: nothing newer to fetch -> no call.
    state = TiingoDesktopState()
    fetcher = _FakeFetcher({"FXAIX": {_MARKET_DATE: Decimal("180.5")}})
    out = run_desktop_fallback(
        candidates=[FallbackCandidate("FXAIX", is_nav=False, held_date=_MARKET_DATE)],
        expected_market_date=_MARKET_DATE,
        expected_nav_date=_NAV_DATE,
        primary_failed_symbols=set(),
        peer_published=False,
        peer_published_at=None,
        canary_pick=None,
        state=state,
        now_utc=_NOW,
        fetch_closes=fetcher,
        manual=True,
    )
    assert out.switched is False
    assert fetcher.calls == []


def test_manual_nav_canary_bypasses_first_probe_floor() -> None:
    # 16:00 ET (20:00 UTC) is before the ~17:45 first-probe floor, so the auto
    # path waits; a manual refresh fires a single canary anyway.
    early = datetime(2026, 6, 23, 20, 0, 0)
    state = TiingoDesktopState()
    fetcher = _FakeFetcher(
        {
            "FXAIX": {_NAV_DATE: Decimal("180.0")},  # canary, fresh
            "FSKAX": {_NAV_DATE: Decimal("160.0")},
        }
    )
    out = run_desktop_fallback(
        candidates=[
            FallbackCandidate("FXAIX", is_nav=True, held_date=date(2026, 6, 22)),
            FallbackCandidate("FSKAX", is_nav=True, held_date=date(2026, 6, 22)),
        ],
        expected_market_date=_MARKET_DATE,
        expected_nav_date=_NAV_DATE,
        primary_failed_symbols=set(),
        peer_published=False,
        peer_published_at=None,
        canary_pick="FXAIX",
        state=state,
        now_utc=early,
        fetch_closes=fetcher,
        manual=True,
    )
    # Canary fired and, fresh, promoted to the laggard.
    assert set(out.used_symbols) == {"FXAIX", "FSKAX"}
    assert state.canary_count_today == 1


def test_manual_nav_canary_stale_stays_single_probe() -> None:
    # Manual NAV refresh before publication is at most one canary, never a batch.
    early = datetime(2026, 6, 23, 20, 0, 0)
    state = TiingoDesktopState()
    fetcher = _FakeFetcher({"FXAIX": {date(2026, 6, 22): Decimal("179.0")}})  # stale
    out = run_desktop_fallback(
        candidates=[
            FallbackCandidate("FXAIX", is_nav=True, held_date=date(2026, 6, 22)),
            FallbackCandidate("FSKAX", is_nav=True, held_date=date(2026, 6, 22)),
        ],
        expected_market_date=_MARKET_DATE,
        expected_nav_date=_NAV_DATE,
        primary_failed_symbols=set(),
        peer_published=False,
        peer_published_at=None,
        canary_pick="FXAIX",
        state=state,
        now_utc=early,
        fetch_closes=fetcher,
        manual=True,
    )
    assert out.switched is False
    assert fetcher.calls == [("FXAIX",)]  # one probe, no batch burn
