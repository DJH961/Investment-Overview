"""In-process scheduler for the v6 server.

One asyncio loop; every job is blocking code run through ``asyncio.to_thread``.
Decisions use the New York exchange clock from :mod:`domain.market_hours`
(never ``date.today()``):

Stocks and currencies run on two separate clocks. While a market trades it is
polled at its interval from Settings; while it is closed nothing is fetched
unless data is actually missing (an outage, a restart):

* stocks (US market, ``is_us_market_open``): while open a ``tick`` every
  ``live_refresh_interval_seconds`` (default 60 s): a price refresh and an intraday
  sample (``auto_refresh.tick_refresh``, which also runs the Tiingo fallback inside
  ``prices_service``), then a ``tick`` event. While closed, ``eod`` once per
  settled session date (closes, splits, benchmark, snapshots, cache janitor; a
  ``refresh`` event). After that a price ``tick`` (no sample) runs only when
  ``prices_service`` reports an instrument still due (checked at most once a
  minute): a missing settled close, or a mutual-fund NAV not yet published (re-asked
  every ``prices.ttl_seconds.mutual_fund``, default 10 min). Once every close and
  NAV is in, nothing is fetched until the next session;
* currencies (24/5, ``is_forex_market_open``): the live EUR/USD spot (``fx`` event)
  every ``scheduler.fx_interval_minutes`` (default 1) while it trades, whatever the
  stock market does. Over the weekend only if no good reading exists since
  Friday's 17:00 close (retried every minute until one lands).

A tick or FX check that changed nothing (same prices, same rate, no new sample)
is published with ``unchanged: True``: clients still see the check, but the read
cache is kept (see ``read_cache.invalidate_for_event``).

Control (``/api/maintenance/scheduler``): :meth:`Scheduler.snapshot` reports the
state, :meth:`Scheduler.request_run` runs a job on the next loop pass (it also
wakes the loop), and :func:`set_pause` pauses jobs until a time that always
expires (default ``scheduler.pause_default_hours``). Pauses are kept in memory
and in ``app_config`` (:data:`PAUSE_KEY`) so a restart keeps them. While a heavy
maintenance job runs (``job_runner.heavy_busy``) market jobs wait.

Clock, sleep, jobs and bus are injectable for tests.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from investment_dashboard.activity_log import activity
from investment_dashboard.domain import market_hours
from investment_dashboard.services import live_bus, live_state, read_cache

log = logging.getLogger(__name__)

POLL_SECONDS = 5.0
#: Fallback when the ``scheduler.fx_interval_minutes`` setting cannot be read.
FX_INTERVAL = timedelta(minutes=1)
#: While a market is closed: how often to ask "is anything missing?" (and the
#: retry gap for a missing weekend FX reading).
MISSING_CHECK = timedelta(minutes=1)
#: Event fields that say whether a tick / FX check changed anything.
_CHANGE_KEYS = (
    "total_value_eur",
    "total_value_est_eur",
    "fx_eur_usd",
    "prices",
    "point",
    "estimates",
    "now_point",
)
JOB_NAMES: tuple[str, ...] = ("tick", "fx", "eod", "backup")
PAUSE_KEY = "scheduler.pause"
#: ``app_config`` key: the settled session date the last fully successful EOD
#: covered (B-004), so a restart while the market is closed does not re-run it.
EOD_SESSION_KEY = "scheduler.last_eod_session"
#: Key of the private payload a job returns to say which steps failed (B-005);
#: ``_run_job`` pops it before the event is published.
EOD_FAILED_STEPS = "_failed_steps"
#: Longest pause accepted (a pause always expires).
MAX_PAUSE = timedelta(days=7)
#: Minimum gap between backup attempts (also the retry delay after a failure).
BACKUP_RETRY = timedelta(minutes=1)

#: A job returns an extra payload merged into the published event (or ``None``).
Job = Callable[[], dict[str, Any] | None]
Clock = Callable[[], datetime]
Sleep = Callable[[float], Awaitable[None]]


def _event_ts(now: datetime) -> str:
    return now.astimezone(UTC).isoformat()


def _dec(value: Decimal | None) -> str | None:
    return None if value is None else format(value, "f")


def _live_fx() -> Decimal | None:
    from investment_dashboard.services import fx_service  # noqa: PLC0415

    spot = fx_service.active_live_spot("USD")
    return None if spot is None else spot.rate


def default_tick_job() -> dict[str, Any] | None:
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import auto_refresh, positions_service  # noqa: PLC0415

    auto_refresh.tick_refresh("Scheduled live refresh")
    rate = _live_fx()
    today = market_hours.exchange_today()
    # Outside the session a tick only checks prices: no intraday sample.
    session_open = market_hours.is_us_market_open()
    with ledger_session_scope() as session:
        positions = positions_service.compute_positions(session, as_of=today)
        total_eur = positions_service.total_portfolio_value(
            session, as_of=today, positions=positions
        )
        # Native USD total (USD holdings at their own amount), never ``total_eur * rate``.
        total_usd = positions_service.total_portfolio_value_usd(
            session, as_of=today, positions=positions
        )
        prices = _tick_prices(session, today)
        symbols, categories = _tick_day_moves(session, today, rate)
        if prices is not None:
            for key, day in symbols.items():
                if key in prices:
                    prices[key].update(day)
        point = _tick_point(session, total_eur, rate, total_usd=total_usd) if session_open else None
        estimated = _tick_estimates(session, total_eur, rate, total_usd=total_usd)
        now_point = _tick_now_point(session, rate)
    return {
        "now_point": now_point,
        "total_value_eur": _dec(total_eur),
        # Native USD (FX-free for USD holdings); not the EUR figure converted back.
        "total_value_usd": _dec(total_usd),
        "fx_eur_usd": _dec(rate),
        "prices": prices,
        "categories": categories or None,
        "point": point,
        **estimated,
        **_price_freshness(),
    }


_CENT = Decimal("0.01")


def _cent(value: Decimal | None) -> str | None:
    from decimal import ROUND_HALF_UP  # noqa: PLC0415

    return None if value is None else format(value.quantize(_CENT, rounding=ROUND_HALF_UP), "f")


_NO_SPLIT: dict[str, Any] = {
    f"day_{part}{pct}_{side}": None
    for part in ("session", "overnight")
    for pct in ("", "_pct")
    for side in ("eur", "usd")
}

_NO_DAY: dict[str, Any] = {
    "day_move_eur": None,
    "day_move_usd": None,
    "day_pct_eur": None,
    "day_pct_usd": None,
    **_NO_SPLIT,
}


def _tick_day_split(
    session: Any,
    *,
    now: datetime,
    shares: Decimal,
    native: str,
    legs: Any,
    rate_last: Decimal | None,
    rate_prev: Decimal | None,
    rate_live: Decimal | None = None,
) -> dict[str, Any]:
    """A holding's day / night cut of its day move for the tick.

    The same helpers as the holdings rows (:func:`domain.day_move.holding_day_split` /
    ``holding_open_day_split``), so a tick and the refetch agree. ``rate_last`` is the
    day figure's current-mark rate (live while open, the close rate once shut);
    ``rate_live`` the live rate for the night figure D. Null when the move is not on
    the last session, and per currency when the currency did not move.
    """
    from investment_dashboard.domain import day_move  # noqa: PLC0415
    from investment_dashboard.domain.market_hours import is_us_market_open  # noqa: PLC0415
    from investment_dashboard.services import intraday_snapshots_service  # noqa: PLC0415

    if legs.as_of != intraday_snapshots_service.last_session_date(now):
        return dict(_NO_SPLIT)
    if is_us_market_open(now):
        # Last night's overnight (previous close -> the open rate) + the session.
        rate_open = intraday_snapshots_service.day_open_rate(session, now=now)
        if rate_open is None or rate_open <= 0:
            return dict(_NO_SPLIT)
        split = day_move.holding_open_day_split(
            shares=shares,
            native_currency=native,
            legs=legs,
            rate_open=rate_open,
            rate_last=rate_last,
            rate_prev=rate_prev,
        )
    else:
        rate_close = intraday_snapshots_service.session_close_rate(session, legs.rate_date_last)
        if rate_close is None or rate_close <= 0:
            return dict(_NO_SPLIT)
        # Shut: the day figure is frozen at the close; night = D against the LIVE rate.
        split = day_move.holding_day_split(
            shares=shares,
            native_currency=native,
            legs=legs,
            rate_close=rate_close,
            rate_live=rate_live,
            rate_prev=rate_prev,
            rate_open=intraday_snapshots_service.day_open_rate(session, now=now),
        )
    return _split_fields(split)


def _split_fields(split: Any) -> dict[str, Any]:
    """The tick's ``day_session_*`` / ``day_overnight_*`` of one holding split.

    Null per currency when the currency did not move (nothing to explain), exactly
    as the holdings rows (``readmodels.holdings.day_split_fields``).
    """
    out = dict(_NO_SPLIT)
    if split is None:
        return out
    for side in ("eur", "usd"):
        overnight = getattr(split, f"overnight_{side}")
        session_part = getattr(split, f"session_{side}")
        if overnight is None or session_part is None or overnight == 0:
            continue
        out[f"day_session_{side}"] = _cent(session_part)
        out[f"day_overnight_{side}"] = _cent(overnight)
        out[f"day_session_pct_{side}"] = _dec(getattr(split, f"session_pct_{side}"))
        out[f"day_overnight_pct_{side}"] = _dec(getattr(split, f"overnight_pct_{side}"))
    return out


def _tick_estimated_splits(
    session: Any, symbols: dict[str, dict[str, Any]], *, now: datetime, rate: Decimal | None
) -> None:
    """While open, a pending fund's ☀/☾ in the tick describe its ETF-twin estimate.

    The same helper and rates as the holdings rows
    (``intraday_snapshots_service.estimate_day_split``), so a tick and a refetch
    agree. After the close nothing changes (official rule).
    """
    from investment_dashboard.domain.market_hours import is_us_market_open  # noqa: PLC0415
    from investment_dashboard.services import intraday_snapshots_service as iss  # noqa: PLC0415

    if not is_us_market_open(now):
        return
    estimates = iss.twin_estimates(session, now)
    if not estimates:
        return
    fx_prev = iss.previous_close_fx(session, iss.last_session_date(now))
    fx_day = iss.day_figure_fx(session, now=now, live_rate=rate)
    fx_open = iss.day_open_rate(session, now=now)
    for iid, est in estimates.items():
        row = symbols.get(str(iid))
        if row is None:
            continue
        split = iss.estimate_day_split(est, fx_now=fx_day, fx_prev_close=fx_prev, fx_open=fx_open)
        row.update(_split_fields(split))


def _tick_day_moves(
    session: Any, today: date, rate: Decimal | None, now: datetime | None = None
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    """Server day move per held instrument and per allocation category (F-081, F-029).

    The holdings rows' own definition (:mod:`domain.day_move`): today's share count
    at the two marks, so a buy is never that holding's gain (B-007); each mark at
    its own rate. The current mark uses the tick's rate ``rate`` while the session
    trades, and that session's close rate once it has shut (the day figure is frozen at
    the close, exactly as the holdings rows), so a tick and the refetch agree. A category's %
    is its summed move over its summed previous value. Money is rounded to the
    cent like the rows; % are fractions. Best effort: ``({}, {})`` on failure.
    """
    try:
        from investment_dashboard.domain import day_move  # noqa: PLC0415
        from investment_dashboard.domain.currency import (  # noqa: PLC0415
            lookup_rate_with_forward_fill,
        )
        from investment_dashboard.domain.money_market import is_money_market  # noqa: PLC0415
        from investment_dashboard.services import (  # noqa: PLC0415
            fx_service,
            intraday_snapshots_service,
            positions_service,
            prices_service,
            settings_service,
        )

        now = now or datetime.now(UTC)
        mm_extra = tuple(settings_service.get_or("portfolio.money_market_symbols", ()))
        shares: dict[int, Decimal] = {}
        native: dict[int, str] = {}
        category: dict[int, str] = {}
        money_market: set[int] = set()
        for pos in positions_service.compute_positions(session, as_of=today):
            if pos.current_price_native is None or pos.shares == 0:
                continue
            iid = pos.instrument.id
            shares[iid] = shares.get(iid, Decimal(0)) + pos.shares
            native.setdefault(iid, pos.account.native_currency)
            category.setdefault(iid, pos.category or "")
            eff = pos.effective
            if is_money_market(
                pos.instrument.symbol,
                asset_class=eff.asset_class if eff is not None else pos.instrument.asset_class,
                name=eff.name if eff is not None else pos.instrument.name,
                extra_symbols=mm_extra,
            ):
                money_market.add(iid)
        if not shares:
            return {}, {}
        recent = prices_service.recent_closes_by_instrument(
            session,
            list(shares),
            on_or_before=(
                today
                if intraday_snapshots_service.last_session_date(now)
                >= intraday_snapshots_service.previous_trading_session(today + timedelta(days=1))
                else intraday_snapshots_service.last_session_date(now)
            ),
            limit=2,
        )
        # Rolls over with the hero at the 09:30 ET open (not ET midnight).
        baseline_last = min(
            intraday_snapshots_service.previous_trading_session(today + timedelta(days=1)),
            intraday_snapshots_service.last_session_date(now),
        )
        baseline_prev = intraday_snapshots_service.previous_trading_session(baseline_last)
        eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
        rates: dict[tuple[date, bool], Decimal | None] = {}

        def _rate(on: date, now_leg: bool = False) -> Decimal | None:
            # Baseline leg: that session's close rate. Now leg: the live rate.
            if (on, now_leg) not in rates:
                live = rate if now_leg and rate is not None else None
                live = live or lookup_rate_with_forward_fill(eur_to_usd, on) or rate
                resolved = intraday_snapshots_service.daily_growth_leg_fx(
                    session, on, now=now, live_rate=live, now_leg=now_leg
                )
                rates[(on, now_leg)] = resolved if resolved is not None else rate
            return rates[(on, now_leg)]

        symbols: dict[str, dict[str, Any]] = {}
        members: dict[str, list[day_move.HoldingDayMove]] = {}
        for iid, qty in shares.items():
            legs = (
                None
                if iid in money_market
                else day_move.select_day_legs(
                    sorted(recent.get(iid, []), reverse=True),
                    latest_price_date=baseline_last,
                    previous_price_date=baseline_prev,
                )
            )
            if legs is None:
                symbols[str(iid)] = dict(_NO_DAY)
                continue
            move = day_move.holding_day_move(
                shares=qty,
                native_currency=native[iid],
                legs=legs,
                rate_last=_rate(legs.rate_date_last, True),
                rate_prev=_rate(legs.rate_date_prev),
            )
            symbols[str(iid)] = {
                "day_move_eur": _cent(move.move_eur),
                "day_move_usd": _cent(move.move_usd),
                "day_pct_eur": _dec(move.pct_eur),
                "day_pct_usd": _dec(move.pct_usd),
                **_tick_day_split(
                    session,
                    now=now,
                    shares=qty,
                    native=native[iid],
                    legs=legs,
                    rate_last=_rate(legs.rate_date_last, True),
                    rate_prev=_rate(legs.rate_date_prev),
                    rate_live=rate if rate is not None else _rate(legs.rate_date_last, True),
                ),
            }
            members.setdefault(category[iid], []).append(move)
        _tick_estimated_splits(session, symbols, now=now, rate=rate)
        categories: dict[str, dict[str, Any]] = {}
        for name, group in members.items():
            moves_eur = [m.move_eur for m in group if m.move_eur is not None]
            moves_usd = [m.move_usd for m in group if m.move_usd is not None]
            categories[name] = {
                "day_move_eur": _cent(sum(moves_eur, start=Decimal(0))) if moves_eur else None,
                "day_move_usd": _cent(sum(moves_usd, start=Decimal(0))) if moves_usd else None,
                "day_pct_eur": _dec(
                    day_move.group_day_pct((m.move_eur, m.prev_eur) for m in group)
                ),
                "day_pct_usd": _dec(
                    day_move.group_day_pct((m.move_usd, m.prev_usd) for m in group)
                ),
            }
        return symbols, categories
    except Exception:
        log.warning("tick day moves unavailable", exc_info=True)
        return {}, {}


def _tick_prices(session: Any, today: date, now: datetime | None = None) -> dict[str, Any] | None:
    """Latest native price + previous close per held instrument (best effort)."""
    try:
        from investment_dashboard.services import (  # noqa: PLC0415
            intraday_snapshots_service,
            positions_service,
            prices_service,
        )

        latest: dict[int, tuple[Decimal, str]] = {}
        fund_ids: set[int] = set()
        for pos in positions_service.compute_positions(session, as_of=today):
            price = pos.current_price_native
            if price is not None and pos.shares != 0:
                latest[pos.instrument.id] = (price, pos.instrument.native_currency)
                if intraday_snapshots_service.is_drifting_nav(pos):
                    fund_ids.add(pos.instrument.id)
        recent = prices_service.recent_closes_by_instrument(
            session, list(latest), on_or_before=today, limit=3
        )
        session_date = intraday_snapshots_service.last_session_date(now)
        out: dict[str, Any] = {}
        for iid, (price, ccy) in latest.items():
            closes = sorted(recent.get(iid, []), reverse=True)
            prev = [c for d, c in closes if d < today]
            # A mutual fund whose NAV for the last session has not posted: its price is
            # the previous NAV, so "previous close" would equal the price and a client
            # would zero its day move. Flag it and send no previous close instead.
            stale = iid in fund_ids and bool(closes) and closes[0][0] < session_date
            out[str(iid)] = {
                "px": format(price, "f"),
                "ccy": ccy,
                "prev_close": None if stale else (format(prev[0], "f") if prev else None),
                "stale_nav": stale,
            }
        return out
    except Exception:
        log.warning("tick prices unavailable", exc_info=True)
        return None


def _tick_estimates(
    session: Any,
    total_eur: Decimal,
    rate: Decimal | None,
    now: datetime | None = None,
    *,
    total_usd: Decimal | None = None,
) -> dict[str, Any]:
    """The estimated total and per-fund estimates of this tick (all ``None`` when none).

    Official ``total_eur`` plus ``sum(shares x (est_px - prev_nav))`` of the pending
    mutual funds at the rate now: the same figure as the overview's
    ``kpis.estimate.total_value`` and the 1D line's last point.
    """
    empty: dict[str, Any] = {
        "total_value_est_eur": None,
        "total_value_est_usd": None,
        "estimates": None,
    }
    try:
        from investment_dashboard.services import intraday_snapshots_service as iss  # noqa: PLC0415

        now = now or datetime.now(UTC)
        estimates = iss.twin_estimates(session, now)
        if not estimates:
            return empty
        fx_prev = iss.previous_close_fx(session, iss.last_session_date(now))
        per_fund: dict[str, Any] = {}
        # The day % freezes at the close rate once the market has shut (day rule).
        rate_day = iss.day_figure_fx(session, now=now, live_rate=rate)
        for iid, est in estimates.items():
            pct = iss.estimate_move_pct(est, rate_day, fx_prev)
            per_fund[str(iid)] = {
                "est_px": _dec(est.est_px),
                "prev_nav": _dec(est.prev_nav),
                "pct": {"EUR": _dec(pct["EUR"]), "USD": _dec(pct["USD"])},
                "at": est.at.isoformat(),
            }
        adjustment = iss.estimate_adjustment(estimates.values(), rate)
        total_est = total_eur + adjustment[0] if adjustment[0] is not None else None
        return {
            "total_value_est_eur": _dec(total_est),
            # Native USD total plus the (FX-free) USD estimate adjustment.
            "total_value_est_usd": (
                _dec(total_usd + adjustment[1])
                if total_usd is not None and adjustment[1] is not None
                else None
            ),
            "estimates": per_fund,
        }
    except Exception:
        log.warning("tick estimates unavailable", exc_info=True)
        return empty


def _tick_point(
    session: Any,
    total_eur: Decimal,
    rate: Decimal | None,
    *,
    total_usd: Decimal | None = None,
) -> dict[str, Any] | None:
    """The intraday sample this tick just stored, as a graph point (or ``None``).

    ``USD`` is the native USD total (plus the FX-free late-NAV adjustment); ``EUR`` is
    that USD value divided by the sample's own stored FX (single instant).
    """
    try:
        from investment_dashboard.services import (  # noqa: PLC0415
            intraday_snapshots_service,
            live_state,
        )

        series = intraday_snapshots_service.day_series_with_fx(session)
        if not series:
            return None
        at, _market, fx = series[-1]
        t = at.replace(tzinfo=UTC).isoformat()
        if t == live_state.last_point_t():
            return None  # no new sample this tick (market closed / dedupe floor)
        fx = fx or rate
        # The 1D line draws mutual funds on their late-NAV line (ETF estimate until
        # the NAV posts); the point must sit on that line, not on the official total.
        adj_eur, adj_usd = intraday_snapshots_service.live_point_adjustment(session, at=at, fx=fx)
        total_eur = total_eur + (adj_eur or Decimal(0))
        usd = total_usd + adj_usd if total_usd is not None and adj_usd is not None else None
        if fx is None or fx == 0 or usd is None:
            return {"t": t, "EUR": _dec(total_eur), "USD": _dec(usd)}
        return {"t": t, "EUR": _dec(usd / fx), "USD": _dec(usd)}
    except Exception:
        log.warning("tick point unavailable", exc_info=True)
        return None


def _tick_now_point(
    session: Any, rate: Decimal | None, now: datetime | None = None
) -> dict[str, Any] | None:
    """The graphs' ``now_point`` of this tick, per currency (``None`` while the market is open).

    The live value after the close with its overnight currency effect and that effect as
    a fraction of the previous-close baseline, both server-computed (the day-move rule,
    :func:`metrics_service.last_session_split`), so the client only patches them in.
    """
    try:
        from investment_dashboard.services import metrics_service  # noqa: PLC0415

        now = now or datetime.now(UTC)
        if market_hours.is_us_market_open(now):
            return None
        split = metrics_service.last_session_split(session, now=now, fx_now=rate)
        if split is None:
            return None
        return {
            "EUR": {
                "v": _dec(split.value_now_eur),
                "overnight_currency": _dec(split.overnight_eur),
                "overnight_pct": _dec(split.overnight_pct_eur),
            },
            "USD": {
                "v": _dec(split.value_now_usd),
                "overnight_currency": _dec(split.overnight_usd),
                "overnight_pct": _dec(split.overnight_pct_usd),
            },
        }
    except Exception:
        log.warning("tick now point unavailable", exc_info=True)
        return None


def _price_freshness(now: datetime | None = None) -> dict[str, Any]:
    """``last_update_at`` + ``prices_live`` for the tick event (Live vs Updated chip)."""
    from investment_dashboard.services import feed_stall_service, refresh_status  # noqa: PLC0415

    now = now or datetime.now(UTC)
    snap = refresh_status.snapshot()
    last = snap.last_update_at
    market_at = feed_stall_service.newest_market_time()
    return {
        "last_update_at": last.isoformat() if last is not None else None,
        "price_market_at": market_at.isoformat() if market_at is not None else None,
        "prices_live": market_hours.is_live_now(
            market_open=market_hours.is_us_market_open(now),
            last_update_at=snap.last_price_update_at,
            now=now,
            price_market_at=market_at,
            feed_stalled=feed_stall_service.is_stalled(),
            window_seconds=feed_stall_service.live_max_age_seconds(),
            quote_max_age_seconds=feed_stall_service.live_max_age_seconds(),
        ),
    }


def default_fx_job() -> dict[str, Any] | None:
    from investment_dashboard.services import fx_service, refresh_status  # noqa: PLC0415

    rate = fx_service.refresh_live_spot()
    if rate is None and fx_service.active_live_spot("USD") is None:
        rate = fx_service.backfill_live_spot()
    if rate is not None:
        # A fresh rate landed: the hero / top bar "Updated ..." stamp moves too.
        refresh_status.mark_fx_updated()
    last = refresh_status.snapshot().last_update_at
    return {
        "fx_eur_usd": _dec(_live_fx()),
        "last_update_at": last.isoformat() if last is not None else None,
    }


#: ``refresh_status`` source while the end-of-day job settles the closes; a manual
#: refresh then answers 409 "settling_close" instead of racing its writes.
EOD_SOURCE = "eod"


def default_eod_job() -> dict[str, Any] | None:
    from investment_dashboard.services import refresh_status  # noqa: PLC0415

    refresh_status.begin(EOD_SOURCE)
    try:
        return _eod_steps()
    finally:
        refresh_status.finish(EOD_SOURCE, updated=True)


def default_eod_grace() -> timedelta:
    from investment_dashboard.config import get_settings  # noqa: PLC0415

    return timedelta(seconds=max(0, get_settings().eod_grace_seconds))


def default_close_repull_delay() -> timedelta | None:
    from investment_dashboard.config import get_settings  # noqa: PLC0415

    minutes = get_settings().close_repull_minutes
    return timedelta(minutes=minutes) if minutes > 0 else None


def default_close_repull_job() -> bool:
    """One quiet re-pull of the day's closes a few minutes after the bell."""
    from investment_dashboard import boot  # noqa: PLC0415

    return boot._refresh_prices() is not False


