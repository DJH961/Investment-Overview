"""How the Tiingo backup is used, and how much of its allowance is left.

Every Tiingo request the app makes is charged against one shared budget kept in
``app_config`` (:mod:`investment_dashboard.repositories.tiingo_state_repo`): a
per-hour bucket that resets at the top of each UTC hour and a per-day bucket that
resets at midnight New York time. The caps are the Settings values "Tiingo calls
per hour" / "per day"; they are the app's own limits, set below Tiingo's
free-plan allowance so the key is never burned through.

This module is the read side for the Health & Repair page (``usage``) plus
:func:`reserve`, which the multi-call repair jobs use to charge several calls at
once (or refuse when the budget can't cover them).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from investment_dashboard.domain.tiingo_fallback import now_eastern

log = logging.getLogger(__name__)

_EASTERN = ZoneInfo("America/New_York")

#: What the key is used for, in the order the page lists it.
USES: tuple[tuple[str, str], ...] = (
    (
        "Live price backup",
        "When yfinance fails, returns nothing, or serves frozen quotes for a stock or "
        "ETF during the session, the latest IEX price is fetched from Tiingo "
        "(automatic, after a short grace period).",
    ),
    (
        "Fund NAV check",
        "After the close, when yfinance has not yet published a mutual fund's NAV, a "
        "few spaced-out probes ask Tiingo whether it has it (automatic, at most 8 a day).",
    ),
    (
        "EUR/USD intraday bars",
        "When yfinance has no intraday EUR/USD bars for the 1 Day / 1 Week graph, one "
        "request fetches them from Tiingo (automatic).",
    ),
    (
        "Graph gap fill",
        "Fills holes in the 1 Day / 1 Week graphs where yfinance has no bars: one "
        "request per held stock/ETF plus one for EUR/USD. Runs by itself when a "
        "frozen-feed stall ends, or from Repair > Providers > Fill graph gaps from Tiingo.",
    ),
    (
        "Manual price re-pull",
        "Repair > Providers > Re-pull prices from Tiingo: checks every holding against "
        "Tiingo once, skipping those that already have the newest price.",
    ),
)


def _naive_utc(now: datetime | None) -> datetime:
    now = now or datetime.now(UTC)
    return now.astimezone(UTC).replace(tzinfo=None) if now.tzinfo else now


def _iso(at: datetime | None) -> str | None:
    if at is None:
        return None
    return (at if at.tzinfo else at.replace(tzinfo=UTC)).isoformat()


def _next_hour(now: datetime) -> datetime:
    return now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)


def _next_eastern_midnight(now: datetime) -> datetime:
    local = now_eastern(now)
    midnight = datetime.combine(local.date() + timedelta(days=1), datetime.min.time())
    return midnight.replace(tzinfo=_EASTERN).astimezone(UTC).replace(tzinfo=None)


def usage(*, now: datetime | None = None) -> dict[str, Any]:
    """Token presence, caps, calls used and left, reset times and the last call."""
    from investment_dashboard.adapters import provider_status  # noqa: PLC0415
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.repositories import tiingo_state_repo  # noqa: PLC0415
    from investment_dashboard.services.prices_service import _resolve_tiingo_token  # noqa: PLC0415

    current = _naive_utc(now)
    with ledger_session_scope() as session:
        state = tiingo_state_repo.load(session, current)
    last = provider_status.get_status("tiingo")
    return {
        "configured": bool(_resolve_tiingo_token()),
        "hourly_cap": state.hourly_cap,
        "daily_cap": state.daily_cap,
        "hour_used": state.hour_used,
        "day_used": state.day_used,
        "remaining": state.budget().remaining(),
        "hour_resets_at": _iso(_next_hour(current)),
        "day_resets_at": _iso(_next_eastern_midnight(current)),
        "rate_limited_at": _iso(state.rate_limited_at),
        "nav_probes_today": state.canary_count_today,
        "last_status": None if last is None else last.status,
        "last_message": None if last is None else last.message,
        "last_at": None if last is None else _iso(last.at),
        "uses": [{"title": t, "detail": d} for t, d in USES],
    }


def reserve(calls: int, *, now: datetime | None = None) -> tuple[bool, int]:
    """Charge ``calls`` Tiingo requests up front if the budget covers all of them.

    Returns ``(granted, remaining_before)``. Nothing is charged when refused, so a
    job that needs 13 calls with 10 left stops cleanly instead of half-running.
    """
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.repositories import tiingo_state_repo  # noqa: PLC0415

    current = _naive_utc(now)
    with ledger_session_scope() as session:
        state = tiingo_state_repo.load(session, current)
        left = state.budget().remaining()
        if calls > left:
            return False, left
        tiingo_state_repo.record_spend(state, calls)
        tiingo_state_repo.save(session, state)
    return True, left
