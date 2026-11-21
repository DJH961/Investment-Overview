"""Per-instrument attribution to portfolio return.

Given each holding's start / end value and the net contribution made to
that holding over the window, produce one row per instrument with:

* the **absolute** P&L (``end − start − contributions``),
* its **share of the total P&L** (``pnl_i / Σ pnl``, 7.1 P17),
* its **own return** over the window (Modified Dietz on the row's own flows), and
* the deprecated **contribution to total return** (``pnl_i / starting_total_value``).

The P&L column sums to the portfolio's own absolute P&L, and ``share_of_pnl``
sums to 1, so the table doubles as a sanity check on the headline KPIs.

Inputs are pure :class:`decimal.Decimal` numbers in a single common
currency — the caller is responsible for FX-converting per-instrument
balances first (see :func:`investment_dashboard.services.snapshots_service.
get_or_compute_in_currency` for the equivalent at the portfolio level).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

ZERO = Decimal(0)
#: ``share_of_pnl`` is withheld when the total P&L is smaller than this fraction
#: of the average capital: a near-zero total makes every share explode.
SHARE_MIN_TOTAL_FRACTION = Decimal("0.005")

#: One dated money movement **into** the holding (buy +, sell −, paid-out cash
#: dividend −), already in the common currency at its own date's rate.
Flow = tuple[date, Decimal]


@dataclass(frozen=True)
class InstrumentReturn:
    """Per-instrument inputs to attribution math."""

    instrument_id: int
    symbol: str
    start_value: Decimal
    end_value: Decimal
    net_contribution: Decimal
    dividends_cash: Decimal = ZERO
    #: Dated flows inside ``(start, end]`` (they sum to
    #: ``net_contribution − dividends_cash``); only the Modified Dietz weights
    #: read the dates.
    flows: tuple[Flow, ...] = ()


@dataclass(frozen=True)
class AttributionRow:
    """One instrument's contribution to the portfolio's return."""

    instrument_id: int
    symbol: str
    start_value: Decimal
    end_value: Decimal
    net_contribution: Decimal
    absolute_pnl: Decimal
    #: Deprecated in 7.1 (P17): P&L ÷ the window's start value.
    pct_of_total_return: Decimal | None
    #: P&L ÷ total P&L; ``None`` when the total is too small to divide by.
    share_of_pnl: Decimal | None = None
    #: Modified Dietz return of this row alone; ``None`` without a window or when
    #: the average capital is not positive.
    own_return: Decimal | None = None


def modified_dietz_denominator(
    start_value: Decimal, flows: Iterable[Flow], *, start: date, end: date
) -> Decimal | None:
    """Average capital ``start + Σ w·flow`` with ``w = (end − t) / (end − start)``.

    ``None`` for an empty window (``end <= start``).
    """
    span = (end - start).days
    if span <= 0:
        return None
    total_days = Decimal(span)
    weighted = ZERO
    for day, amount in flows:
        weighted += amount * Decimal((end - day).days) / total_days
    return start_value + weighted


def attribute_portfolio_return(
    rows: Iterable[InstrumentReturn],
    *,
    window: tuple[date, date] | None = None,
) -> list[AttributionRow]:
    """Compute per-instrument attribution rows.

    ``net_contribution`` is the signed sum of external cash that moved
    *into* the instrument during the window (positive = bought more).
    The P&L for instrument ``i`` is::

        pnl_i = end_value_i + dividends_cash_i − start_value_i − net_contribution_i

    The output row's ``net_contribution`` is the money that moved into the
    holding net of the cash dividends it paid out
    (``net_contribution_i − dividends_cash_i``), so every row, and the table
    total, reads ``P&L = End − Start − Net added``. The paid-out dividend lands in
    the cash or money-market row as money moved in, so the dividend is counted
    once (in this holding's P&L) and the column total is the money added from
    outside the book.

    ``share_of_pnl`` is ``pnl_i / Σ pnl``. It is ``None`` when
    ``|Σ pnl| < 0.5 %`` of the portfolio's average capital (the sum of every
    row's Modified Dietz denominator, or the start total — falling back to the
    end total — without a ``window``) and when ``Σ pnl`` is zero.

    ``own_return`` is ``pnl_i / (start_i + Σ w·flow)`` over ``window``
    (Modified Dietz); ``None`` without a window or when that denominator is not
    positive.

    Deprecated: the "% of total return" denominator is the **starting total
    portfolio value** (sum of ``start_value`` across all rows), falling back to
    the end value, else ``None``.
    """
    rows = list(rows)
    total_start = sum((r.start_value for r in rows), start=ZERO)
    total_end = sum((r.end_value for r in rows), start=ZERO)
    denom = total_start if total_start > 0 else total_end if total_end > 0 else ZERO

    pnls = [r.end_value + r.dividends_cash - r.start_value - r.net_contribution for r in rows]
    total_pnl = sum(pnls, start=ZERO)
    own_denoms: list[Decimal | None] = [
        modified_dietz_denominator(r.start_value, r.flows, start=window[0], end=window[1])
        if window is not None
        else None
        for r in rows
    ]
    if window is not None and (window[1] - window[0]).days > 0:
        avg_capital = sum((d for d in own_denoms if d is not None), start=ZERO)
    else:
        avg_capital = denom
    share_ok = total_pnl != 0 and abs(total_pnl) >= SHARE_MIN_TOTAL_FRACTION * avg_capital

    out: list[AttributionRow] = []
    for r, pnl, own_denom in zip(rows, pnls, own_denoms, strict=True):
        pct: Decimal | None = None if denom == 0 else pnl / denom
        own = pnl / own_denom if own_denom is not None and own_denom > 0 else None
        out.append(
            AttributionRow(
                instrument_id=r.instrument_id,
                symbol=r.symbol,
                start_value=r.start_value,
                end_value=r.end_value,
                net_contribution=r.net_contribution - r.dividends_cash,
                absolute_pnl=pnl,
                pct_of_total_return=pct,
                share_of_pnl=pnl / total_pnl if share_ok else None,
                own_return=own,
            )
        )
    out.sort(key=lambda a: abs(a.absolute_pnl), reverse=True)
    return out
