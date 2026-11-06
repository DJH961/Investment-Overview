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
from typing import Literal

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

    # Zero-span guard: if every cashflow (including the terminal) falls on a
    # single date, the discount factor ``(1 + rate) ** years`` is identical
    # (``years`` is constant) for all of them, so NPV is rate-independent and
    # there is no unique IRR. The Newton loop below would otherwise return the
    # initial ``guess`` (0.10) on the first iteration whenever the amounts net
    # to ~0, silently inventing a rate. Report "undefined" instead.
    if len({cf.date for cf in flows}) < 2:
        return None

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
    negative end values (the formula's real-valued domain). A *total loss*
    (``end_value == 0``) is well-defined: the holding lost everything, so the
    CAGR is exactly −100 % rather than ``None``.
    """
    if start_value <= 0 or end_value < 0 or days <= 0:
        return None
    if end_value == 0:
        # A wipeout (€10k → €0) is a clean −100 % compound rate; the power
        # formula below would divide-by-zero / take log(0), so short-circuit.
        return Decimal(-1)
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


def capital_gain_excl_income(total_return: Decimal, dividend_income: Decimal) -> Decimal:
    """Capital gain = total return minus all dividend income (cash and reinvested).

    The one definition behind the Overview and Holdings "Capital gain": realised
    plus unrealised price gain after fees, with no dividends in it. Every
    distribution is income exactly once (cash paid out or reinvested), so
    ``capital_gain + dividend_income == total_return`` holds by construction.
    All inputs are in the same currency, each built from that currency's own legs.
    """
    return total_return - dividend_income


# -----------------------------------------------------------------------------
# Total Growth (compounded XIRR) — v2.5 canonical headline metric
# -----------------------------------------------------------------------------


def years_between(start: date, end: date) -> Decimal:
    """Calendar years between ``start`` and ``end`` (``end`` inclusive).

    Uses :data:`DAYS_PER_CALENDAR_YEAR` (365.25) so leap years average out.
    Returns ``Decimal(0)`` when ``end <= start``.
    """
    days = (end - start).days
    if days <= 0:
        return Decimal(0)
    return Decimal(days) / DAYS_PER_CALENDAR_YEAR


def total_growth_pct_compounded(
    xirr_rate: Decimal | None,
    years: Decimal,
) -> Decimal | None:
    """Cumulative growth implied by ``xirr_rate`` over ``years``.

    Headline metric across the v2.5 UI: "what XIRR-implied compound
    return would you have realised over the time you've actually been
    invested?" Formula::

        (1 + xirr) ** years - 1

    This is "XIRR × time" expressed correctly (compounded, not
    multiplied) and degrades gracefully:

    * Returns ``None`` if ``xirr_rate`` is ``None`` (insufficient data
      for an XIRR root) or if ``years <= 0``.
    * Returns ``None`` if ``1 + xirr_rate <= 0`` (catastrophic loss
      below -100% — the real-valued power would be undefined).

    The computation goes through ``float`` because ``Decimal`` has no
    general fractional power; the result is round-tripped back through
    ``Decimal(repr(...))`` to keep the public type stable.
    """
    if xirr_rate is None or years <= 0:
        return None
    base = Decimal(1) + xirr_rate
    if base <= 0:
        return None
    grown = float(base) ** float(years)
    if math.isnan(grown) or math.isinf(grown):
        return None
    return Decimal(repr(grown)) - Decimal(1)


# -----------------------------------------------------------------------------
# Window growth (the "+x.xx% 1M" headline beside the value graph)
# -----------------------------------------------------------------------------

#: How a window's growth is measured:
#:
#: * ``"reference"`` — ``(closing - reference) / reference``: the 1D move from the
#:   previous session's close (the dashed reference line on the intraday graph);
#: * ``"simple"`` — the Modified Dietz period return (1W: short enough that the
#:   timing of a cashflow barely matters);
#: * ``"xirr"`` — the window's money-weighted rate (opening value as the initial
#:   investment, every external flow at its own date, closing value as the
#:   terminal flow) compounded back over the window length (1M … 1Y);
#: * ``"total"`` — the lifetime compounded total growth (ALL; computed elsewhere,
#:   listed so callers share one vocabulary).
GrowthMode = Literal["reference", "simple", "xirr", "total"]


@dataclass(frozen=True)
class WindowGrowth:
    """A window's growth as a fraction and the mode that actually produced it.

    ``mode`` differs from the requested one only when the XIRR solver could not
    find a root and the Modified Dietz figure was used instead (``"simple"``).
    """

    pct: Decimal
    mode: GrowthMode


def _in_window(flows: Sequence[Cashflow], start: date, end: date) -> list[Cashflow]:
    """External flows strictly after ``start`` and on/before ``end``.

    A flow dated on the opening day is already inside the opening value (the
    window opens at that day's close), so it is not counted again.
    """
    return [cf for cf in flows if start < cf.date <= end and cf.amount != 0]


def _solves(rate: Decimal, stream: Sequence[Cashflow], as_of: date, terminal: Decimal) -> bool:
    """Whether ``rate`` really zeroes the stream's NPV (the solver can stall on a
    bracket edge for extreme short-window rates and return a non-root)."""
    flows = [*stream, Cashflow(date=as_of, amount=terminal)]
    scale = sum(abs(float(cf.amount)) for cf in flows) or 1.0
    try:
        residual = _npv(float(rate), flows, as_of)
    except (OverflowError, ZeroDivisionError):
        return False
    return not math.isnan(residual) and abs(residual) <= 1e-6 * scale


def modified_dietz(
    *,
    opening_date: date,
    opening_value: Decimal,
    closing_date: date,
    closing_value: Decimal,
    flows: Sequence[Cashflow] = (),
) -> Decimal | None:
    """Modified Dietz return over ``[opening_date, closing_date]``.

    ``flows`` use this module's sign convention (money *into* the portfolio is
    negative), so the net contribution is ``F = -sum(amount)``. Each flow is
    weighted by the share of the window it was invested for::

        (closing - opening - F) / (opening + sum(-amount_i * w_i)),
        w_i = (closing_date - date_i) / (closing_date - opening_date)

    With no flows this is exactly ``closing / opening - 1``. Returns ``None`` on a
    non-positive denominator (nothing invested to grow from).
    """
    window = _in_window(flows, opening_date, closing_date)
    span = (closing_date - opening_date).days
    net_in = -sum((cf.amount for cf in window), start=Decimal(0))
    weighted = Decimal(0)
    for cf in window:
        weight = Decimal((closing_date - cf.date).days) / Decimal(span) if span > 0 else Decimal(0)
        weighted += -cf.amount * weight
    denom = opening_value + weighted
    if denom <= 0:
        return None
    return (closing_value - opening_value - net_in) / denom


def window_growth(
    *,
    mode: GrowthMode,
    opening_date: date,
    opening_value: Decimal | None,
    closing_date: date,
    closing_value: Decimal | None,
    flows: Sequence[Cashflow] = (),
    reference: Decimal | None = None,
) -> WindowGrowth | None:
    """Growth over one graph window, in the currency of its inputs.

    Every input must be in **one** currency: the series and its cashflows (each
    at its own date's rate) — a growth is never computed in one currency and
    converted into another. ``mode`` picks the formula (see :data:`GrowthMode`);
    ``"total"`` is not computed here and returns ``None``.

    * ``"reference"`` needs ``reference`` > 0 (the previous close);
    * ``"simple"`` is :func:`modified_dietz`;
    * ``"xirr"`` solves :func:`xirr` on ``[-opening at opening_date, flows…,
      +closing at closing_date]`` and compounds the rate over the window on the
      solver's own 365-day year, so a window without flows reads exactly
      ``closing / opening - 1``; it falls back to Modified Dietz (reported as
      ``"simple"``) when the solver finds no root.

    Returns ``None`` when the window has no usable opening/closing value.
    """
    if closing_value is None:
        return None
    if mode == "reference":
        if reference is None or reference <= 0:
            return None
        return WindowGrowth((closing_value - reference) / reference, "reference")
    if mode == "total" or opening_value is None or opening_value <= 0:
        return None
    if closing_date < opening_date:
        return None
    simple = modified_dietz(
        opening_date=opening_date,
        opening_value=opening_value,
        closing_date=closing_date,
        closing_value=closing_value,
        flows=flows,
    )
    if mode == "simple" or closing_date == opening_date:
        return WindowGrowth(simple, "simple") if simple is not None else None
    stream = [
        Cashflow(date=opening_date, amount=-opening_value),
        *_in_window(flows, opening_date, closing_date),
    ]
    rate = xirr(stream, closing_date, terminal_value=closing_value)
    if (
        rate is not None
        and Decimal(1) + rate > 0
        and _solves(rate, stream, closing_date, closing_value)
    ):
        years = (closing_date - opening_date).days / DAYS_PER_YEAR_FLOAT
        grown = float(Decimal(1) + rate) ** years
        if not (math.isnan(grown) or math.isinf(grown)):
            return WindowGrowth(Decimal(repr(grown)) - Decimal(1), "xirr")
    return WindowGrowth(simple, "simple") if simple is not None else None