def _eod_steps() -> dict[str, Any] | None:
    from investment_dashboard import boot  # noqa: PLC0415

    failed: list[str] = []
    for step in (
        # Live spot first: this job also stamps ``last_fx``, so the live EUR/USD
        # must really be fetched here (a restart otherwise sat on the ECB
        # end-of-day rate until the next FX run).
        boot._refresh_live_fx,
        boot._refresh_fx,
        boot._refresh_prices,
        boot._refresh_splits,
        boot._refresh_benchmark,
        boot._refresh_intraday_day,
        # Recurring-plan est. rows (7.3): after prices + FX settled, before the warm-up.
        boot._generate_recurring_estimates,
        boot._warm_snapshots,
        boot._run_cache_janitor,
    ):
        # Each step catches and logs its own failure and returns ok/failed (B-005);
        # a step that returns nothing counts as ok.
        if step() is False:
            failed.append(step.__name__)
    return {EOD_FAILED_STEPS: failed} if failed else None


#: ``app_config`` key: the last New York date the "settle yesterday" step settled.
SETTLE_KEY = "scheduler.last_settled_day"
#: Gap before a failed settle step is tried again.
SETTLE_RETRY = timedelta(minutes=5)


def default_settle_job(today: date) -> bool:
    """Settle the just-finished New York day (``today - 1``): ``True`` when it ran.

    While a day is "today" its stored snapshot is valued at the live rate overlay.
    The first run after the New York date rolls over force-recomputes ONLY that day,
    so it is valued at its own ECB / settled rate (and its native USD total is stored
    natively), whatever the weekday. The settled date is persisted in ``app_config``
    so a restart neither repeats nor skips it; the evening 7-day pass stays as is.
    ``False`` (no-op) when that day was already settled.
    """
    from investment_dashboard.db import (  # noqa: PLC0415
        config_session_scope,
        ledger_session_scope,
    )
    from investment_dashboard.services import app_config_service, snapshots_service  # noqa: PLC0415

    day = today - timedelta(days=1)
    with config_session_scope() as cfg:
        if app_config_service.get(cfg, SETTLE_KEY) == day.isoformat():
            return False
    with ledger_session_scope() as session:
        snapshots_service.warm_range(session, day, day, force=True)
    # The recomputed row is committed above; only then is the day marked settled.
    with config_session_scope() as cfg:
        cfg.info["skip_backup_dirty"] = True  # bookkeeping, not durable data
        app_config_service.set_value(cfg, SETTLE_KEY, day.isoformat())
    activity("market_data").info("settled yesterday's snapshot (%s) at its own rate", day)
    return True


