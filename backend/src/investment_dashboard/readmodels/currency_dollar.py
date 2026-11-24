"""The Currency page's "The dollar" section (v7.2, ``GET /currency/dollar/both``).

Built from the Overview payload of each side (``lifetime`` / ``today`` copied, so
the pages never disagree) and the **settled** daily ECB series (``fx_history``,
never the live overlay on a past day). Rates are USD per 1 EUR (``rate``) with
``inverse`` = 1 / rate (the dollar in euros); each side names the quote it shows
in ``quote`` (EUR: ``inverse`` / ``USD/EUR``; USD: ``rate`` / ``EUR/USD``).

💱 Currency rule: ``exposure_usd`` is summed from native dollars (USD-account
positions at their native value), never from a euro figure. ``exposure_value``
is that amount in the side's currency at ONE rate (today's spot). The trend
block, percentiles and rolling changes are statistics of the rate series itself;
no portfolio return is involved or converted. All maths is in
:mod:`investment_dashboard.domain.fx_trend`.
"""

from __future__ import annotations

from bisect import bisect_right
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import clock, fx_trend
from investment_dashboard.domain.fx_scenarios import book_from_holdings, value_at
from investment_dashboard.domain.late_data import Holding
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.readmodels import currency_range
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import fx_service, investing_power_service, positions_service

QUOTES: dict[str, dict[str, str]] = {
    "EUR": {"pair": "USD/EUR", "field": "inverse"},
    "USD": {"pair": "EUR/USD", "field": "rate"},
}
ONE = Decimal(1)
SIX_DP = Decimal("0.000001")
INTRADAY_RANGES = frozenset({"1d", "1w"})
WEEKLY_RANGES = frozenset({"10y", "max"})
ROLLING_WINDOWS: tuple[tuple[str, int], ...] = (
    ("1m", fx_trend.MONTH_ROWS),
    ("3m", fx_trend.QUARTER_ROWS),
    ("1y", fx_trend.YEAR_ROWS),
)


