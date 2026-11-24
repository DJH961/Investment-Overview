"""The Currency page's "What if" section (v7.2, ``GET /currency/scenarios/both``).

The server computes every scenario row; the browser only picks one.

💱 Currency rule: every value here is today's book valued at ONE assumed rate
(:mod:`investment_dashboard.domain.fx_scenarios`), each side in its own currency
from the native amounts (USD holdings stay native dollars; nothing is converted
from the other side). The book is the market-price book the Today currency card
and ``one_cent`` value (``metrics_service.book_holdings``, holdings + cash), on
the Overview's ``daily_growth_as_of`` day.

"Cushion or amplify" runs :mod:`investment_dashboard.domain.risk` on the EUR and
the USD equity curves (each its own flow-adjusted growth index, never one
converted into the other) since the first invested day; the down days are the
holdings' falls **in dollars**, compared with the settled ECB rate move that day.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import clock, fx_scenarios, fx_trend
from investment_dashboard.domain.fx_scenarios import Book
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.domain.returns import growth_index
from investment_dashboard.domain.risk import annualized_volatility, max_drawdown
from investment_dashboard.readmodels import currency_range
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.currency_dollar import QUOTES
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import fx_service, investing_power_service, metrics_service

MIN_RATE = fx_scenarios.SLIDER_MIN
MAX_RATE = fx_scenarios.SLIDER_MAX
STEP = fx_scenarios.SLIDER_STEP
#: Inverse quote (USD/EUR): the slider's own span, so min/max/step describe the quote shown.
INVERSE_MIN_RATE = fx_scenarios.INVERSE_SLIDER_MIN
INVERSE_MAX_RATE = fx_scenarios.INVERSE_SLIDER_MAX
ONE = Decimal(1)
SIX_DP = Decimal("0.000001")


def _d(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except ArithmeticError:
        return None


def _rv(rate: Decimal | None) -> dict[str, Any] | None:
    if rate is None or rate <= 0:
        return None
    return {"rate": dec(rate), "inverse": dec((ONE / rate).quantize(SIX_DP))}


def _display(rate: Decimal, ccy: str) -> Decimal:
    return (ONE / rate).quantize(SIX_DP) if QUOTES[ccy]["field"] == "inverse" else rate


@dataclass(frozen=True)
class Invest:
    """The euros sent in: a round unit and the regular amount (``investing_power``)."""

    unit: Decimal
    monthly: Decimal


def _invest_fields(
    invest: Invest | None, rate: Decimal, spot: Decimal | None, avg: Decimal | None
) -> dict[str, Any]:
    """Dollars the euros sent in buy at ``rate``, against today and your average rate.

    💱 Native amounts valued at one assumed rate: ``euros × rate`` is a single-instant
    conversion, never a converted return.
    """
    if invest is None:
        return {}
    unit, monthly = invest.unit * rate, invest.monthly * rate
    out: dict[str, Any] = {"per_unit": dec(unit), "per_monthly": dec(monthly)}
    if spot is not None and spot > 0:
        out["unit_change"] = dec(unit - invest.unit * spot)
        out["monthly_change"] = dec(monthly - invest.monthly * spot)
    if avg is not None and avg > 0:
        out["unit_vs_avg"] = dec(unit - invest.unit * avg)
        out["monthly_vs_avg"] = dec(monthly - invest.monthly * avg)
    return out


def _row(
    book: Book,
    shown: Decimal,
    rate: Decimal,
    ccy: str,
    avg: Decimal | None,
    be: Decimal | None,
    other: str,
    invest: Invest | None = None,
    spot: Decimal | None = None,
) -> Any:
    """One slider row: ``shown`` is the quote's value, ``rate`` the EUR/USD rate behind it."""
    side = "EUR" if ccy == "EUR" else "USD"
    be_shown = _display(be, ccy) if be is not None and be > 0 else None
    return _invest_fields(invest, rate, spot, avg) | {
        "rate": dec(rate),
        "rate_display": dec(shown),
        "value": dec(fx_scenarios.value_at(book, rate, side)),
        # The book in the other currency at this rate: what still moves when the
        # side's own holdings do not (an all-dollar book in the dollar view).
        "other_value": dec(fx_scenarios.value_at(book, rate, other)),
        "gain": (
            dec(fx_scenarios.gain_at(book, rate, avg, side))
            if avg is not None and avg > 0
            else None
        ),
        # In the quote shown: how far the quote must move to reach break-even.
        "to_breakeven": dec(be_shown - shown) if be_shown is not None else None,
        "to_breakeven_pct": dec(be_shown / shown - ONE) if be_shown is not None else None,
    }