def default_backup_job() -> dict[str, Any] | None:
    from investment_dashboard.services import backup_service  # noqa: PLC0415

    return backup_service.run_scheduled()


def default_backup_due(now: datetime) -> bool:
    from investment_dashboard.services import backup_service  # noqa: PLC0415

    return backup_service.is_due(now)


def default_interval() -> int:
    from investment_dashboard.db import config_session_scope  # noqa: PLC0415
    from investment_dashboard.services import auto_refresh  # noqa: PLC0415

    with config_session_scope() as session:
        return auto_refresh.get_interval_seconds(session)


def default_fx_interval() -> timedelta:
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    minutes = settings_service.get_or("scheduler.fx_interval_minutes", None)
    return FX_INTERVAL if minutes is None else timedelta(minutes=int(minutes))


def default_prices_due() -> bool:
    """Whether any instrument still needs a pull (missing close / NAV, TTL passed)."""
    from investment_dashboard.db import cache_session_scope, ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import prices_service  # noqa: PLC0415

    with ledger_session_scope() as ledger, cache_session_scope() as cache:
        return bool(prices_service.instruments_due_for_refresh(ledger, cache))


def default_heavy_busy() -> str | None:
    from investment_dashboard.services import job_runner  # noqa: PLC0415

    return job_runner.heavy_busy()


