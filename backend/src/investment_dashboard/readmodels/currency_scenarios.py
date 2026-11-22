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

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import fx_scenarios, fx_trend
from investment_dashboard.domain.fx_scenarios import Book
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.domain.returns import growth_index
from investment_dashboard.domain.risk import annualized_volatility, max_drawdown
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.currency_dollar import QUOTES
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import fx_service, metrics_service

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


def _row(
    book: Book,
    shown: Decimal,
    rate: Decimal,
    ccy: str,
    avg: Decimal | None,
    be: Decimal | None,
) -> Any:
    """One slider row: ``shown`` is the quote's value, ``rate`` the EUR/USD rate behind it."""
    side = "EUR" if ccy == "EUR" else "USD"
    be_shown = _display(be, ccy) if be is not None and be > 0 else None
    return {
        "rate": dec(rate),
        "rate_display": dec(shown),
        "value": dec(fx_scenarios.value_at(book, rate, side)),
        "gain": (
            dec(fx_scenarios.gain_at(book, rate, avg, side))
            if avg is not None and avg > 0
            else None
        ),
        # In the quote shown: how far the quote must move to reach break-even.
        "to_breakeven": dec(be_shown - shown) if be_shown is not None else None,
        "to_breakeven_pct": dec(be_shown / shown - ONE) if be_shown is not None else None,
    }


def _cushion(session: Session, today: date) -> dict[str, Any] | None:
    """Volatility and deepest fall per currency + the dollar on the holdings' down days."""
    from investment_dashboard.readmodels.queries.analytics_query import (  # noqa: PLC0415
        CURVE_RECOMPUTE_TAIL_DAYS,
        build_curve,
    )

    first = transactions_repo.earliest_transaction_date(session)
    if first is None or first >= today:
        return None
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


def build_scenarios_both(
    session: Session,
    overview: dict[str, dict[str, Any]],
    *,
    now: datetime | None = None,
) -> dict[str, dict[str, Any]]:
    """``{"EUR": ScenariosOut, "USD": ScenariosOut}`` payloads (plain dicts)."""
    now = now or datetime.now(UTC)
    today = exchange_today(now)
    eur_payload = overview["EUR"]
    on_raw = eur_payload.get("kpis", {}).get("daily_growth_as_of")
    on = date.fromisoformat(str(on_raw)[:10]) if on_raw else today
    book = fx_scenarios.book_from_holdings(metrics_service.book_holdings(session, on))
    daily = sorted(
        (d, r) for d, r in fx_service.get_settled_rates(session).items() if r > 0 and d <= today
    )
    extremes = fx_trend.range_extremes(daily)
    cushion = _cushion(session, today)

    out: dict[str, dict[str, Any]] = {}
    for ccy in ("EUR", "USD"):
        cur = overview[ccy]["currency"]
        life, today_block = cur["lifetime"], cur["today"]
        spot = _d(today_block.get("spot"))
        avg = _d(life.get("avg_invest_rate"))
        be = _d(life.get("breakeven_rate"))
        side = "EUR" if ccy == "EUR" else "USD"
        inverse = QUOTES[ccy]["field"] == "inverse"
        # The grid runs ascending in the quote shown, so the slider reads left to right.
        grid = fx_scenarios.quote_slider(inverse)
        if spot is not None and spot > 0 and grid[0][0] <= _display(spot, ccy) <= grid[-1][0]:
            # Today's own row carries today's exact rate, so the slider rests on today's
            # value (not on the nearest 0.005 step) and "compared with today" reads zero.
            at = fx_scenarios.nearest_index([q for q, _r in grid], _display(spot, ccy))
            grid[at] = (_display(spot, ccy), spot)
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
            "rows": [_row(book, q, r, ccy, avg, be) for q, r in grid],
            "cushion": cushion,
        }
        marks: list[dict[str, Any]] = []
        lows_highs: dict[str, tuple[date, Decimal, Decimal]] = {}
        # "Low" and "high" describe the quote shown: the lowest USD/EUR is the highest
        # EUR/USD, so the inverse side swaps the two ends.
        low_end, high_end = ("high", "low") if inverse else ("low", "high")
        for key, rate, on_day in (
            ("average", avg, None),
            ("breakeven", be, None),
            ("today", spot, None),
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
            if rate is None or rate <= 0:
                continue
            marks.append(
                {
                    "key": key,
                    "rate": dec(rate),
                    "rate_display": dec(_display(rate, ccy)),
                    "date": on_day.isoformat() if on_day else None,
                    "row_index": fx_scenarios.nearest_index(shown_grid, _display(rate, ccy)),
                }
            )
            if on_day is not None:
                lows_highs[key] = (on_day, rate, fx_scenarios.value_at(book, rate, side))
        payload["marks"] = marks
        sensitivity: dict[str, Any] | None = None
        if spot is not None and spot > 0:
            value_now = fx_scenarios.value_at(book, spot, side)
            # One cent of the quote shown (0.01 USD/EUR on the euro side).
            plus = fx_scenarios.value_at(
                book, fx_scenarios.one_cent_rate(spot, inverse=inverse), side
            )
            payload["value_now"] = dec(value_now)
            payload["stress"] = [
                {
                    "shift_pct": dec(s),
                    "rate": dec(r),
                    "rate_display": dec(_display(r, ccy)),
                    "value": dec(fx_scenarios.value_at(book, r, side)),
                    "change": dec(fx_scenarios.value_at(book, r, side) - value_now),
                }
                for s, r in zip(
                    fx_scenarios.STRESS_SHIFTS,
                    fx_scenarios.stress_rates(spot, inverse=inverse),
                    strict=True,
                )
            ]
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