#: Fewer weekday returns than this say nothing about volatility: the card says so.
MIN_RETURNS = 20
#: A window shorter than this many days is "too short" without building any curve.
MIN_WINDOW_DAYS = 25


def range_start(range_key: str, today: date, first: date | None) -> date:
    """First day of the page range (one meaning: :mod:`currency_range`)."""
    return currency_range.resolve(range_key, today, first).start_on


def _too_short(since: date) -> dict[str, Any]:
    return {
        "since": since.isoformat(),
        "too_short": True,
        "down_days": 0,
        "down_days_dollar_rose": 0,
    }


def _cushion(session: Session, today: date, start: date) -> dict[str, Any] | None:
    """Volatility and deepest fall per currency + the dollar on the holdings' down days.

    The window starts at the page range's start, or at the first investment if later.
    """
    from investment_dashboard.readmodels.queries.analytics_query import (  # noqa: PLC0415
        CURVE_RECOMPUTE_TAIL_DAYS,
        build_curve,
    )

    first = transactions_repo.earliest_transaction_date(session)
    if first is None or first >= today:
        return None
    first = max(first, start)
    if (today - first).days < MIN_WINDOW_DAYS:
        return _too_short(first)
    indexes: dict[str, list[tuple[date, Decimal]]] = {}
    for ccy in ("EUR", "USD"):
        # The bounded recompute the Analytics page uses: a cold cache omits old days
        # (filled in the background) instead of rebuilding them on the request.
        curve = build_curve(
            session,
            start=first,
            end=today,
            currency=ccy,
            benchmark_closes={},
            recompute_tail_days=CURVE_RECOMPUTE_TAIL_DAYS,
        )
        lead = next((i for i, p in enumerate(curve) if p.portfolio_value > 0), None)
        if lead is None:
            return None
        curve = curve[lead:]
        new_money = [
            p.cumulative_contributions - curve[i - 1].cumulative_contributions if i else Decimal(0)
            for i, p in enumerate(curve)
        ]
        index = growth_index([p.portfolio_value for p in curve], new_money)
        indexes[ccy] = [(p.date, v) for p, v in zip(curve, index, strict=True)]
    returns = {c: fx_scenarios.weekday_returns(pts) for c, pts in indexes.items()}
    if len(returns["USD"]) < MIN_RETURNS:
        return _too_short(indexes["USD"][0][0])
    vols = {c: annualized_volatility([r for _d, r in rets]) for c, rets in returns.items()}
    mdds = {c: max_drawdown([v for _d, v in pts]) for c, pts in indexes.items()}
    down = fx_scenarios.dollar_on_down_days(returns["USD"], fx_service.get_settled_rates(session))
    return {
        "since": indexes["USD"][0][0].isoformat(),
        "volatility_eur": dec(vols["EUR"]),
        "volatility_usd": dec(vols["USD"]),
        "max_drawdown_eur": dec(mdds["EUR"]),
        "max_drawdown_usd": dec(mdds["USD"]),
        "down_days": down.down_days,
        "down_days_dollar_rose": down.dollar_rose,
        "dollar_rose_share": dec(down.share),
    }


def _stress(
    book: Book, spot: Decimal, ccy: str, *, inverse: bool, invest: Invest | None = None
) -> list[dict[str, Any]]:
    """Today's book with the quote shown moved by each shift, in both currencies."""
    side = "EUR" if ccy == "EUR" else "USD"
    other = "USD" if ccy == "EUR" else "EUR"
    now, other_now = (
        fx_scenarios.value_at(book, spot, side),
        fx_scenarios.value_at(book, spot, other),
    )
    rows = []
    for s, r in zip(
        fx_scenarios.STRESS_SHIFTS, fx_scenarios.stress_rates(spot, inverse=inverse), strict=True
    ):
        value, other_value = (
            fx_scenarios.value_at(book, r, side),
            fx_scenarios.value_at(book, r, other),
        )
        rows.append(
            _invest_fields(invest, r, spot, None)
            | {
                "shift_pct": dec(s),
                "rate": dec(r),
                "rate_display": dec(_display(r, ccy)),
                "value": dec(value),
                "change": dec(value - now),
                "other_value": dec(other_value),
                "other_change": dec(other_value - other_now),
            }
        )
    return rows


def _stat(key: str, value: Decimal, unit: str, **extra: Any) -> dict[str, Any]:
    return {"key": key, "value": dec(value), "unit": unit, **extra}