def _d(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except ArithmeticError:
        return None


def _rv(rate: Decimal | None) -> dict[str, Any] | None:
    """A ``RateValue`` (USD per EUR + its inverse to 6 dp), ``None`` without a rate."""
    if rate is None or rate <= 0:
        return None
    return {"rate": dec(rate), "inverse": dec((ONE / rate).quantize(SIX_DP))}


def _display(rate: Decimal, ccy: str) -> Decimal:
    """``rate`` quoted the way side ``ccy`` shows it."""
    return (ONE / rate).quantize(SIX_DP) if QUOTES[ccy]["field"] == "inverse" else rate


def _change(start: Decimal | None, end: Decimal | None) -> dict[str, Any] | None:
    if start is None or end is None or start <= 0 or end <= 0:
        return None
    return {
        "start_rate": dec(start),
        "end_rate": dec(end),
        "rate_pct": dec(end / start - ONE),
        "inverse_pct": dec(start / end - ONE),
    }


_minus_months = currency_range.minus_months


def _on_or_before(daily: list[tuple[date, Decimal]], day: date) -> tuple[date, Decimal] | None:
    """The last settled row on or before ``day`` (bisect on the sorted series)."""

    i = bisect_right(daily, (day, Decimal("Infinity"))) - 1
    return daily[i] if i >= 0 else None


def _point(d: date, rate: Decimal) -> dict[str, Any]:
    return {"t": d.isoformat(), "rate": dec(rate), "inverse": dec((ONE / rate).quantize(SIX_DP))}


# -- the position card ---------------------------------------------------------


def _exposure(
    positions: list[positions_service.Position], spot: Decimal | None, ccy: str
) -> dict[str, Any]:
    holdings = [
        Holding(p.account.native_currency, p.current_value_native, p.current_value_eur)
        for p in positions
        if p.current_value_native
    ]
    book = book_from_holdings(holdings)
    out: dict[str, Any] = {"exposure_usd": dec(book.usd) if holdings else None}
    if spot is not None and spot > 0 and holdings:
        side = "EUR" if ccy == "EUR" else "USD"
        exposure_value = book.usd / spot if side == "EUR" else book.usd
        total = value_at(book, spot, side)
        out["exposure_value"] = dec(exposure_value)
        out["exposure_share"] = dec(exposure_value / total) if total > 0 else None
        if side == "USD":
            # The USD view turned around: what you hold outside dollars (native
            # euros at the one valuation rate), usually nothing.
            other = total - book.usd
            out["other_value"] = dec(other)
            out["other_share"] = dec(other / total) if total > 0 else None
    return out


def _position(
    exposure: dict[str, Any], life: dict[str, Any], today: dict[str, Any]
) -> dict[str, Any]:
    avg = _d(life.get("avg_invest_rate"))
    spot, prev = _d(today.get("spot")), _d(today.get("prev"))
    now = _d(life.get("current_rate")) or spot
    return {
        **exposure,
        "avg_rate": _rv(avg),
        "rate_now": _rv(now),
        "change": _change(avg, now),
        "fx_gain_eur": life.get("fx_pnl_eur"),
        "breakeven": _rv(_d(life.get("breakeven_rate"))),
        "today": _change(prev, spot),
    }


def _next_euro(
    amount: Decimal,
    daily: list[tuple[date, Decimal]],
    spot: Decimal | None,
    today: date,
    first: date | None,
) -> dict[str, Any] | None:
    if spot is None or spot <= 0:
        return None
    usd_now = amount * spot
    out: dict[str, Any] = {
        "amount_eur": dec(amount),
        "usd_now": dec(usd_now),
        "better_than_share": (
            dec(fx_trend.share_below(daily, spot, first)) if first is not None else None
        ),
    }
    year_ago = today - timedelta(days=365)
    # "Dollars per the regular amount" over the last year, weekly: the sparkline beside the headline.
    out["spark"] = [
        {"t": d.isoformat(), "usd": dec(amount * r)}
        for d, r in _thin_weekly([(d, r) for d, r in daily if d >= year_ago])
    ]
    row = _on_or_before(daily, year_ago)
    if row is not None and daily and daily[0][0] <= year_ago:
        usd_then = amount * row[1]
        out |= {
            "usd_year_ago": dec(usd_then),
            "year_ago_date": row[0].isoformat(),
            "change_pct": dec(usd_now / usd_then - ONE),
        }
    out["dollar_lens"] = _dollar_lens(usd_now, daily, spot, year_ago, first)
    return out


def _dollar_lens(
    usd_amount: Decimal,
    daily: list[tuple[date, Decimal]],
    spot: Decimal,
    year_ago: date,
    first: date | None,
) -> dict[str, Any]:
    """The book lens of the same card: a native-dollar notional valued in euros.

    ``usd_amount`` is the dollars the regular euro amount buys today (a native dollar
    figure, never derived back from euros). Each value is that one dollar amount at one
    rate (``usd / fx`` at a single instant): today's spot, the settled rate a year ago
    and each week in between. No return is converted; the change is the ratio of two
    euro values of the same dollars.
    """
    eur_now = usd_amount / spot
    out: dict[str, Any] = {
        "usd_amount": dec(usd_amount),
        "eur_now": dec(eur_now),
        # Share of days since you started on which these dollars were worth fewer euros
        # than now (a rate above today's spot).
        "better_than_share": (
            dec(fx_trend.share_above(daily, spot, first)) if first is not None else None
        ),
        "spark": [
            {"t": d.isoformat(), "eur": dec(usd_amount / r)}
            for d, r in _thin_weekly([(d, r) for d, r in daily if d >= year_ago])
        ],
    }
    row = _on_or_before(daily, year_ago)
    if row is not None and daily and daily[0][0] <= year_ago:
        eur_then = usd_amount / row[1]
        out |= {
            "eur_year_ago": dec(eur_then),
            "year_ago_date": row[0].isoformat(),
            "change_pct": dec(eur_now / eur_then - ONE),
        }
    return out


# -- the trend block -----------------------------------------------------------


def _asset(ccy: str) -> fx_trend.Asset:
    """Whose trend a side reads: EUR (value) the dollar's, USD (investing) the euro's."""
    return "dollar" if ccy == "EUR" else "euro"


def _normal(
    daily: list[tuple[date, Decimal]], window: str, rows: int, of: fx_trend.Asset = "dollar"
) -> dict[str, Any] | None:
    move = fx_trend.move_normality(daily, rows, of=of)
    band = fx_trend.move_band(daily, rows, of=of)
    if move is None or band is None:
        return None
    return {
        "window": window,
        "window_days": rows,
        "move_pct": dec(move.move_pct),
        "typical_move_pct": dec(band.typical_move_pct),
        "normal_limit_pct": dec(band.normal_limit_pct),
        "percentile": dec(move.percentile),
        "label": move.label,
    }


def _ma200(
    daily: list[tuple[date, Decimal]], of: fx_trend.Asset = "dollar"
) -> dict[str, Any] | None:
    s = fx_trend.ma_slope(daily, of=of)
    dollar = s if of == "dollar" else fx_trend.ma_slope(daily)
    if s is None or dollar is None:
        return None
    return {
        "side": s.side,
        "ma200": {"rate": dec(s.ma_rate_now), "inverse": dec(dollar.ma_now.quantize(SIX_DP))},
        "distance_pct": dec(s.distance_pct),
        "slope": s.label,
        "slope_pct": dec(s.slope_pct),
        "slope_days": fx_trend.SLOPE_DAYS,
    }


def _week52(daily: list[tuple[date, Decimal]], today: date) -> dict[str, Any] | None:
    rows = [(d, r) for d, r in daily if d > today - timedelta(days=365)]
    ext = fx_trend.range_extremes(rows)
    if ext is None or not rows:
        return None
    now = rows[-1][1]
    return {
        "low": _point(ext.low_at, ext.low),
        "high": _point(ext.high_at, ext.high),
        "from_low_rate_pct": dec(now / ext.low - ONE),
        "from_high_rate_pct": dec(now / ext.high - ONE),
        "from_low_inverse_pct": dec(ext.low / now - ONE),
        "from_high_inverse_pct": dec(ext.high / now - ONE),
    }


def _trend(
    daily: list[tuple[date, Decimal]],
    spot: Decimal | None,
    today: date,
    first: date | None,
    avg: Decimal | None,
    of: fx_trend.Asset = "dollar",
) -> dict[str, Any]:
    """The trend block in ``of``'s terms (the dollar's or the euro's own moves)."""
    reg = fx_trend.regime(daily, of=of)
    run = fx_trend.monthly_run(daily, of=of)
    mean = fx_trend.series_mean(daily, fx_service.HISTORY_START)
    rate_now = spot if spot is not None and spot > 0 else (daily[-1][1] if daily else None)
    percentiles: dict[str, Any] = dict.fromkeys(("since_start", "y5", "y10", "since_1999"))
    if rate_now is not None:
        raw = fx_trend.rate_percentiles(
            daily,
            rate_now,
            {
                "since_start": first,
                "y5": _minus_months(today, 60),
                "y10": _minus_months(today, 120),
                "since_1999": fx_service.HISTORY_START,
            },
            of=of,
        )
        percentiles = {k: dec(v) for k, v in raw.items()}
    return {
        "asset": of,
        "regime": (
            {
                "direction": reg.direction,
                "since": reg.since.isoformat(),
                "since_change_pct": dec(reg.since_change_pct),
            }
            if reg is not None
            else None
        ),
        "ma200": _ma200(daily, of),
        "normal_month": _normal(daily, "month", fx_trend.MONTH_ROWS, of),
        "normal_year": _normal(daily, "year", fx_trend.YEAR_ROWS, of),
        "percentiles": percentiles,
        "week52": _week52(daily, today),
        "run": (
            {
                "direction": run.direction,
                "count": run.count,
                "of": run.of,
                "unit": "month",
                "months": [
                    {"month": d.strftime("%Y-%m"), "move": m}
                    for d, m in zip(run.month_ends, run.months, strict=True)
                ],
            }
            if run is not None
            else None
        ),
        "long_run": (
            {
                "since": mean.since.isoformat(),
                "mean": {"rate": dec(mean.rate), "inverse": dec(mean.inverse.quantize(SIX_DP))},
                "distance_inverse_pct": dec((ONE / rate_now) / mean.inverse - ONE),
                # The asset's own distance: the euro's on the rate's own mean.
                "distance_pct": dec(
                    (ONE / rate_now) / mean.inverse - ONE
                    if of == "dollar"
                    else rate_now / mean.rate - ONE
                ),
            }
            if mean is not None and rate_now is not None
            else None
        ),
        # Days the asset stood above your average conversion rate: the dollar when
        # the rate was below it, the euro when the rate was above it.
        "above_entry_share": (
            dec(
                fx_trend.share_below(daily, avg, first)
                if of == "dollar"
                else fx_trend.share_above(daily, avg, first)
            )
            if avg is not None and avg > 0 and first is not None
            else None
        ),
    }


# -- rolling changes -----------------------------------------------------------


def _thin_weekly(rows: list[tuple[date, Decimal]]) -> list[tuple[date, Decimal]]:
    out: list[tuple[date, Decimal]] = []
    for d, v in rows:
        if out and out[-1][0].isocalendar()[:2] == d.isocalendar()[:2]:
            out[-1] = (d, v)
        else:
            out.append((d, v))
    return out


def _rolling(
    daily: list[tuple[date, Decimal]],
    range_key: str,
    today: date,
    of: fx_trend.Asset = "dollar",
    first: date | None = None,
) -> list[dict[str, Any]]:
    """Trailing changes and their normal band, in ``of``'s terms (each side its own)."""
    if range_key in INTRADAY_RANGES:
        # A month-long trailing change says nothing about one day or week: the card
        # says the range is too short instead of quietly showing a month (7.3.1).
        return []
    start = currency_range.resolve(range_key, today, first).start_on
    out: list[dict[str, Any]] = []
    for window, rows in ROLLING_WINDOWS:
        moves = fx_trend.trailing_moves(daily, rows, of=of)
        band = fx_trend.move_band(daily, rows, of=of)
        shown = [(d, m) for d, m in moves if d >= start]
        if range_key in WEEKLY_RANGES:
            shown = _thin_weekly(shown)
        out.append(
            {
                "window": window,
                "window_days": rows,
                "points": [
                    # the other side's change = 1 / (1 + this change) - 1
                    {
                        "t": d.isoformat(),
                        "inverse_pct": dec(m if of == "dollar" else ONE / (ONE + m) - ONE),
                        "rate_pct": dec(ONE / (ONE + m) - ONE if of == "dollar" else m),
                    }
                    for d, m in shown
                ],
                "typical_move_pct": dec(band.typical_move_pct) if band else None,
                "normal_limit_pct": dec(band.normal_limit_pct) if band else None,
            }
        )
    return out


# -- stats tiles ---------------------------------------------------------------


def _stat(key: str, value: Decimal, unit: str, **extra: Any) -> dict[str, Any]:
    return {"key": key, "value": dec(value), "unit": unit, **extra}


def _rate_stat(
    key: str, rate: Decimal, ccy: str, *, on: date | None = None, **extra: Any
) -> dict[str, Any]:
    return _stat(
        key,
        rate,
        "rate",
        value_display=dec(_display(rate, ccy)),
        date=on.isoformat() if on else None,
        **extra,
    )


def _stats(
    ccy: str,
    daily: list[tuple[date, Decimal]],
    trend: dict[str, Any],
    first: date | None,
    avg: Decimal | None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for key, name in (
        ("since_start", "percentile_since_start"),
        ("y5", "percentile_y5"),
        ("y10", "percentile_y10"),
        ("since_1999", "percentile_since_1999"),
    ):
        value = _d(trend["percentiles"].get(key))
        if value is not None:
            out.append(_stat(name, value, "fraction"))
    w52 = trend.get("week52")
    if w52 is not None:
        inverse = QUOTES[ccy]["field"] == "inverse"
        for end in ("low", "high"):
            point = w52[end]
            distance = w52[f"from_{end}_{'inverse' if inverse else 'rate'}_pct"]
            out.append(
                _rate_stat(
                    f"week52_{end}",
                    Decimal(point["rate"]),
                    ccy,
                    on=date.fromisoformat(point["t"]),
                    secondary=distance,
                    secondary_unit="fraction",
                )
            )
    if first is not None:
        held = [(d, r) for d, r in daily if d >= first]
        ext = fx_trend.range_extremes(held)
        if ext is not None:
            # The dollar's low is EUR/USD's high: in the inverted quote the extremes swap.
            lo, lo_at, hi, hi_at = ext.low, ext.low_at, ext.high, ext.high_at
            if QUOTES[ccy]["field"] == "inverse":
                lo, lo_at, hi, hi_at = hi, hi_at, lo, lo_at
            out.append(_rate_stat("low_since_start", lo, ccy, on=lo_at))
            out.append(_rate_stat("high_since_start", hi, ccy, on=hi_at))
        mean = fx_trend.series_mean(daily, first)
        if mean is not None:
            out.append(_rate_stat("avg_rate_holding", mean.rate, ccy, on=mean.since))
        if avg is not None and avg > 0:
            # "Above your average" in the quote this side shows: the dollar (inverse)
            # above it in the EUR view (rate below avg), the rate above it in USD.
            share = (
                fx_trend.share_below(daily, avg, first)
                if QUOTES[ccy]["field"] == "inverse"
                else fx_trend.share_above(daily, avg, first)
            )
            if share is not None:
                out.append(
                    _stat(
                        "share_above_avg",
                        share,
                        "fraction",
                        secondary=dec(avg),
                        secondary_unit="rate",
                        secondary_display=dec(_display(avg, ccy)),
                    )
                )
    vol = fx_trend.rate_volatility(daily, inverse=QUOTES[ccy]["field"] == "inverse")
    if vol is not None:
        out.append(_stat("rate_volatility", vol, "fraction"))
    return out


def _range_change(
    daily: list[tuple[date, Decimal]], range_key: str, today: date, first: date | None
) -> dict[str, Any] | None:
    """The settled rate from the range's start rate to the last settled close.

    The same start as the rate chart (:func:`currency_range.start_rate`). 1D has no
    settled change (it is today's live move, shown by the rate chip).
    """
    if range_key == "1d" or not daily or (range_key == "all" and first is None):
        return None
    start = currency_range.start_rate(daily, currency_range.resolve(range_key, today, first))
    if start is None:
        return None
    return _change(start[1], daily[-1][1])


def build_dollar_both(
    session: Session,
    overview: dict[str, dict[str, Any]],
    range_key: str,
    *,
    now: datetime | None = None,
) -> dict[str, dict[str, Any]]:
    """``{"EUR": DollarOut, "USD": DollarOut}`` payloads (plain dicts)."""
    now = now or clock.now()
    today = exchange_today(now)
    daily = sorted(
        (d, r) for d, r in fx_service.get_settled_rates(session).items() if r > 0 and d <= today
    )
    first = transactions_repo.earliest_transaction_date(session)
    amount = investing_power_service.get_amount_eur(session)
    on_raw = overview["EUR"].get("kpis", {}).get("daily_growth_as_of")
    on = date.fromisoformat(str(on_raw)[:10]) if on_raw else today
    positions = positions_service.compute_positions(session, as_of=on)
    assets: tuple[fx_trend.Asset, ...] = ("dollar", "euro")
    rolling = {of: _rolling(daily, range_key, today, of, first) for of in assets}
    range_change = _range_change(daily, range_key, today, first)
    out: dict[str, dict[str, Any]] = {}
    # Both sides normally share the spot and the average rate: compute the block once.
    trends: dict[tuple[Decimal | None, Decimal | None, str], dict[str, Any]] = {}
    for ccy in ("EUR", "USD"):
        cur = overview[ccy]["currency"]
        life, today_block = cur["lifetime"], cur["today"]
        spot = _d(today_block.get("spot"))
        avg = _d(life.get("avg_invest_rate"))
        of = _asset(ccy)
        if (spot, avg, of) not in trends:
            trends[spot, avg, of] = _trend(daily, spot, today, first, avg, of)
        trend = trends[spot, avg, of]
        out[ccy] = {
            "ccy": ccy,
            "as_of": overview[ccy].get("as_of"),
            "generated_at": now.isoformat(),
            "range": range_key,
            "quote": QUOTES[ccy],
            "position": _position(_exposure(positions, spot, ccy), life, today_block)
            | {"range_change": range_change},
            "next_euro": _next_euro(amount, daily, spot, today, first),
            "trend": trend,
            "rolling": rolling[of],
            "rolling_too_short": range_key in INTRADAY_RANGES,
            "window": currency_range.resolve(range_key, today, first).to_dict(),
            "stats": _stats(ccy, daily, trend, first, avg),
        }
    return out


__all__ = ["QUOTES", "build_dollar_both"]
