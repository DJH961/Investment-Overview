"""EUR/USD rate history for the Currency page chart (v7.2, ``GET /currency/rate-history``).

Rates are USD per 1 EUR (``rate``); ``inverse`` = 1 / rate (EUR per 1 USD, the
dollar's terms), computed here to 6 dp. The payload is the same for both
reporting currencies (it is a market rate, not a portfolio figure).

* ``1d`` / ``1w``: the stored intraday samples (``IntradayValue.fx_eur_usd``),
  ``granularity = "intraday"``, ``source = "live samples"``.
* ``1m`` .. ``5y``: the **settled** daily ECB rows (``fx_history``), never the live
  overlay on a past day; the last point may be today's live spot (``as_of`` then
  carries its instant). ``10y`` / ``max``: the last ECB day of each ISO week.
* ``ma200`` (ranges >= 1y, daily/weekly): computed on the FULL daily history, so it
  starts at the range start; ``rate`` is the MA of the rate and ``inverse`` the MA
  of the inverse (the one :mod:`domain.fx_trend` compares the dollar against).
* ``trend`` / ``percentiles``: always from the full daily history, whatever the range.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import fx_trend
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import (
    fx_conversion_service,
    fx_service,
    intraday_snapshots_service,
)

RANGES: tuple[str, ...] = ("1d", "1w", "1m", "3m", "ytd", "1y", "5y", "10y", "max")
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


def range_start(range_key: str, today: date) -> date:
    """First calendar day of a daily/weekly range."""
    if range_key == "ytd":
        return date(today.year, 1, 1)
    if range_key == "max":
        return fx_service.HISTORY_START
    return _minus_months(today, _MONTHS[range_key])


def _iso_utc(at: datetime) -> str:
    return (at if at.tzinfo is not None else at.replace(tzinfo=UTC)).isoformat()


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
    if range_key in INTRADAY_RANGES:
        granularity, source = "intraday", SOURCE_LIVE
        if range_key == "1d":
            start_at, end_at = intraday_snapshots_service.session_window_utc(now)
        else:
            start_at = intraday_snapshots_service.week_window_start_utc(now)
            end_at = now.astimezone(UTC).replace(tzinfo=None)
        samples = intraday_snapshots_service.fx_samples_between(session, start_at, end_at)
        raw = [(_iso_utc(at), r) for at, r in samples]
        as_of = raw[-1][0] if raw else None
        marker_start, marker_end = start_at.date(), end_at.date()
    else:
        granularity = "weekly" if range_key in WEEKLY_RANGES else "daily"
        source = SOURCE_ECB
        start = range_start(range_key, today)
        in_range = [(d, r) for d, r in daily if d >= start]
        as_of = in_range[-1][0].isoformat() if in_range else None
        if live is not None and live.observed_on == today and start <= today:
            # Today's live spot is the newest point (replacing today's own fixing);
            # a past day (Friday's close over the weekend) keeps its ECB fixing.
            if in_range and in_range[-1][0] == live.observed_on:
                in_range = in_range[:-1]
            in_range.append((live.observed_on, live.rate))
            as_of = _iso_utc(live.observed_at) if live.observed_at else live.observed_on.isoformat()
        shown = _weekly(in_range) if granularity == "weekly" else in_range
        raw = [(d.isoformat(), r) for d, r in shown]
        if range_key in MA_RANGES:
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
    first_ledger = transactions_repo.earliest_transaction_date(session)
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
