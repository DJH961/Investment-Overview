"""Late data: mutual-fund NAVs that post after the close, and overnight currency.

Pure maths (no I/O, ``Decimal`` only).

A mutual fund's NAV belongs to the session it was struck in: it is the fund's
16:00 New York close, just published late (about 16:00-20:00 New York). So:

* Totals and stored history use **official prices only**.
* The only estimate is the fund part of the **1D intraday line** while the
  session runs: ``prev_value x twin_now / twin_prev_close`` when the fund has an
  ETF twin (:mod:`investment_dashboard.domain.index_twins`), else flat at the
  previous NAV.
* When the official NAV lands, the gap ``official - estimated_close`` is spread
  linearly across that session (0 at the open, all of it at the close), so the
  line starts at the previous close and ends exactly at the official close: no
  spike, no opening gap.

The only genuinely overnight move is the currency: the hero splits the change
in the total into the last session's move (official closes of that session vs
the previous session, each valued at its own session's closing rate) plus the
overnight currency effect (the same holdings at the rate now vs that close).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from itertools import pairwise

ZERO = Decimal(0)
ONE = Decimal(1)

#: Fewest shared daily returns before a typical daily gap is worth showing.
MIN_GAP_SAMPLES = 20


def estimate_value(
    prev_value: Decimal,
    twin_now: Decimal | None,
    twin_prev_close: Decimal | None,
) -> Decimal:
    """The fund's estimated value now: ``prev_value x twin_now / twin_prev_close``.

    Without a usable twin price (missing or not positive) the fund stays flat at
    its previous value.
    """
    if twin_now is None or twin_prev_close is None or twin_now <= 0 or twin_prev_close <= 0:
        return prev_value
    return prev_value * twin_now / twin_prev_close


def session_fraction(at: datetime, open_at: datetime, close_at: datetime) -> Decimal:
    """How far through the session ``at`` is: 0 at (or before) the open, 1 at the close."""
    if close_at <= open_at:
        return ONE
    if at <= open_at:
        return ZERO
    if at >= close_at:
        return ONE
    elapsed = Decimal((at - open_at).total_seconds())
    span = Decimal((close_at - open_at).total_seconds())
    return elapsed / span


def corrected_value(
    estimate_at: Decimal,
    estimate_close: Decimal,
    official_close: Decimal,
    fraction: Decimal,
) -> Decimal:
    """The estimate with the official-vs-estimate gap blended in by ``fraction``.

    ``fraction`` 0 (the open) leaves the estimate; 1 (the close) gives exactly
    the official close, since ``estimate_close + (official - estimate_close)``.
    """
    return estimate_at + (official_close - estimate_close) * fraction


def fund_value_at(
    *,
    prev_value: Decimal,
    official_value: Decimal | None,
    twin_at: Decimal | None,
    twin_close: Decimal | None,
    twin_prev_close: Decimal | None,
    fraction: Decimal,
) -> Decimal:
    """One fund's 1D-line value at one instant of its session.

    ``official_value`` is ``None`` until the session's NAV has posted: the line
    then shows the estimate. Once it has, the estimate gets the linear
    correction so the session ends exactly at ``official_value``.
    """
    estimate = estimate_value(prev_value, twin_at, twin_prev_close)
    if official_value is None:
        return estimate
    estimate_close = estimate_value(prev_value, twin_close, twin_prev_close)
    return corrected_value(estimate, estimate_close, official_value, fraction)


@dataclass(frozen=True)
class Holding:
    """One holding's native value, for valuing a book at a chosen EUR/USD rate.

    ``eur_fallback`` is the holding's EUR value as already computed, used only
    for currencies other than EUR and USD (no EUR/USD rate converts those).
    """

    currency: str
    native_value: Decimal
    eur_fallback: Decimal = ZERO


def value_at_rate(holdings: Iterable[Holding], fx_eur_usd: Decimal) -> tuple[Decimal, Decimal]:
    """``(eur, usd)`` of ``holdings`` at one EUR/USD rate (USD per 1 EUR).

    USD holdings stay FX-free in USD and are divided by the rate for EUR; EUR
    holdings stay as they are in EUR and are multiplied by the rate for USD.
    """
    if fx_eur_usd <= 0:
        raise ValueError("fx_eur_usd must be positive")
    eur = ZERO
    usd = ZERO
    for h in holdings:
        ccy = h.currency.upper()
        if ccy == "USD":
            eur += h.native_value / fx_eur_usd
            usd += h.native_value
        elif ccy == "EUR":
            eur += h.native_value
            usd += h.native_value * fx_eur_usd
        else:
            eur += h.eur_fallback
            usd += h.eur_fallback * fx_eur_usd
    return eur, usd


@dataclass(frozen=True)
class DaySplit:
    """The change in the total split into the last session's move + overnight currency.

    ``move + overnight == total_now - prev_close_value`` exactly, per currency.
    """

    move: Decimal
    overnight: Decimal
    pct: Decimal | None


def split_day_change(prev_value: Decimal, last_value: Decimal, total_now: Decimal) -> DaySplit:
    """Split ``total_now - prev_value`` at the last session's close value."""
    move = last_value - prev_value
    pct = move / prev_value if prev_value > 0 else None
    return DaySplit(move=move, overnight=total_now - last_value, pct=pct)


def typical_daily_gap(
    fund_closes: Mapping[date, Decimal],
    twin_closes: Mapping[date, Decimal],
    *,
    min_samples: int = MIN_GAP_SAMPLES,
) -> Decimal | None:
    """Median absolute gap between the two daily returns, as a fraction.

    Returns use consecutive dates both series have. ``None`` when fewer than
    ``min_samples`` shared returns exist (not enough to say).
    """
    shared = sorted(d for d in fund_closes if d in twin_closes)
    gaps: list[Decimal] = []
    for prev, cur in pairwise(shared):
        f0, f1 = fund_closes[prev], fund_closes[cur]
        t0, t1 = twin_closes[prev], twin_closes[cur]
        if f0 <= 0 or t0 <= 0:
            continue
        gaps.append(abs((f1 / f0) - (t1 / t0)))
    if len(gaps) < max(min_samples, 1):
        return None
    gaps.sort()
    mid = len(gaps) // 2
    if len(gaps) % 2:
        return gaps[mid]
    return (gaps[mid - 1] + gaps[mid]) / 2
