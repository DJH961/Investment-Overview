"""What a different EUR/USD rate would do to the book (pure, v7.2 "What if").

Every figure is a **single-instant valuation** of today's book at an assumed rate
(the currency rule allows a value at one rate; no return is converted).

The book is split by native currency, exactly as
:func:`domain.late_data.value_at_rate` values it:

* ``usd``: the native-dollar holdings;
* ``eur``: the native-euro holdings plus any other currency at its EUR mark
  (``eur_fallback``), which ``value_at_rate`` also treats as euros.

At a rate ``r`` (USD per 1 EUR):

* value in EUR: ``eur + usd / r``; value in USD: ``usd + eur · r``;
* **currency gain** against the average rate ``a``: the holdings whose native
  currency is *not* the reporting one, valued at ``r`` minus at ``a``. EUR:
  ``usd / r − usd / a``; USD: ``eur · r − eur · a``. Zero at ``r = a`` (the
  break-even rate). For a pure-dollar book the EUR gain at today's rate is the
  Overview's ``fx_pnl_eur`` formula (``value_eur − value_usd / avg``).

Everything is :class:`~decimal.Decimal`; nothing here does I/O.
"""

from __future__ import annotations

import itertools
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Literal, Protocol

Ccy = Literal["EUR", "USD"]

ZERO = Decimal(0)
ONE = Decimal(1)
ONE_CENT = Decimal("0.01")
SLIDER_MIN = Decimal("0.90")
SLIDER_MAX = Decimal("1.60")
SLIDER_STEP = Decimal("0.005")
#: The slider's grid when the page shows the inverse quote (USD/EUR: euros per dollar):
#: it covers the same 0.90..1.60 EUR/USD span, evenly spaced in the quote shown.
INVERSE_SLIDER_MIN = Decimal("0.62")
INVERSE_SLIDER_MAX = Decimal("1.12")
RATE_DP = Decimal("0.000000000001")
STRESS_SHIFTS: tuple[Decimal, ...] = (
    Decimal("-0.15"),
    Decimal("-0.10"),
    Decimal("-0.05"),
    Decimal("0.05"),
    Decimal("0.10"),
    Decimal("0.15"),
)


class NativeHolding(Protocol):
    """What :class:`domain.late_data.Holding` provides."""

    @property
    def currency(self) -> str: ...
    @property
    def native_value(self) -> Decimal: ...
    @property
    def eur_fallback(self) -> Decimal: ...


@dataclass(frozen=True)
class Book:
    #: Native-dollar holdings.
    usd: Decimal
    #: Native-euro holdings plus other currencies at their EUR mark.
    eur: Decimal


def book_from_holdings(holdings: Iterable[NativeHolding]) -> Book:
    """Split holdings by native currency (the ``value_at_rate`` convention)."""
    usd = eur = ZERO
    for h in holdings:
        ccy = h.currency.upper()
        if ccy == "USD":
            usd += h.native_value
        elif ccy == "EUR":
            eur += h.native_value
        else:
            eur += h.eur_fallback
    return Book(usd=usd, eur=eur)


def _check(rate: Decimal) -> None:
    if rate <= 0:
        raise ValueError("rate must be positive")


def value_at(book: Book, rate: Decimal, ccy: Ccy) -> Decimal:
    """The book in ``ccy`` at ``rate`` (USD per 1 EUR)."""
    _check(rate)
    if ccy == "EUR":
        return book.eur + book.usd / rate
    return book.usd + book.eur * rate


def gain_at(book: Book, rate: Decimal, avg_rate: Decimal, ccy: Ccy) -> Decimal:
    """Currency gain in ``ccy`` at ``rate`` against ``avg_rate`` (zero at ``avg_rate``)."""
    _check(rate)
    _check(avg_rate)
    if ccy == "EUR":
        return book.usd / rate - book.usd / avg_rate
    return book.eur * rate - book.eur * avg_rate


def slider_rates(
    lo: Decimal = SLIDER_MIN, hi: Decimal = SLIDER_MAX, step: Decimal = SLIDER_STEP
) -> list[Decimal]:
    """``lo, lo + step, …, hi`` (``hi`` included when it lies on the grid)."""
    if step <= 0 or lo <= 0 or hi < lo:
        raise ValueError("need 0 < lo <= hi and step > 0")
    n = int((hi - lo) / step)
    return [lo + step * i for i in range(n + 1)]


