"""Per-instrument attribution to portfolio return.

Given each holding's start / end value and the net contribution made to
that holding over the window, produce one row per instrument with:

* the **absolute** P&L (``end − start − contributions``), and
* the **contribution to total return** in basis points-of-portfolio
  (``pnl_i / starting_total_value``).

The two columns sum to the portfolio's own absolute P&L and total
return % respectively (modulo rounding), so the table doubles as a
sanity check on the headline KPIs.

Inputs are pure :class:`decimal.Decimal` numbers in a single common
currency — the caller is responsible for FX-converting per-instrument
balances first (see :func:`investment_dashboard.services.snapshots_service.
get_or_compute_in_currency` for the equivalent at the portfolio level).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal

ZERO = Decimal(0)


@dataclass(frozen=True)
class InstrumentReturn:
    """Per-instrument inputs to attribution math."""

    instrument_id: int
    symbol: str
    start_value: Decimal
    end_value: Decimal
    net_contribution: Decimal
    dividends_cash: Decimal = ZERO


@dataclass(frozen=True)
class AttributionRow:
    """One instrument's contribution to the portfolio's return."""

    instrument_id: int
    symbol: str
    start_value: Decimal
    end_value: Decimal
    net_contribution: Decimal
    absolute_pnl: Decimal
    pct_of_total_return: Decimal | None


def attribute_portfolio_return(
    rows: Iterable[InstrumentReturn],
) -> list[AttributionRow]:
    """Compute per-instrument attribution rows.

    ``net_contribution`` is the signed sum of external cash that moved
    *into* the instrument during the window (positive = bought more).
    The P&L for instrument ``i`` is::

        pnl_i = end_value_i + dividends_cash_i − start_value_i − net_contribution_i

    The "% of total return" denominator is the **starting total
    portfolio value** (sum of ``start_value`` across all rows). When
    that's zero we fall back to the absolute end value so a
    brand-new portfolio still produces non-empty percentages; if
    everything is zero the column is ``None``.
    """
    rows = list(rows)
    total_start = sum((r.start_value for r in rows), start=ZERO)
    total_end = sum((r.end_value for r in rows), start=ZERO)
    denom = total_start if total_start > 0 else total_end if total_end > 0 else ZERO

    out: list[AttributionRow] = []
    for r in rows:
        pnl = r.end_value + r.dividends_cash - r.start_value - r.net_contribution
        if denom == 0:
            pct: Decimal | None = None
        else:
            pct = pnl / denom
        out.append(
            AttributionRow(
                instrument_id=r.instrument_id,
                symbol=r.symbol,
                start_value=r.start_value,
                end_value=r.end_value,
                net_contribution=r.net_contribution,
                absolute_pnl=pnl,
                pct_of_total_return=pct,
            )
        )
    out.sort(key=lambda a: abs(a.absolute_pnl), reverse=True)
    return out