# -- pauses ------------------------------------------------------------------------

_pause_lock = threading.Lock()
_pauses: dict[str, datetime] = {}
_pause_state = {"loaded": False}


def _load_pauses() -> None:
    if _pause_state["loaded"]:
        return
    _pause_state["loaded"] = True
    try:
        from investment_dashboard.db import config_session_scope  # noqa: PLC0415
        from investment_dashboard.services import app_config_service  # noqa: PLC0415

        with config_session_scope() as cfg:
            raw = app_config_service.get(cfg, PAUSE_KEY)
        for name, until in (json.loads(raw) if raw else {}).items():
            if name in JOB_NAMES:
                _pauses[name] = datetime.fromisoformat(until)
    except Exception:
        log.debug("could not load scheduler pauses", exc_info=True)


def _save_pauses() -> None:
    try:
        from investment_dashboard.db import config_session_scope  # noqa: PLC0415
        from investment_dashboard.services import app_config_service  # noqa: PLC0415

        payload = {k: v.isoformat() for k, v in _pauses.items()}
        with config_session_scope() as cfg:
            app_config_service.set_value(cfg, PAUSE_KEY, json.dumps(payload) if payload else None)
    except Exception:
        log.warning("could not persist scheduler pauses", exc_info=True)


def paused(now: datetime) -> dict[str, datetime]:
    """Jobs paused at ``now`` -> until when (expired pauses are dropped)."""
    with _pause_lock:
        _load_pauses()
        expired = [k for k, until in _pauses.items() if until <= now]
        for k in expired:
            del _pauses[k]
        if expired:
            _save_pauses()
        return dict(_pauses)


