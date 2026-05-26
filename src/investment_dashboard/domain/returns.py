"""Return / growth metrics — XIRR, TWR, CAGR, and simple growth variants.

All functions in this module are pure (no I/O, no DB). They take primitive
inputs (lists of :class:`Cashflow`, daily value series, etc.) and return
:class:`decimal.Decimal` or ``None``. See spec §6 for definitions and the
spreadsheet columns that each one parallels.

Conventions for cashflows (spec §6.2):
    * **Contributions** *into* the portfolio (``buy``, ``deposit``) are
      **negative** numbers (money leaving the user's wallet).
    * **Withdrawals** *out* of the portfolio (``sell``, ``dividend_cash``,
      ``interest``, ``withdrawal``) are **positive** numbers.
    * The terminal mark-to-market value is appended as a single **positive**
      cashflow on ``as_of``.

A ``dividend_reinvest`` event has ``amount = 0`` from the XIRR perspective
(no external cash moved); its effect appears only in the terminal value.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from itertools import pairwise

DAYS_PER_YEAR = Decimal("365.0")
DAYS_PER_YEAR_FLOAT = 365.0
DAYS_PER_CALENDAR_YEAR = Decimal("365.25")  # for CAGR (handles leap years)


@dataclass(frozen=True)
class Cashflow:
    """One signed cashflow on a given date.

    ``amount`` is in whatever currency the caller is computing in (USD, EUR,
    …). It is the caller's responsibility to feed in a homogeneous series.
    """

    date: date
    amount: Decimal


# -----------------------------------------------------------------------------
# XIRR
# -----------------------------------------------------------------------------


def _npv(rate: float, cashflows: Sequence[Cashflow], as_of: date) -> float:
    """Net present value of ``cashflows`` evaluated at ``as_of``.

    Each cashflow is grown forward to ``as_of`` at ``rate``:
    ``cf * (1 + rate) ** years_until_as_of``. With the sign convention
    (contributions negative, withdrawals + terminal positive), the XIRR
    root is the rate at which the present value of contributions equals
    the present value of returns at ``as_of``.
    """
    base = 1.0 + rate
    total = 0.0
    for cf in cashflows:
        years = (as_of - cf.date).days / DAYS_PER_YEAR_FLOAT
        total += float(cf.amount) * (base**years)
    return total


def _npv_derivative(rate: float, cashflows: Sequence[Cashflow], as_of: date) -> float:
    base = 1.0 + rate
    total = 0.0
    for cf in cashflows:
        years = (as_of - cf.date).days / DAYS_PER_YEAR_FLOAT
        if years == 0:
            continue
        total += years * float(cf.amount) * (base ** (years - 1.0))
    return total


def xirr(
    cashflows: Sequence[Cashflow],
    as_of: date,
    *,
    terminal_value: Decimal | None = None,
    guess: float = 0.10,
    tol: float = 1e-7,
    max_iter: int = 100,
) -> Decimal | None:
    """Annualised internal rate of return for an irregular cashflow stream.

    If ``terminal_value`` is given, it is appended as a positive cashflow on
    ``as_of`` — the typical use case. Pass ``None`` if the caller has
    already encoded the terminal mark-to-market in ``cashflows``.

    Returns ``None`` when:
        * fewer than two cashflows after combining with the terminal,
        * all cashflows share the same sign (no sign change ⇒ no root),
        * the solver fails to converge.

    Algorithm: Newton-Raphson seeded at ``guess``, with a bisection fallback
    on the bracket ``[-0.999, 100.0]`` if Newton diverges. This is more
    robust than calling ``scipy.optimize.brentq`` directly because we avoid
    a hard requirement that ``f(-0.999)`` and ``f(100)`` have opposite
    signs (which can fail numerically on long horizons).
    """
    flows: list[Cashflow] = list(cashflows)
    if terminal_value is not None and terminal_value != 0:
        flows.append(Cashflow(date=as_of, amount=terminal_value))
    if len(flows) < 2:
        return None

    signs = {1 if cf.amount > 0 else -1 if cf.amount < 0 else 0 for cf in flows}
    signs.discard(0)
    if len(signs) < 2:
        return None  # degenerate: all same sign

    # --- Newton-Raphson ---
    rate = guess
    for _ in range(max_iter):
        f = _npv(rate, flows, as_of)
        if abs(f) < tol:
            return Decimal(repr(rate))
        fp = _npv_derivative(rate, flows, as_of)
        if fp == 0:
            break
        next_rate = rate - f / fp
        if next_rate <= -0.9999:
            # Step would land below -100% — back off toward bracket lower end.
            next_rate = (rate + -0.9999) / 2.0
        if math.isnan(next_rate) or math.isinf(next_rate):
            break
        if abs(next_rate - rate) < tol:
            return Decimal(repr(next_rate))
        rate = next_rate

    # --- Bisection fallback ---
    lo, hi = -0.9999, 100.0
    f_lo = _npv(lo, flows, as_of)
    f_hi = _npv(hi, flows, as_of)
    if math.isnan(f_lo) or math.isnan(f_hi) or f_lo * f_hi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2.0
        f_mid = _npv(mid, flows, as_of)
        if abs(f_mid) < tol or (hi - lo) < tol:
            return Decimal(repr(mid))
        if f_lo * f_mid < 0:
            hi, f_hi = mid, f_mid
        else:
            lo, f_lo = mid, f_mid
    return Decimal(repr((lo + hi) / 2.0))


# -----------------------------------------------------------------------------
# TWR
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class DailyValuation:
    """Portfolio market value at end-of-day, *before* that day's cashflows."""

    date: date
    value: Decimal


