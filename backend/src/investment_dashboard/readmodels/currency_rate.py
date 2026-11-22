"""EUR/USD rate history for the Currency page chart (v7.2, ``GET /currency/rate-history``).

Rates are USD per 1 EUR (``rate``); ``inverse`` = 1 / rate (EUR per 1 USD, the
dollar's terms), computed here to 6 dp. The payload is the same for both
reporting currencies (it is a market rate, not a portfolio figure).

* ``1d`` / ``1w``: 15-minute forex bars (Yahoo ``EURUSD=X``, cached ~10 min, see
  ``fx_service.eur_usd_forex_bars``) merged with the stored intraday samples
  (``IntradayValue.fx_eur_usd``), ``granularity = "intraday"``,
  ``source = "live samples"``. ``1d`` is the current forex day (17:00 ET to 17:00 ET;
  over the weekend Friday's); ``1w`` the last 5 forex days and ``sessions`` lists
  them (UTC) so the chart squeezes the weekend out. Bars failing -> stored samples.
* ``all``: from the first ledger transaction to today (``max`` when the ledger is
  empty); weekly when longer than 3 years, MA200 when at least a year.
* ``1m`` .. ``5y``: the **settled** daily ECB rows (``fx_history``), never the live
  overlay on a past day; the last point may be today's live spot (``as_of`` then
  carries its instant). ``10y`` / ``max``: the last ECB day of each ISO week.
* ``ma200`` (ranges >= 1y, daily/weekly): computed on the FULL daily history, so it
  starts at the range start; ``rate`` is the MA of the rate and ``inverse`` the MA
  of the inverse (the one :mod:`domain.fx_trend` compares the dollar against).
* ``trend`` / ``percentiles``: always from the full daily history, whatever the range.
"""

from __future__ import annotations

import bisect
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import fx_trend, market_hours
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import (
    fx_conversion_service,
    fx_service,
    intraday_snapshots_service,
)

RANGES: tuple[str, ...] = ("1d", "1w", "1m", "3m", "ytd", "1y", "all", "5y", "10y", "max")
#: A stored sample joins the forex bars only this far (seconds) from the nearest bar.
SAMPLE_FILL_GAP_S = 20 * 60
INTRADAY_RANGES = frozenset({"1d", "1w"})
WEEKLY_RANGES = frozenset({"10y", "max"})
MA_RANGES = frozenset({"1y", "5y", "10y", "max"})
_MONTHS = {"1m": 1, "3m": 3, "1y": 12, "5y": 60, "10y": 120}
SIX_DP = Decimal("0.000001")
ONE = Decimal(1)
SOURCE_ECB = "ECB reference rate"
SOURCE_LIVE = "live samples"


def _q6(value: Decimal) -> Decimal:
    return value.quantize(SIX_DP)


def _minus_months(day: date, months: int) -> date:
    total = day.year * 12 + (day.month - 1) - months
    year, month = divmod(total, 12)
    month += 1
    for dd in (day.day, 30, 29, 28):
        try:
            return date(year, month, dd)
        except ValueError:
            continue
    return date(year, month, 28)  # pragma: no cover - unreachable


def range_start(range_key: str, today: date, first_ledger: date | None = None) -> date:
    """First calendar day of a daily/weekly range (``all``: the first ledger day)."""
    if range_key == "all":
        return (
            first_ledger
            if first_ledger is not None and first_ledger <= today
            else (fx_service.HISTORY_START)
        )
    if range_key == "ytd":
        return date(today.year, 1, 1)
    if range_key == "max":
        return fx_service.HISTORY_START
    return _minus_months(today, _MONTHS[range_key])


def _iso_utc(at: datetime) -> str:
    return (at if at.tzinfo is not None else at.replace(tzinfo=UTC)).isoformat()


def us_market_hours(start_at: datetime, end_at: datetime) -> list[dict[str, str]]:
    """The US regular sessions overlapping ``[start_at, end_at]`` (naive or aware UTC).

    09:30 to the day's close (16:00, 13:00 on half days) New York time, holidays and
    weekends left out, clipped to the window. The rate chart shades these hours so
    the moves while you could trade stand apart from the overnight ones.
    """
    lo = start_at if start_at.tzinfo else start_at.replace(tzinfo=UTC)
    hi = end_at if end_at.tzinfo else end_at.replace(tzinfo=UTC)
    out: list[dict[str, str]] = []
    day = lo.astimezone(UTC).date() - timedelta(days=1)
    while day <= hi.astimezone(UTC).date():
        if market_hours.is_trading_day(day):
            o = market_hours.regular_session_open(day).astimezone(UTC)
            c = market_hours.regular_session_close(day).astimezone(UTC)
            o, c = max(o, lo), min(c, hi)
            if o < c:
                out.append({"open": _iso_utc(o), "close": _iso_utc(c)})
        day += timedelta(days=1)
    return out


