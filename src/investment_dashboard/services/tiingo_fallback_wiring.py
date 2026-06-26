"""DB-facing glue that runs the desktop Tiingo fallback inside a refresh cycle.

:mod:`tiingo_fallback_runner` is the I/O-light orchestrator; this module supplies
the database plumbing around it: it derives the expected settled session, works
out which due instruments are still behind after the yfinance merge, detects
peer-published NAVs, loads/saves the persisted budget state, binds the Tiingo
adapter (with the resolved token) into the runner's injected fetcher, writes the
recovered closes back through the cache tier, and records the provider switch.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.adapters import tiingo_client
from investment_dashboard.domain.market_hours import is_us_market_holiday
from investment_dashboard.models import Instrument
from investment_dashboard.repositories import price_cache_repo, prices_repo
from investment_dashboard.repositories import tiingo_state_repo as state_repo
from investment_dashboard.services import fetch_report, provider_status, pull_log
from investment_dashboard.services.tiingo_fallback import (
    DESKTOP_DAILY_CAP,
    DESKTOP_HOURLY_CAP,
    choose_canary,
    now_eastern,
)
from investment_dashboard.services.tiingo_fallback_runner import (
    FallbackCandidate,
    FallbackOutcome,
    run_desktop_fallback,
)

log = logging.getLogger(__name__)

#: Asset classes priced off a once-a-day NAV rather than a live market quote.
_NAV_ASSET_CLASSES = frozenset({"mutual_fund"})
#: Exchange close (Eastern) after which the day's session has settled.
_CLOSE_ET = time(16, 0)
#: How far back to ask Tiingo's daily endpoint so the expected session is covered
#: even across a long weekend/holiday gap.
_FETCH_LOOKBACK_DAYS = 7
#: Don't write closes older than this before the expected session (cache hygiene).
_WRITE_LOOKBACK_DAYS = 14

#: Injected Tiingo daily fetcher (the adapter in production, a fake in tests).
TiingoFetchCloses = Callable[..., dict[str, dict[date, Decimal]]]


def _is_trading_day(day: date) -> bool:
    return day.weekday() < 5 and not is_us_market_holiday(day)


def expected_session_date(now_utc: datetime) -> date:
    """The most recent *settled* US session as of ``now_utc`` (holiday-aware).

    Today counts only once its 16:00 ET close has passed; otherwise we roll back
    to the previous trading day, skipping weekends and NYSE holidays. This is the
    date a fully up-to-date close/NAV should carry, so "held older than this"
    means genuinely behind.
    """
    et = now_eastern(now_utc)
    day = et.date()
    if _is_trading_day(day) and et.time() >= _CLOSE_ET:
        return day
    cursor = day - timedelta(days=1)
    while not _is_trading_day(cursor):
        cursor -= timedelta(days=1)
    return cursor


def pick_canary(
    missing_funds: Sequence[str],
    *,
    publish_habits: Mapping[str, Sequence[time]] | None = None,
    holding_values: Mapping[str, Decimal] | None = None,
) -> str | None:
    """Choose the single fund to probe when there's no peer NAV evidence.

    Delegates to the pure :func:`tiingo_fallback.choose_canary`: prefer the fund
    with the earliest + most consistent learned publish habit (most likely
    already out, so the best probe), and fall back to the **largest holding** on
    a cold start or to break ties. The runner promotes to the full missing set
    the moment the canary confirms a fresh NAV, so any held fund is valid.
    """
    return choose_canary(
        missing_funds,
        holding_values=holding_values,
        publish_habits=publish_habits,
    )


def _nav_holding_values(session: Session, symbols: Sequence[str]) -> dict[str, Decimal]:
    """Current native market value per NAV symbol (summed across accounts).

    Used only to size the canary; a missing/zero price simply yields 0, which
    sorts last — acceptable for a tiebreak/cold-start heuristic. Imported lazily
    to keep the module import graph acyclic (mirrors the rest of the wiring).
    """
    if not symbols:
        return {}
    from investment_dashboard.services.positions_service import (  # noqa: PLC0415
        compute_positions,
    )

    wanted = set(symbols)
    totals: dict[str, Decimal] = {}
    for pos in compute_positions(session):
        sym = pos.instrument.symbol
        if sym in wanted:
            totals[sym] = totals.get(sym, Decimal(0)) + pos.current_value_native
    return totals


def _build_candidates(
    due: Sequence[Instrument],
    held_dates: Mapping[int, date],
    expected: date,
) -> list[FallbackCandidate]:
    candidates: list[FallbackCandidate] = []
    for instr in due:
        held = held_dates.get(instr.id)
        if held is not None and held >= expected:
            continue  # already up to date after the primary merge
        candidates.append(
            FallbackCandidate(
                symbol=instr.symbol,
                is_nav=instr.asset_class in _NAV_ASSET_CLASSES,
                held_date=held,
            )
        )
    return candidates


def _peer_published(
    due: Sequence[Instrument],
    held_dates: Mapping[int, date],
    expected: date,
) -> bool:
    """Whether the primary delivered a fresh ``expected`` NAV for *some* fund."""
    return any(
        instr.asset_class in _NAV_ASSET_CLASSES and held_dates.get(instr.id) == expected
        for instr in due
    )


def apply_desktop_fallback(
    session: Session,
    cache: Session,
    *,
    due: Sequence[Instrument],
    now_utc: datetime,
    today: date,
    primary_closes: Mapping[str, Mapping[date, Decimal]],
    token: str,
    fetch_closes_impl: TiingoFetchCloses | None = None,
    manual: bool = False,
) -> tuple[dict[str, int], FallbackOutcome]:
    """Run the fallback for one refresh cycle; write recovered closes + stamps.

    ``primary_closes`` is what yfinance returned this cycle (``{}`` on a hard
    failure). ``manual=True`` is a user-initiated "Refresh via Tiingo now": it
    bypasses the timing gates only (worth-it + budget still enforced). Returns
    ``({symbol: rows_written}, outcome)``; ``outcome.switched`` tells the caller a
    provider switch happened (drives the loud popup).
    """
    fetch_impl = fetch_closes_impl or tiingo_client.fetch_closes
    expected = expected_session_date(now_utc)
    by_symbol = {instr.symbol: instr for instr in due}
    held_dates = prices_repo.latest_price_dates(cache, [instr.id for instr in due])

    candidates = _build_candidates(due, held_dates, expected)
    outcome = FallbackOutcome()
    if not candidates:
        return {}, outcome

    primary_failed = {instr.symbol for instr in due if not primary_closes.get(instr.symbol)}
    nav_missing = [c.symbol for c in candidates if c.is_nav]

    state = state_repo.load(session, now_utc)
    peer_published = _peer_published(due, held_dates, expected)
    peer_at = state_repo.note_peer_nav(state, now_utc) if peer_published else None

    # Only price the canary candidates (the missing NAV funds) when we might
    # actually need a probe — i.e. no peer evidence and funds are missing.
    holding_values = (
        _nav_holding_values(session, nav_missing) if nav_missing and not peer_published else {}
    )
    canary_pick = pick_canary(
        nav_missing,
        publish_habits=state.publish_habits,
        holding_values=holding_values,
    )

    fetch_start = expected - timedelta(days=_FETCH_LOOKBACK_DAYS)
    fetch_end = today + timedelta(days=1)

    def _fetch(symbols: Sequence[str]) -> dict[str, dict[date, Decimal]]:
        return fetch_impl(list(symbols), fetch_start, fetch_end, token=token)

    outcome = run_desktop_fallback(
        candidates=candidates,
        expected_market_date=expected,
        expected_nav_date=expected,
        primary_failed_symbols=primary_failed,
        peer_published=peer_published,
        peer_published_at=peer_at,
        canary_pick=canary_pick,
        state=state,
        now_utc=now_utc,
        fetch_closes=_fetch,
        manual=manual,
    )

    write_cutoff = expected - timedelta(days=_WRITE_LOOKBACK_DAYS)
    result: dict[str, int] = {}
    for symbol in outcome.used_symbols:
        instr = by_symbol.get(symbol)
        if instr is None:
            continue
        filtered = {d: c for d, c in outcome.closes[symbol].items() if d >= write_cutoff}
        result[symbol] = prices_repo.upsert_closes(cache, instr.id, filtered)
        price_cache_repo.upsert_last_refreshed_at(cache, instr.id, now_utc)

    state_repo.save(session, state)

    round_ = pull_log.current()
    if outcome.switched:
        joined = ", ".join(outcome.used_symbols)
        provider_status.record(
            "tiingo",
            "ok",
            f"Tiingo refresh covered: {joined}"
            if manual
            else f"yfinance gap covered via Tiingo: {joined}",
        )
        fetch_report.record("tiingo", outcome.used_symbols)
        # Loud desktop surface: a warning-level runtime notice pops a toast so the
        # user knows the primary feed failed and Tiingo stepped in (deduped, so a
        # repeatedly-failing tick won't spam). For a *manual* refresh the caller
        # owns the result UX (it knows the user just clicked the button), so skip
        # the automatic "yfinance couldn't deliver" toast here.
        if not manual:
            provider_status_runtime_warning(joined)
        if round_ is not None:
            round_.fallback("tiingo", result, outcome.reasons)
            round_.budget(
                "tiingo",
                hour_remaining=max(0, DESKTOP_HOURLY_CAP - state.hour_used),
                hourly_cap=DESKTOP_HOURLY_CAP,
                day_remaining=max(0, DESKTOP_DAILY_CAP - state.day_used),
                daily_cap=DESKTOP_DAILY_CAP,
            )
        else:
            log.info("Tiingo fallback recovered %s", joined)
    elif round_ is not None and outcome.reasons:
        # No usable data, but the fallback still *did* something worth recording
        # (waited for a peer NAV, probed a canary, found the budget spent, …).
        round_.note("tiingo fallback: " + "; ".join(outcome.reasons))

    return result, outcome


def provider_status_runtime_warning(symbols: str) -> None:
    """Raise the loud desktop notice that yfinance fell back to Tiingo."""
    from investment_dashboard.services import runtime_status  # noqa: PLC0415

    runtime_status.record_warning(
        "Price provider fallback",
        f"yfinance couldn't deliver fresh data, so Tiingo covered: {symbols}.",
    )