def twr(
    daily_values: Sequence[DailyValuation],
    cashflows: Sequence[Cashflow],
) -> Decimal | None:
    """Daily-snapshot time-weighted return over ``daily_values``.

    The TWR formula chains sub-period returns bounded by cashflow events.
    Each sub-period return is::

        r_i = (V_end - V_start_after_cashflow) / V_start_after_cashflow

    where ``V_start_after_cashflow`` is the closing value of the prior day
    *plus* any cashflow occurring on that day. Final TWR = ∏(1 + r_i) − 1.

    Returns ``None`` if fewer than two valuations or if any intermediate
    "start after cashflow" value is zero (no meaningful denominator).
    """
    if len(daily_values) < 2:
        return None

    cf_by_day: dict[date, Decimal] = {}
    for cf in cashflows:
        cf_by_day[cf.date] = cf_by_day.get(cf.date, Decimal(0)) + cf.amount

    growth = Decimal(1)
    for prev, curr in pairwise(daily_values):
        # Cashflow sign convention: negative = contribution INTO portfolio,
        # positive = withdrawal OUT. So the portfolio gained ``-cf`` of new
        # money on that day, after which it grew to ``curr.value``.
        cf_today = cf_by_day.get(curr.date, Decimal(0))
        start = prev.value + (-cf_today)
        if start == 0:
            return None
        r = (curr.value - start) / start
        growth *= Decimal(1) + r

    return growth - Decimal(1)


def annualize_return(total_return: Decimal, days: int) -> Decimal | None:
    """Annualise a cumulative return over ``days`` calendar days.

    ``(1 + total_return) ** (365 / days) - 1`` — see spec §6.3.
    """
    if days <= 0:
        return None
    base = Decimal(1) + total_return
    if base <= 0:
        return None
    exponent = DAYS_PER_YEAR / Decimal(days)
    # Decimal has no general power; cast through float — acceptable for
    # display-side annualisation.
    return Decimal(repr(float(base) ** float(exponent))) - Decimal(1)


# -----------------------------------------------------------------------------
# CAGR
# -----------------------------------------------------------------------------


def cagr(start_value: Decimal, end_value: Decimal, days: int) -> Decimal | None:
    """Compound annual growth rate.

    ``(V_end / V_start) ** (1 / years) - 1`` with ``years = days / 365.25``.
    Returns ``None`` for non-positive start values, zero-length windows, or
    negative end values (the formula's real-valued domain).
    """
    if start_value <= 0 or end_value <= 0 or days <= 0:
        return None
    years = Decimal(days) / DAYS_PER_CALENDAR_YEAR
    ratio = float(end_value / start_value)
    return Decimal(repr(ratio ** float(Decimal(1) / years))) - Decimal(1)


# -----------------------------------------------------------------------------
# Simple growth variants (spec §6.5)
# -----------------------------------------------------------------------------


def total_growth_pct(
    contributions: Decimal,
    current_value: Decimal,
) -> Decimal | None:
    """``(V_today - contributions) / contributions``.

    "How much more do I have than I put in." Mirrors the spreadsheet's
    ``Lots!AH``. ``contributions`` is the **positive** total of all
    deposits and buys (i.e. the absolute value of net contributions).
    Returns ``None`` if ``contributions`` is zero.
    """
    if contributions == 0:
        return None
    return (current_value - contributions) / contributions


def capital_gain(
    contributions: Decimal,
    current_value: Decimal,
    cumulative_dividends_cash: Decimal = Decimal(0),
) -> Decimal:
    """Absolute capital gain in the input currency.

    ``current_value + cumulative_cash_dividends - contributions``. Cash
    dividends that were *reinvested* are not added — they are already in
    ``current_value`` via the new shares they bought.
    """
    return current_value + cumulative_dividends_cash - contributions
