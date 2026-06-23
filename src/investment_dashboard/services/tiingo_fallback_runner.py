"""Orchestration for the desktop Tiingo fallback — glue, still I/O-light.

This ties the three pieces together for one refresh cycle: the pure gates
(:mod:`tiingo_fallback`), the persisted budget/canary/stale state
(:mod:`tiingo_state_repo`) and an injected ``fetch_closes`` (the Tiingo adapter
in production, a fake in tests). It decides which still-stale symbols are worth a
Tiingo call, spends the budget, runs the NAV two-tier (peer/canary with promote),
and returns the merged closes plus whether a provider switch happened (so the
caller can fire the loud desktop popup).

Keeping the network behind a callable means every branch — market gating, NAV
peer-confirmation, canary-then-promote, budget exhaustion — is unit-testable with
no HTTP and no clock.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal

from investment_dashboard.repositories import tiingo_state_repo as state_repo
from investment_dashboard.repositories.tiingo_state_repo import TiingoDesktopState
from investment_dashboard.services.tiingo_fallback import (
    MarketSymbolState,
    NavAction,
    decide_nav,
    market_symbol_eligible,
    now_eastern,
    select_within_budget,
)

#: Injected close-fetcher: maps symbols to ``{date: close}`` (Tiingo daily).
FetchCloses = Callable[[Sequence[str]], Mapping[str, Mapping[date, Decimal]]]


@dataclass(frozen=True)
class FallbackCandidate:
    """A due instrument that is still stale/missing after the primary refresh."""

    symbol: str
    is_nav: bool
    held_date: date | None


@dataclass
class FallbackOutcome:
    """Result of one fallback cycle, ready for the caller to merge + persist."""

    closes: dict[str, dict[date, Decimal]] = field(default_factory=dict)
    used_symbols: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)

    @property
    def switched(self) -> bool:
        """Whether any usable Tiingo data was merged (drives the loud popup)."""
        return bool(self.used_symbols)


def _latest(closes: Mapping[date, Decimal]) -> date | None:
    return max(closes) if closes else None


def _merge(outcome: FallbackOutcome, fetched: Mapping[str, Mapping[date, Decimal]]) -> list[str]:
    """Fold non-empty fetched closes into the outcome; return symbols used."""
    used: list[str] = []
    for sym, closes in fetched.items():
        if closes:
            outcome.closes[sym] = dict(closes)
            outcome.used_symbols.append(sym)
            used.append(sym)
    return used


def _run_market(
    market: Sequence[FallbackCandidate],
    *,
    expected_market_date: date,
    primary_failed_symbols: set[str],
    previously_stale: Mapping[str, datetime],
    state: TiingoDesktopState,
    now_utc: datetime,
    fetch_closes: FetchCloses,
    outcome: FallbackOutcome,
    manual: bool = False,
) -> None:
    eligible: list[str] = []
    for cand in market:
        stale_since = previously_stale.get(cand.symbol) or state.stale_since.get(cand.symbol)
        gate_state = MarketSymbolState(
            symbol=cand.symbol,
            held_date=cand.held_date,
            expected_date=expected_market_date,
            primary_failed=cand.symbol in primary_failed_symbols,
            stale_since=stale_since,
            # A *confirmed* repeat failure means it was already stale in a prior
            # cycle (not just this one) and is still failing now.
            repeat_failure_confirmed=cand.symbol in previously_stale,
        )
        if market_symbol_eligible(gate_state, now_utc=now_utc, manual=manual):
            eligible.append(cand.symbol)

    selected = select_within_budget(eligible, state.budget())
    if not selected:
        return
    fetched = fetch_closes(selected)
    state_repo.record_spend(state, len(selected))
    for sym in _merge(outcome, fetched):
        state_repo.clear_stale(state, sym)
    outcome.reasons.append(f"market fallback: {', '.join(selected)}")


def _run_nav(
    nav: Sequence[FallbackCandidate],
    *,
    expected_nav_date: date,
    peer_published: bool,
    peer_published_at: datetime | None,
    canary_pick: str | None,
    state: TiingoDesktopState,
    now_utc: datetime,
    fetch_closes: FetchCloses,
    outcome: FallbackOutcome,
    manual: bool = False,
) -> None:
    missing = [
        c.symbol for c in nav if c.held_date is None or c.held_date < expected_nav_date
    ]
    decision = decide_nav(
        missing_funds=missing,
        peer_published=peer_published,
        peer_published_at=peer_published_at,
        canary_pick=canary_pick,
        earliest_habit=state.earliest_habit,
        last_canary_at=state.last_canary_at,
        canary_count_today=state.canary_count_today,
        now_utc=now_utc,
        budget=state.budget(),
        manual=manual,
    )
    if decision.action is NavAction.WAIT:
        outcome.reasons.append(f"NAV wait: {decision.reason}")
        return

    if decision.action is NavAction.FETCH_LAGGARDS:
        fetched = fetch_closes(decision.symbols)
        state_repo.record_spend(state, len(decision.symbols))
        for sym in _merge(outcome, fetched):
            state_repo.clear_stale(state, sym)
        outcome.reasons.append(f"NAV laggards: {', '.join(decision.symbols)}")
        return

    # CANARY: probe one fund; on a fresh NAV, promote to the remaining laggards.
    canary = decision.symbols[0]
    fetched = fetch_closes((canary,))
    state_repo.record_canary(state, now_utc)
    canary_fresh = _latest(fetched.get(canary, {})) == expected_nav_date
    if not canary_fresh:
        outcome.reasons.append(f"canary {canary}: NAV not yet published")
        return
    state_repo.note_publish_habit(state, now_eastern(now_utc).time())
    for sym in _merge(outcome, {canary: fetched.get(canary, {})}):
        state_repo.clear_stale(state, sym)
    rest = select_within_budget(
        [s for s in missing if s != canary], state.budget()
    )
    if rest:
        more = fetch_closes(rest)
        state_repo.record_spend(state, len(rest))
        for sym in _merge(outcome, more):
            state_repo.clear_stale(state, sym)
    outcome.reasons.append(f"canary {canary} fresh; promoted: {', '.join(rest) or 'none'}")


def run_desktop_fallback(
    *,
    candidates: Sequence[FallbackCandidate],
    expected_market_date: date,
    expected_nav_date: date,
    primary_failed_symbols: set[str],
    peer_published: bool,
    peer_published_at: datetime | None,
    canary_pick: str | None,
    state: TiingoDesktopState,
    now_utc: datetime,
    fetch_closes: FetchCloses,
    manual: bool = False,
) -> FallbackOutcome:
    """Run one desktop fallback cycle and mutate ``state`` (caller persists it).

    ``candidates`` are the due instruments still stale after the yfinance merge.
    ``primary_failed_symbols`` are those yfinance errored/returned empty for this
    cycle; ``peer_published``/``peer_published_at`` describe whether a fresh
    ``expected_nav_date`` NAV arrived for some *other* fund via the primary;
    ``canary_pick`` is the single fund to probe when there's no peer evidence.
    ``manual=True`` is a user-initiated refresh that bypasses the *timing* gates
    only (grace/confirmed-repeat for market, first-probe/cooldown for NAV) while
    keeping the worth-it and budget gates.

    Returns a :class:`FallbackOutcome`; ``state`` carries the updated budget,
    canary and stale-since stamps to persist via ``tiingo_state_repo.save``.
    """
    outcome = FallbackOutcome()
    if not candidates:
        return outcome

    previously_stale = dict(state.stale_since)
    for cand in candidates:
        state_repo.mark_stale(state, cand.symbol, now_utc)

    market = [c for c in candidates if not c.is_nav]
    nav = [c for c in candidates if c.is_nav]

    _run_market(
        market,
        expected_market_date=expected_market_date,
        primary_failed_symbols=primary_failed_symbols,
        previously_stale=previously_stale,
        state=state,
        now_utc=now_utc,
        fetch_closes=fetch_closes,
        outcome=outcome,
        manual=manual,
    )
    _run_nav(
        nav,
        expected_nav_date=expected_nav_date,
        peer_published=peer_published,
        peer_published_at=peer_published_at,
        canary_pick=canary_pick,
        state=state,
        now_utc=now_utc,
        fetch_closes=fetch_closes,
        outcome=outcome,
        manual=manual,
    )
    return outcome