def set_pause(
    jobs: list[str], *, until: datetime | None, now: datetime | None = None
) -> dict[str, datetime]:
    """Pause ``jobs`` until ``until`` (``None`` resumes them). Returns all pauses."""
    now = now or datetime.now(UTC)
    unknown = [j for j in jobs if j not in JOB_NAMES]
    if unknown:
        raise ValueError(f"unknown scheduler job(s): {', '.join(unknown)}")
    if until is not None and not (now < until <= now + MAX_PAUSE):
        raise ValueError("a pause must end in the future and within 7 days")
    with _pause_lock:
        _load_pauses()
        for job in jobs:
            if until is None:
                _pauses.pop(job, None)
            else:
                _pauses[job] = until
        _save_pauses()
    activity("market_data").info(
        "scheduler %s: %s", "resumed" if until is None else f"paused until {until}", jobs
    )
    return paused(now)


def reset_pauses_for_tests() -> None:
    with _pause_lock:
        _pauses.clear()
        _pause_state["loaded"] = True


@dataclass
class Jobs:
    tick: Job = default_tick_job
    fx: Job = default_fx_job
    eod: Job = default_eod_job
    #: Settle yesterday's stored snapshot after the New York date rolls over.
    settle: Callable[[date], bool] = default_settle_job
    #: Sealed database snapshot (independent of market state, no live event).
    backup: Job = default_backup_job
    backup_due: Callable[[datetime], bool] = default_backup_due
    interval_seconds: Callable[[], int] = default_interval
    fx_interval: Callable[[], timedelta] = default_fx_interval
    #: While the US market is closed: does any instrument still need a pull?
    prices_due: Callable[[], bool] = default_prices_due
    #: Name of a running heavy maintenance job (market jobs wait), or ``None``.
    heavy_busy: Callable[[], str | None] = default_heavy_busy
    #: How long after the bell the end-of-day job waits (the "closing" state).
    eod_grace: Callable[[], timedelta] = default_eod_grace
    #: When after the bell the closes are pulled once more (``None`` = never).
    close_repull_delay: Callable[[], timedelta | None] = default_close_repull_delay
    close_repull: Callable[[], bool] = default_close_repull_job


