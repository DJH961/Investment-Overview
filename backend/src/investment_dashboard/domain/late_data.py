"""Late data: mutual-fund NAVs that post after the close, and overnight currency.

Pure maths (no I/O, ``Decimal`` only).

A mutual fund's NAV belongs to the session it was struck in: it is the fund's
16:00 New York close, just published late (about 16:00-20:00 New York). So:

* Stored history, the KPIs (XIRR, TWR, cost, gains) and the official total use
  **official prices only**: a fund whose NAV has not posted counts at its previous
  NAV.
* Alongside them the server now also serves an **estimated total** (the hero's
  big number, the tick's ``total_value_est_*``, the holdings' twin rows and the
  1D line's last point): the official total plus, for every fund whose NAV for the
  last session has not posted, ``shares x (est_price - previous NAV)`` with
  ``est_price = prev_nav x twin_now / twin_prev_close`` when the fund has an ETF
  twin (:mod:`investment_dashboard.domain.index_twins`), else flat at the
  previous NAV. Once the NAV posts the adjustment is 0 and the row reports how
  far the twin was off (:func:`divergences`: last session, median absolute gap,
  mean signed bias).
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

from collections.abc import Collection, Iterable, Mapping
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
    return _median(gaps)


def _median(values: list[Decimal]) -> Decimal:
    """Median of a non-empty list (mean of the two middle values for an even count)."""
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


#: Sessions the twin-divergence statistics look back over by default (setting
#: ``twin.divergence_window``).
DEFAULT_DIVERGENCE_WINDOW = 20


@dataclass(frozen=True)
class Divergence:
    """How far a fund's official daily return strayed from its ETF twin's.

    Every gap is ``twin return - fund return`` as a fraction (``0.0003`` = 0.03
    percentage points): positive means the twin ran ahead of the fund, i.e. the
    estimate was too high. ``last_*`` describe the newest usable session
    (``last_prev_date`` -> ``last_date``); ``median_abs`` is the median absolute
    gap and ``bias`` the mean signed gap over the ``sessions`` most recent usable
    sessions (at most ``window``).
    """

    last_date: date
    last_prev_date: date
    last_gap: Decimal
    median_abs: Decimal
    bias: Decimal
    sessions: int
    window: int


def divergences(
    fund_closes: Mapping[date, Decimal],
    twin_closes: Mapping[date, Decimal],
    *,
    window: int = DEFAULT_DIVERGENCE_WINDOW,
    excluded: Collection[date] = (),
) -> Divergence | None:
    """Twin-vs-fund divergence over the last ``window`` sessions, or ``None``.

    A session is one return between two consecutive dates both series have. A
    session ending on an ``excluded`` date (a dividend / distribution: the fund's
    NAV and the ETF's price drop on different days, so the gap is not tracking
    error) is dropped, as is one with a non-positive starting price.
    """
    shared = sorted(d for d in fund_closes if d in twin_closes)
    gaps: list[tuple[date, date, Decimal]] = []
    for prev, cur in pairwise(shared):
        if cur in excluded:
            continue
        f0, f1 = fund_closes[prev], fund_closes[cur]
        t0, t1 = twin_closes[prev], twin_closes[cur]
        if f0 <= 0 or t0 <= 0:
            continue
        gaps.append((prev, cur, (t1 / t0) - (f1 / f0)))
    size = max(window, 1)
    recent = gaps[-size:]
    if not recent:
        return None
    values = [g for _p, _c, g in recent]
    last_prev, last_date, last_gap = recent[-1]
    return Divergence(
        last_date=last_date,
        last_prev_date=last_prev,
        last_gap=last_gap,
        median_abs=_median([abs(v) for v in values]),
        bias=sum(values, start=ZERO) / len(values),
        sessions=len(values),
        window=size,
    )