def _point(t: str, rate: Decimal, inverse: Decimal | None = None) -> dict[str, Any]:
    inv = ONE / rate if inverse is None else inverse
    return {"t": t, "rate": dec(rate), "inverse": dec(_q6(inv))}


def _weekly(points: Sequence[tuple[date, Decimal]]) -> list[tuple[date, Decimal]]:
    """The last row of each ISO week."""
    out: list[tuple[date, Decimal]] = []
    for d, r in points:
        if out and out[-1][0].isocalendar()[:2] == d.isocalendar()[:2]:
            out[-1] = (d, r)
        else:
            out.append((d, r))
    return out


def _change(first: Decimal, last: Decimal) -> dict[str, Any]:
    return {
        "start_rate": dec(first),
        "end_rate": dec(last),
        "rate_pct": dec(last / first - ONE),
        "inverse_pct": dec(first / last - ONE),
    }


def _trend(daily: Sequence[tuple[date, Decimal]]) -> dict[str, Any] | None:
    reg = fx_trend.regime(daily)
    move = fx_trend.move_normality(daily)
    if reg is None or move is None:
        return None
    return {
        "direction": reg.direction,
        "since": reg.since.isoformat(),
        "since_change_pct": dec(reg.since_change_pct),
        "vs_ma200": reg.vs_ma200,
        "normal": move.label,
        "move_pct": dec(move.move_pct),
        "typical_move_pct": dec(move.typical_move_pct),
        "move_percentile": dec(move.percentile),
        "window_days": move.window_days,
    }


def _markers(session: Session, start: date, end: date) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in fx_conversion_service.list_conversions(session):
        if not start <= row.date <= end or row.eur_sent <= 0:
            continue
        out.append(
            {
                "date": row.date.isoformat(),
                "rate": dec(row.usd_received / row.eur_sent),
                "amount_from": dec(row.eur_sent),
                "from_ccy": "EUR",
                "to_ccy": "USD",
                "kind": None,
                "conversion_id": row.id,
            }
        )
    out.sort(key=lambda m: (m["date"], m["conversion_id"]))
    return out


def _intraday(
    session: Session, range_key: str, now: datetime
) -> tuple[list[tuple[str, Decimal]], list[dict[str, str]], datetime, datetime]:
    """``(points, sessions, start, end)`` of the 1d / 1w forex-day window (naive UTC)."""
    forex_days = market_hours.forex_sessions(now, 1 if range_key == "1d" else 5)
    now_naive = now.astimezone(UTC).replace(tzinfo=None)
    start_at = forex_days[0][0].replace(tzinfo=None)
    end_at = min(now_naive, forex_days[-1][1].replace(tzinfo=None))
    sessions = (
        [{"open": _iso_utc(o), "close": _iso_utc(c)} for o, c in forex_days]
        if range_key == "1w"
        else []
    )
    merged: dict[datetime, Decimal] = {}
    try:
        bars = fx_service.eur_usd_forex_bars(start_at.date(), end_at.date())
    except Exception:  # pragma: no cover - the service already fails soft
        bars = {}
    merged.update({t: r for t, r in bars.items() if start_at <= t <= end_at})
    # The stored samples only fill where the bars leave a hole (a feed outage, or the
    # minutes after the newest bar). Interleaved with the bars they would zigzag: a
    # 5-minute sample and the 15-minute bar beside it are struck at different instants.
    bar_times = sorted(merged)
    for at, r in intraday_snapshots_service.fx_samples_between(session, start_at, end_at):
        i = bisect.bisect_left(bar_times, at)
        near = [bar_times[j] for j in (i - 1, i) if 0 <= j < len(bar_times)]
        if all(abs((at - b).total_seconds()) > SAMPLE_FILL_GAP_S for b in near):
            merged.setdefault(at, r)
    return [(_iso_utc(at), r) for at, r in sorted(merged.items())], sessions, start_at, end_at