@dataclass
class State:
    last_tick: datetime | None = None
    last_fx: datetime | None = None
    #: Last FX run that did not fail (a weekend reading must be a good one).
    last_fx_ok: datetime | None = None
    #: Last "is anything missing?" check while the US market was closed.
    last_due_check: datetime | None = None
    last_eod_session: date | None = None
    #: Whether ``last_eod_session`` was read from ``app_config`` yet (B-004).
    eod_session_loaded: bool = False
    last_backup: datetime | None = None
    #: The New York date whose "settle yesterday" step is done / its last attempt.
    settle_done_for: date | None = None
    last_settle_try: datetime | None = None
    running: set[str] = field(default_factory=set)
    requested: set[str] = field(default_factory=set)
    last_runs: dict[str, datetime] = field(default_factory=dict)
    last_failed: dict[str, bool] = field(default_factory=dict)
    #: What the last published tick / fx event carried (change detection).
    last_payload: dict[str, Any] = field(default_factory=dict)
    #: The last published ``market_session`` state (opening/open/closing/closed).
    session_state: str | None = None
    #: The session date whose closes were re-pulled after the bell.
    repull_done_for: date | None = None


class Scheduler:
    def __init__(
        self,
        *,
        jobs: Jobs | None = None,
        clock: Clock | None = None,
        sleep: Sleep | None = None,
        bus: live_bus.LiveBus | None = None,
        poll_seconds: float = POLL_SECONDS,
    ) -> None:
        self.jobs = jobs or Jobs()
        self.clock: Clock = clock or (lambda: datetime.now(UTC))
        self.sleep: Sleep = sleep or asyncio.sleep
        self.bus = bus or live_bus.bus
        self.poll_seconds = poll_seconds
        self.state = State()
        self._wake: asyncio.Event | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    # -- control -----------------------------------------------------------

    def request_run(self, name: str) -> None:
        """Run ``name`` on the next pass (even when not due or paused); thread-safe."""
        if name not in JOB_NAMES:
            raise ValueError(f"unknown scheduler job {name!r}")
        self.state.requested.add(name)
        loop, wake = self._loop, self._wake
        if loop is not None and wake is not None:
            loop.call_soon_threadsafe(wake.set)

    def snapshot(self) -> dict[str, Any]:
        """JSON-safe state for the Health & Repair page."""
        now = self.clock()
        st = self.state

        def iso(value: datetime | None) -> str | None:
            return None if value is None else value.astimezone(UTC).isoformat()

        pauses = paused(now)
        return {
            "enabled": True,
            "now": iso(now),
            "market_state": live_bus.market_state(now),
            "jobs": [
                {
                    "name": name,
                    "running": name in st.running,
                    "requested": name in st.requested,
                    "last_run_at": iso(st.last_runs.get(name)),
                    "last_failed": st.last_failed.get(name, False),
                    "paused_until": iso(pauses.get(name)),
                }
                for name in JOB_NAMES
            ],
            "last_eod_session": (st.last_eod_session.isoformat() if st.last_eod_session else None),
            "heavy_job": self.jobs.heavy_busy(),
        }

    # -- decisions ---------------------------------------------------------

    def due(self, now: datetime, interval_seconds: int = 60) -> list[str]:
        """Names of the jobs that should run at ``now``."""
        names = self._due_market(now, interval_seconds)
        st = self.state
        if st.last_backup is None or now - st.last_backup >= BACKUP_RETRY:
            try:
                if self.jobs.backup_due(now):
                    names.append("backup")
            except Exception:
                log.warning("backup due-check failed", exc_info=True)
        return names

    def _load_eod_session(self) -> None:
        """Read the persisted ``last_eod_session`` once (B-004); never raises."""
        st = self.state
        if st.eod_session_loaded:
            return
        st.eod_session_loaded = True
        if st.last_eod_session is not None:
            return
        try:
            from investment_dashboard.db import config_session_scope  # noqa: PLC0415
            from investment_dashboard.services import app_config_service  # noqa: PLC0415

            with config_session_scope() as cfg:
                raw = app_config_service.get(cfg, EOD_SESSION_KEY)
            if raw:
                st.last_eod_session = date.fromisoformat(raw)
        except Exception:
            log.debug("could not load last_eod_session", exc_info=True)

    def _save_eod_session(self, session_date: date) -> None:
        """Persist the settled session the EOD covered (blocking; call off-loop)."""
        try:
            from investment_dashboard.db import config_session_scope  # noqa: PLC0415
            from investment_dashboard.services import app_config_service  # noqa: PLC0415

            with config_session_scope() as cfg:
                cfg.info["skip_backup_dirty"] = True  # bookkeeping, not durable data
                app_config_service.set_value(cfg, EOD_SESSION_KEY, session_date.isoformat())
        except Exception:
            log.warning("could not persist last_eod_session", exc_info=True)

    def _due_market(self, now: datetime, interval_seconds: int) -> list[str]:
        stocks = self._due_stocks(now, interval_seconds)
        if stocks == ["eod"]:
            return stocks  # eod refreshes the FX rate as well
        return [*stocks, *self._due_fx(now)]

    def _due_stocks(self, now: datetime, interval_seconds: int) -> list[str]:
        """The stock clock: live interval while the US market is open, else eod + closed."""
        st = self.state
        if market_hours.is_us_market_open(now):
            every = timedelta(seconds=interval_seconds)
            return ["tick"] if st.last_tick is None or now - st.last_tick >= every else []
        self._load_eod_session()
        if st.last_eod_session != market_hours.latest_settled_session_date(now):
            if self._in_close_grace(now):
                return []  # "closing": the official closes are still coming in
            return ["eod"]
        # Closed and the day's eod is done: pull only what is still missing.
        if st.last_due_check is not None and now - st.last_due_check < MISSING_CHECK:
            return []
        st.last_due_check = now
        try:
            missing = self.jobs.prices_due()
        except Exception:
            log.warning("could not check for missing prices", exc_info=True)
            return []
        return ["tick"] if missing else []

    def _bell(self, now: datetime) -> datetime | None:
        """Today's closing bell (UTC) when today traded and it has rung, else ``None``."""
        day = market_hours.exchange_today(now)
        if not market_hours.is_trading_day(day):
            return None
        bell = datetime.combine(day, market_hours.session_close(day), market_hours.MARKET_TZ)
        return bell if now >= bell else None

    def _in_close_grace(self, now: datetime) -> bool:
        bell = self._bell(now)
        if bell is None:
            return False
        try:
            grace = self.jobs.eod_grace()
        except Exception:
            grace = timedelta(seconds=60)
        return now < bell + grace

    def session_state(self, now: datetime) -> str:
        """``opening`` / ``open`` / ``closing`` / ``closed`` for the clients' bell moments."""
        st = self.state
        if market_hours.is_us_market_open(now):
            day = market_hours.exchange_today(now)
            ticked = st.last_tick is not None and market_hours.exchange_today(st.last_tick) == day
            return "open" if ticked and not st.last_failed.get("tick") else "opening"
        self._load_eod_session()
        settled = market_hours.latest_settled_session_date(now)
        if self._bell(now) is not None and st.last_eod_session != settled:
            return "closing"
        return "closed"

    def _publish_session(self, now: datetime) -> None:
        """Announce a bell moment once per change; drop cached reads at each bell."""
        state = self.session_state(now)
        st = self.state
        if state == st.session_state:
            return
        first = st.session_state is None
        st.session_state = state
        if not first and state in ("opening", "closing"):
            # A read cached a minute before the bell still says "live" / "closed".
            read_cache.invalidate()
        self.bus.publish(
            {
                "type": "market_session",
                "ts": _event_ts(self.clock()),
                "state": state,
                "prices_live": state == "open",
                "at": now.astimezone(UTC).isoformat(),
                "market_state": live_bus.market_state(now),
            }
        )

    async def repull_step(self) -> bool:
        """A few minutes after the bell, pull the day's closes once more, quietly.

        The first pull at the bell can still hold a pre-auction bar; this one never
        blocks anything and only publishes a ``refresh`` when it ran.
        """
        st = self.state
        now = self.clock()
        bell = self._bell(now)
        if bell is None or market_hours.is_us_market_open(now):
            return False
        day = market_hours.exchange_today(now)
        if st.repull_done_for == day or st.last_eod_session != day:
            return False
        try:
            delay = self.jobs.close_repull_delay()
        except Exception:
            delay = None
        if delay is None or now < bell + delay or self.jobs.heavy_busy() is not None:
            return False
        st.repull_done_for = day
        try:
            ok = await asyncio.to_thread(self.jobs.close_repull)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("close re-pull failed", exc_info=True)
            return False
        activity("market_data").info("closing prices re-pulled (ok=%s)", ok)
        self.bus.publish(
            {
                "type": "refresh",
                "ts": _event_ts(self.clock()),
                "market_state": live_bus.market_state(now),
                "reason": "closing prices re-pulled",
            }
        )
        return True

    def _due_fx(self, now: datetime) -> list[str]:
        """The currency clock (24/5), independent of the stock market."""
        st = self.state
        if market_hours.is_forex_market_open(now):
            try:
                every = self.jobs.fx_interval()
            except Exception:
                every = FX_INTERVAL
            return ["fx"] if st.last_fx is None or now - st.last_fx >= every else []
        # Weekend: the rate is frozen at Friday's close. Fetch only if no good
        # reading exists since then (retry every minute until one lands).
        closed_at = market_hours.last_forex_close(now)
        if st.last_fx_ok is not None and st.last_fx_ok >= closed_at:
            return []
        return ["fx"] if st.last_fx is None or now - st.last_fx >= MISSING_CHECK else []

    def _unchanged(self, etype: str, extra: dict[str, Any] | None) -> bool:
        """True when a tick / fx check carries exactly what the last one did."""
        if etype not in ("tick", "fx") or not extra or extra.get("point") is not None:
            return False
        payload = {k: extra.get(k) for k in _CHANGE_KEYS}
        before = self.state.last_payload.get(etype)
        self.state.last_payload[etype] = payload
        return before == payload

    # -- execution ---------------------------------------------------------

    def _stamp(self, name: str, now: datetime, *, failed: bool = False) -> None:
        """Record when each clock last ran (stocks: tick/eod, currencies: fx/eod)."""
        st = self.state
        if name == "tick":
            st.last_tick = now
        elif name == "fx":
            st.last_fx = now
            if not failed:
                st.last_fx_ok = now
        elif name == "eod":
            # It pulled the closes and the live spot: both clocks start over.
            st.last_eod_session = market_hours.latest_settled_session_date(now)
            st.last_fx = now
            if not failed:
                st.last_fx_ok = now
            st.last_tick = now
        elif name == "backup":
            st.last_backup = now

    async def _run_job(self, name: str, now: datetime) -> None:
        st = self.state
        if name in st.running:  # a job never overlaps itself
            return
        st.running.add(name)
        try:
            failed = False
            failed_steps = False
            extra: dict[str, Any] | None = None
            started = time.perf_counter()
            subject = activity("backups" if name == "backup" else "market_data")
            try:
                extra = await asyncio.to_thread(getattr(self.jobs, name))
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("scheduler job %s failed", name, exc_info=True)
                subject.warning("job %s FAILED after %.1fs", name, time.perf_counter() - started)
                failed = True
            else:
                steps_failed: list[str] = (extra or {}).pop(EOD_FAILED_STEPS, None) or []
                if steps_failed:
                    subject.warning(
                        "job %s finished with failed step(s): %s", name, ", ".join(steps_failed)
                    )
                    failed_steps = True
                else:
                    subject.info("job %s done in %.1fs", name, time.perf_counter() - started)
            # Mark done even on failure so a broken job retries at its normal
            # cadence instead of spinning every poll.
            st.last_runs[name] = now
            st.last_failed[name] = failed or failed_steps
            self._stamp(name, now, failed=failed)
            if name == "eod" and not (failed or failed_steps):
                # A fully successful EOD survives a restart (B-004); a failed one
                # is retried by the next boot.
                await asyncio.to_thread(
                    self._save_eod_session, market_hours.latest_settled_session_date(now)
                )
            if failed or name == "backup":
                return
            etype = {"tick": "tick", "fx": "fx", "eod": "refresh"}[name]
            event: live_bus.Event = {
                "type": etype,
                "ts": _event_ts(self.clock()),
                "market_state": live_bus.market_state(now),
            }
            event.update(extra or {})
            unchanged = self._unchanged(etype, extra)
            if unchanged:
                event["unchanged"] = True
            if etype == "tick":
                live_state.record_tick(event, day=market_hours.exchange_today(now))
            self.bus.publish(event)
            if etype in ("tick", "fx") and not unchanged and self.bus.subscriber_count > 0:
                # Pre-compute the reads the clients refetch right after a tick (in the
                # background: the tick job is already done).
                with contextlib.suppress(Exception):
                    threading.Thread(
                        target=read_cache.warm, name="inv-dashboard-cache-warm", daemon=True
                    ).start()
        finally:
            st.running.discard(name)

    async def step(self) -> list[str]:
        """Evaluate once and run whatever is due. Returns the job names run."""
        now = self.clock()
        interval = 60
        if market_hours.is_us_market_open(now):
            try:
                interval = await asyncio.to_thread(self.jobs.interval_seconds)
            except Exception:
                log.warning("could not read refresh interval; using 60 s", exc_info=True)
        # The "anything missing?" check and the pause load open database
        # sessions: keep them off the event loop (B-019).
        due = await asyncio.to_thread(self.due, now, interval)
        pauses = await asyncio.to_thread(paused, now)
        due = [n for n in due if n not in pauses]
        heavy = self.jobs.heavy_busy()
        if heavy is not None:
            # A heavy maintenance job owns the data; backups still run.
            due = [n for n in due if n == "backup"]
        requested = [n for n in JOB_NAMES if n in self.state.requested]
        self.state.requested.difference_update(requested)
        ran = [*due, *(n for n in requested if n not in due)]
        for name in ran:
            await self._run_job(name, now)
        try:
            await asyncio.to_thread(self._publish_session, now)
        except Exception:
            log.debug("market session event failed", exc_info=True)
        return ran

    async def settle_step(self) -> bool:
        """After the New York date rolls over, settle yesterday's snapshot once.

        Separate from :meth:`step` (not a market job): runs on the first pass of a
        new New York date, whatever the weekday, then not again that date. A failure
        is retried after :data:`SETTLE_RETRY`. Publishes a ``refresh`` event once the
        recomputed day is committed. Returns whether it settled a day.
        """
        st = self.state
        now = self.clock()
        today = market_hours.exchange_today(now)
        if st.settle_done_for == today:
            return False
        if st.last_settle_try is not None and now - st.last_settle_try < SETTLE_RETRY:
            return False
        if self.jobs.heavy_busy() is not None:
            return False
        st.last_settle_try = now
        try:
            settled = await asyncio.to_thread(self.jobs.settle, today)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("settle yesterday failed", exc_info=True)
            activity("market_data").warning("settle yesterday FAILED; retrying in 5 min")
            return False
        st.settle_done_for = today
        if settled:
            self.bus.publish(
                {
                    "type": "refresh",
                    "ts": _event_ts(self.clock()),
                    "market_state": live_bus.market_state(now),
                    "reason": "settled yesterday",
                }
            )
        return settled

    async def _pause_between_steps(self) -> None:
        if self.sleep is not asyncio.sleep:
            await self.sleep(self.poll_seconds)
            return
        wake = self._wake
        assert wake is not None
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(wake.wait(), self.poll_seconds)
        wake.clear()

    async def run(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        while True:
            try:
                await self.step()
                await self.settle_step()
                await self.repull_step()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("scheduler step failed")
            await self._pause_between_steps()
