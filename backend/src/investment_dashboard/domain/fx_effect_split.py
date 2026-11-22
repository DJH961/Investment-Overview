"""More splits of the currency effect (pure, v7.2): market hours and per holding.

Built on :mod:`domain.fx_attribution` (same conversions, same exactness rules):

* :func:`session_split`: one day's currency part split at the US sessions that lie
  between its two fixings. With the previous fixing ``A``, each session's open
  ``O_i`` and close ``C_i`` and today's fixing ``D``, on the day's (close) book:
  ``outside = (A -> O_1) + (C_1 -> O_2) + ... + (C_k -> D)`` and
  ``inside = sum (O_i -> C_i)``. The legs telescope, so ``inside + outside`` is the
  day's currency part exactly.
* :func:`holding_split`: one holding's change over a range in three parts, each
  day at its own rate: ``currency`` = the day's value revalued from the previous
  day's rate to the day's; ``dividends`` = paid that day at the day's rate;
  ``price`` = the rest of the change after the money put in (buys minus sells
  plus reinvested dividends) at the day's rate. ``price + dividends + currency ==
  total`` exactly.

Money is a sum of reporting-currency amounts at their own dates; nothing here is
a return.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from investment_dashboard.domain.fx_attribution import (
    ZERO,
    FxRate,
    SessionLegs,
    exact_context,
    revaluation,
)

Rates = Mapping[str, FxRate]


def session_split(
    book: Mapping[str, Decimal],
    reporting: str,
    *,
    prev_rates: Rates,
    sessions: Sequence[tuple[Rates, Rates]],
    cur_rates: Rates,
) -> SessionLegs:
    """Split ``prev_rates -> cur_rates`` on ``book`` at the ``(open, close)`` sessions."""
    outside = ZERO
    inside = ZERO
    with exact_context():
        here = prev_rates
        for open_rates, close_rates in sessions:
            outside += revaluation(book, reporting, rates_from=here, rates_to=open_rates)
            inside += revaluation(book, reporting, rates_from=open_rates, rates_to=close_rates)
            here = close_rates
        outside += revaluation(book, reporting, rates_from=here, rates_to=cur_rates)
        currency = outside + inside
    return SessionLegs(outside=outside, inside=inside, currency=currency)


@dataclass(frozen=True)
class HoldingDay:
    """One holding on one day, native: value at the close, money in, dividends paid."""

    on: date
    value: Decimal
    #: Buys minus sells plus reinvested dividends (money that went into the holding).
    inflow: Decimal = ZERO
    dividends: Decimal = ZERO


@dataclass(frozen=True)
class HoldingSplit:
    """``price + dividends + currency == total`` in the reporting currency."""

    price: Decimal
    dividends: Decimal
    currency: Decimal
    total: Decimal


def holding_split(
    start_value: Decimal,
    start_rate: FxRate,
    days: Sequence[tuple[HoldingDay, FxRate]],
) -> HoldingSplit:
    """The three parts over ``days`` (ascending), from ``start_value`` at ``start_rate``.

    Use ``FxRate()`` (identity) for a holding in the reporting currency: its
    currency part is then zero.
    """
    price = dividends = currency = ZERO
    prev_value, prev_rate = start_value, start_rate
    with exact_context():
        for day, rate in days:
            end = rate.to_reporting(day.value)
            start = prev_rate.to_reporting(prev_value)
            move = end - prev_rate.to_reporting(day.value)
            inflow = rate.to_reporting(day.inflow)
            paid = rate.to_reporting(day.dividends)
            currency += move
            dividends += paid
            price += end - start - move - inflow
            prev_value, prev_rate = day.value, rate
        total = price + dividends + currency
    return HoldingSplit(price=price, dividends=dividends, currency=currency, total=total)