def _stats(
    ccy: str,
    *,
    sensitivity: dict[str, Any] | None,
    spot: Decimal | None,
    be: Decimal | None,
    lows_highs: dict[str, tuple[date, Decimal, Decimal]],
    cushion: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    # The cushion card shows volatility, deepest fall and the down days once; the strip
    # keeps only the four what-if figures.
    del cushion
    out: list[dict[str, Any]] = []
    if sensitivity is not None:
        out.append(
            _stat(
                "one_cent",
                Decimal(sensitivity["change"]),
                "money",
                currency=ccy,
                secondary=sensitivity["rate"],
                secondary_unit="rate",
                secondary_display=dec(_display(Decimal(sensitivity["rate"]), ccy)),
            )
        )
    if be is not None and be > 0:
        extra: dict[str, Any] = {}
        if spot is not None and spot > 0:
            extra = {
                "secondary": dec(_display(be, ccy) / _display(spot, ccy) - ONE),
                "secondary_unit": "fraction",
            }
        out.append(_stat("breakeven", be, "rate", value_display=dec(_display(be, ccy)), **extra))
    for key, name in (("historic_low", "value_at_low"), ("historic_high", "value_at_high")):
        if key in lows_highs:
            on, rate, value = lows_highs[key]
            out.append(
                _stat(
                    name,
                    value,
                    "money",
                    currency=ccy,
                    secondary=dec(rate),
                    secondary_unit="rate",
                    secondary_display=dec(_display(rate, ccy)),
                    date=on.isoformat(),
                )
            )
    return out


def _grid(spot: Decimal | None, ccy: str, *, inverse: bool) -> list[tuple[Decimal, Decimal]]:
    # The grid runs ascending in the quote shown, so the slider reads left to right.
    grid = fx_scenarios.quote_slider(inverse)
    if spot is not None and spot > 0 and grid[0][0] <= _display(spot, ccy) <= grid[-1][0]:
        # Today's own row carries today's exact rate, so the slider rests on today's
        # value (not on the nearest 0.005 step) and "compared with today" reads zero.
        at = fx_scenarios.nearest_index([q for q, _r in grid], _display(spot, ccy))
        grid[at] = (_display(spot, ccy), spot)
    return grid


def _add_mark(
    marks: list[dict[str, Any]],
    lows_highs: dict[str, tuple[date, Decimal, Decimal]],
    candidate: tuple[str, Decimal | None, date | None],
    ccy: str,
    shown_grid: list[Decimal],
    worth_at: Callable[[Decimal], Decimal],
) -> None:
    key, rate, on_day = candidate
    if rate is None or rate <= 0:
        return
    marks.append(
        {
            "key": key,
            "rate": dec(rate),
            "rate_display": dec(_display(rate, ccy)),
            "date": on_day.isoformat() if on_day else None,
            "row_index": fx_scenarios.nearest_index(shown_grid, _display(rate, ccy)),
        }
    )
    if on_day is not None and key != "range_start":
        lows_highs[key] = (on_day, rate, worth_at(rate))


def build_scenarios_both(  # noqa: PLR0915
    session: Session,
    overview: dict[str, dict[str, Any]],
    range_key: str = "max",
    *,
    now: datetime | None = None,
) -> dict[str, dict[str, Any]]:
    """``{"EUR": ScenariosOut, "USD": ScenariosOut}`` payloads (plain dicts).

    ``range_key`` is the Currency page's range: the low/high marks, the "start of
    range" mark and the cushion window follow it. The stress table and the slider
    stay valued on today's book.
    """
    now = now or clock.now()
    today = exchange_today(now)
    first_tx = transactions_repo.earliest_transaction_date(session)
    start = range_start(range_key, today, first_tx)
    eur_payload = overview["EUR"]
    on_raw = eur_payload.get("kpis", {}).get("daily_growth_as_of")
    on = date.fromisoformat(str(on_raw)[:10]) if on_raw else today
    book = fx_scenarios.book_from_holdings(metrics_service.book_holdings(session, on))
    daily = sorted(
        (d, r) for d, r in fx_service.get_settled_rates(session).items() if r > 0 and d <= today
    )
    window = currency_range.resolve(range_key, today, first_tx)
    in_range = [(d, r) for d, r in daily if d >= start]
    # Measured from the close the range starts from, as every Currency section is
    # (1D: yesterday's close to now), so a short range never collapses to one point.
    anchor = currency_range.start_rate(daily, window)
    if anchor is not None and (not in_range or anchor[0] < in_range[0][0]):
        in_range = [anchor, *in_range]
    extremes = fx_trend.range_extremes(in_range)
    start_rate = in_range[0][1] if in_range else None
    start_on = in_range[0][0] if in_range else None
    cushion = _cushion(session, today, start)
    monthly = investing_power_service.get_amount_eur(session)

    out: dict[str, dict[str, Any]] = {}
    for ccy in ("EUR", "USD"):
        cur = overview[ccy]["currency"]
        life, today_block = cur["lifetime"], cur["today"]
        spot = _d(today_block.get("spot"))
        avg = _d(life.get("avg_invest_rate"))
        be = _d(life.get("breakeven_rate"))
        side = "EUR" if ccy == "EUR" else "USD"
        other = "USD" if ccy == "EUR" else "EUR"
        # EUR view = value (cashing out the dollars held); USD view = investing (what the
        # euros you send in buy). Equivalent, inverted: strong dollar good / strong euro good.
        invest = Invest(monthly, monthly) if ccy == "USD" else None
        inverse = QUOTES[ccy]["field"] == "inverse"
        grid = _grid(spot, ccy, inverse=inverse)
        shown_grid = [q for q, _r in grid]
        payload: dict[str, Any] = {
            "ccy": ccy,
            "as_of": overview[ccy].get("as_of"),
            "generated_at": now.isoformat(),
            "quote": QUOTES[ccy],
            "step": dec(STEP),
            "min_rate": dec(shown_grid[0]),
            "max_rate": dec(shown_grid[-1]),
            "rate_now": _rv(spot),
            "avg_rate": _rv(avg),
            "breakeven": _rv(be),
            "rows": [_row(book, q, r, ccy, avg, be, other, invest, spot) for q, r in grid],
            "cushion": cushion,
            "range": range_key,
            "window": window.to_dict(),
            "range_start": start.isoformat(),
            "perspective": "invest" if invest else "value",
            "invest": (
                {"unit_eur": dec(invest.unit), "monthly_eur": dec(invest.monthly)}
                if invest
                else None
            ),
            "other_ccy": other,
        }
        marks: list[dict[str, Any]] = []
        lows_highs: dict[str, tuple[date, Decimal, Decimal]] = {}

        def worth_at(rate: Decimal, invest: Invest | None = invest, side: str = side) -> Decimal:
            # Value view: the book at that rate. Investing view: what the euro unit buys.
            return invest.unit * rate if invest else fx_scenarios.value_at(book, rate, side)

        # "Low" and "high" describe the quote shown: the lowest USD/EUR is the highest
        # EUR/USD, so the inverse side swaps the two ends.
        low_end, high_end = ("high", "low") if inverse else ("low", "high")
        for key, rate, on_day in (
            ("average", avg, None),
            ("breakeven", be, None),
            ("today", spot, None),
            ("range_start", start_rate, start_on),
            (
                "historic_low",
                getattr(extremes, low_end) if extremes else None,
                getattr(extremes, f"{low_end}_at") if extremes else None,
            ),
            (
                "historic_high",
                getattr(extremes, high_end) if extremes else None,
                getattr(extremes, f"{high_end}_at") if extremes else None,
            ),
        ):
            _add_mark(marks, lows_highs, (key, rate, on_day), ccy, shown_grid, worth_at)
        payload["marks"] = marks
        sensitivity: dict[str, Any] | None = None
        if spot is not None and spot > 0:
            value_now = fx_scenarios.value_at(book, spot, side)
            # One cent of the quote shown (0.01 USD/EUR on the euro side).
            plus = fx_scenarios.value_at(
                book, fx_scenarios.one_cent_rate(spot, inverse=inverse), side
            )
            payload["value_now"] = dec(value_now)
            payload["value_now_other"] = dec(fx_scenarios.value_at(book, spot, other))
            payload["stress"] = _stress(book, spot, ccy, inverse=inverse, invest=invest)
            if invest:
                # One cent of EUR/USD on the regular euros sent in.
                now_buy = invest.monthly * spot
                plus_buy = invest.monthly * fx_scenarios.one_cent_rate(spot, inverse=False)
                value_now, plus = now_buy, plus_buy
            sensitivity = {
                "rate": dec(spot),
                "value_at_rate": dec(value_now),
                "value_at_rate_plus": dec(plus),
                "change": dec(plus - value_now),
            }
        payload["sensitivity"] = sensitivity
        payload["stats"] = _stats(
            ccy,
            sensitivity=sensitivity,
            spot=spot,
            be=be,
            lows_highs=lows_highs,
            cushion=cushion,
        )
        out[ccy] = payload
    return out


__all__ = [
    "INVERSE_MAX_RATE",
    "INVERSE_MIN_RATE",
    "MAX_RATE",
    "MIN_RATE",
    "STEP",
    "build_scenarios_both",
]