def nearest_index(rates: Sequence[Decimal], rate: Decimal) -> int:
    """Index of the slider row closest to ``rate`` (the lower one on a tie)."""
    if not rates:
        raise ValueError("no rates")
    return min(range(len(rates)), key=lambda i: (abs(rates[i] - rate), i))


def stress_rates(
    rate: Decimal, shifts: Sequence[Decimal] = STRESS_SHIFTS, *, inverse: bool = False
) -> list[Decimal]:
    """The EUR/USD rate (USD per 1 EUR) after each shift of the quote shown.

    ``inverse = False``: the quote is EUR/USD, so ``rate · (1 + s)``. ``inverse = True``:
    the quote is USD/EUR (``1 / rate``) moved by ``s``, i.e. ``rate / (1 + s)``.
    """
    _check(rate)
    if inverse:
        return [rate / (ONE + s) for s in shifts]
    return [rate * (ONE + s) for s in shifts]


def quote_slider(inverse: bool = False) -> list[tuple[Decimal, Decimal]]:
    """``[(quote value, EUR/USD rate)]`` on the grid of the quote shown, ascending in the quote.

    EUR/USD: the 0.90..1.60 grid itself. USD/EUR (``inverse``): 0.62..1.12 in steps of
    0.005, each paired with its EUR/USD rate ``1 / quote``.
    """
    if not inverse:
        return [(r, r) for r in slider_rates()]
    return [
        (q, (ONE / q).quantize(RATE_DP))
        for q in slider_rates(INVERSE_SLIDER_MIN, INVERSE_SLIDER_MAX, SLIDER_STEP)
    ]


def one_cent_rate(rate: Decimal, *, inverse: bool = False) -> Decimal:
    """The EUR/USD rate after the quote shown rises by one cent (0.01 of the quote)."""
    _check(rate)
    if inverse:
        return ONE / (ONE / rate + ONE_CENT)
    return rate + ONE_CENT


def weekday_returns(
    points: Sequence[tuple[date, Decimal]],
) -> list[tuple[date, Decimal]]:
    """Returns of a growth index from one weekday to the next (weekends dropped).

    ``points`` is ``[(date, index)]`` oldest first; each weekday row is compared
    with the previous weekday row. A non-positive start value is skipped.
    """
    days = [(d, v) for d, v in points if d.weekday() < 5]
    return [(b[0], b[1] / a[1] - ONE) for a, b in itertools.pairwise(days) if a[1] > 0]


@dataclass(frozen=True)
class DownDays:
    down_days: int
    dollar_rose: int

    @property
    def share(self) -> Decimal | None:
        return Decimal(self.dollar_rose) / self.down_days if self.down_days else None


def dollar_on_down_days(
    returns: Sequence[tuple[date, Decimal]], rates: Mapping[date, Decimal]
) -> DownDays:
    """On how many down days (return < 0) did the dollar rise against the euro?

    Only days with a fixing of their own and an earlier fixing are counted (a
    down day on an ECB holiday has no rate move to compare). The dollar rose on
    ``d`` when ``d``'s rate (USD per 1 EUR) is below the previous fixing's.
    """
    dates = sorted(d for d, r in rates.items() if r > 0)
    position = {d: i for i, d in enumerate(dates)}
    down = rose = 0
    for d, ret in returns:
        i = position.get(d)
        if ret >= 0 or i is None or i == 0:
            continue
        down += 1
        if rates[d] < rates[dates[i - 1]]:
            rose += 1
    return DownDays(down_days=down, dollar_rose=rose)


__all__ = [
    "INVERSE_SLIDER_MAX",
    "INVERSE_SLIDER_MIN",
    "SLIDER_MAX",
    "SLIDER_MIN",
    "SLIDER_STEP",
    "STRESS_SHIFTS",
    "Book",
    "DownDays",
    "NativeHolding",
    "book_from_holdings",
    "dollar_on_down_days",
    "gain_at",
    "nearest_index",
    "one_cent_rate",
    "quote_slider",
    "slider_rates",
    "stress_rates",
    "value_at",
    "weekday_returns",
]