def build_rate_history(
    session: Session,
    range_key: str,
    *,
    avg_invest_rate: Decimal | None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """The ``RateHistoryOut`` payload for ``range_key`` (one of :data:`RANGES`).

    ``avg_invest_rate`` is the Overview's ``currency.lifetime.avg_invest_rate``,
    passed in so both pages show the very same number.
    """
    if range_key not in RANGES:
        raise ValueError(f"unknown range {range_key!r}")
    now = now or datetime.now(UTC)
    today = exchange_today(now)
    daily = sorted(
        (d, r) for d, r in fx_service.get_settled_rates(session).items() if r > 0 and d <= today
    )
    live = fx_service.active_live_spot("USD", now=now)
    today_rate = live.rate if live is not None else (daily[-1][1] if daily else None)

    points: list[dict[str, Any]] = []
    raw: list[tuple[str, Decimal]] = []
    ma_points: list[dict[str, Any]] = []
    sessions: list[dict[str, str]] = []
    stock_hours: list[dict[str, str]] = []
    first_ledger = transactions_repo.earliest_transaction_date(session)
    if range_key in INTRADAY_RANGES:
        granularity, source = "intraday", SOURCE_LIVE
        raw, sessions, start_at, end_at = _intraday(session, range_key, now)
        stock_hours = us_market_hours(start_at, end_at)
        as_of = raw[-1][0] if raw else None
        marker_start, marker_end = start_at.date(), end_at.date()
    else:
        start = range_start(range_key, today, first_ledger)
        span_days = (today - start).days
        weekly = range_key in WEEKLY_RANGES or (range_key == "all" and span_days > 3 * 365)
        granularity = "weekly" if weekly else "daily"
        source = SOURCE_ECB
        in_range = [(d, r) for d, r in daily if d >= start]
        as_of = in_range[-1][0].isoformat() if in_range else None
        if live is not None and live.observed_on == today and start <= today:
            # Today's live spot is the newest point (replacing today's own fixing);
            # a past day (Friday's close over the weekend) keeps its ECB fixing.
            if in_range and in_range[-1][0] == live.observed_on:
                in_range = in_range[:-1]
            in_range.append((live.observed_on, live.rate))
            as_of = _iso_utc(live.observed_at) if live.observed_at else live.observed_on.isoformat()
        shown = _weekly(in_range) if weekly else in_range
        raw = [(d.isoformat(), r) for d, r in shown]
        if range_key in MA_RANGES or (range_key == "all" and span_days >= 365):
            ma_rate = dict(fx_trend.moving_average(daily))
            ma_inv = dict(fx_trend.moving_average(fx_trend.inverse_series(daily)))
            ma_points = [
                _point(d.isoformat(), _q6(ma_rate[d]), ma_inv[d])
                for d, _r in shown
                if d in ma_rate and d in ma_inv
            ]
        marker_start, marker_end = start, today

    points = [_point(t, r) for t, r in raw]
    extremes = fx_trend.range_extremes(raw)
    percentiles = (
        fx_trend.rate_percentiles(
            daily,
            today_rate,
            {
                "since_start": first_ledger,
                "y5": _minus_months(today, 60),
                "y10": _minus_months(today, 120),
                "since_1999": fx_service.HISTORY_START,
            },
        )
        if today_rate is not None
        else dict.fromkeys(("since_start", "y5", "y10", "since_1999"))
    )
    return {
        "range": range_key,
        "granularity": granularity,
        "as_of": as_of,
        "source": source,
        "sessions": sessions,
        "us_market_hours": stock_hours,
        "points": points,
        "ma200": ma_points,
        "avg_rate": (
            {"rate": dec(avg_invest_rate), "inverse": dec(_q6(ONE / avg_invest_rate))}
            if avg_invest_rate is not None and avg_invest_rate > 0
            else None
        ),
        "low": _point(extremes.low_at, extremes.low) if extremes else None,
        "high": _point(extremes.high_at, extremes.high) if extremes else None,
        "change": _change(raw[0][1], raw[-1][1]) if raw else None,
        "trend": _trend(daily),
        "percentiles": {k: dec(v) for k, v in percentiles.items()},
        "markers": _markers(session, marker_start, marker_end),
    }


__all__ = ["RANGES", "build_rate_history", "range_start"]
