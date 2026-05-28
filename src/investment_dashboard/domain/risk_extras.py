"""Extra risk metrics beyond Sharpe/Sortino/MDD (spec §6.6 v2.2 extension).

All functions are pure, operate on :class:`decimal.Decimal` inputs, and
return ``Decimal`` (or ``None`` for degenerate inputs). They sit in the
domain layer so the analytics page can compose them without knowing
about the DB or the FX layer.

Definitions follow the most common practitioner conventions:

* **Calmar ratio** — annualised return ÷ |max drawdown|. Risk-adjusted
  return that punishes deep drawdowns harder than vol does.
* **Ulcer index** — RMS of percentage drawdowns from the running peak,
  expressed as a positive percentage. More pain = bigger number.
* **Historical VaR** — left tail of the daily-return distribution at
  ``alpha`` (e.g. ``0.05``). Returned as a *non-positive* decimal so
  ``var_pct = -0.023`` reads "you lost 2.3% on the worst 5% of days".
* **Historical CVaR** — mean of the daily returns at or below the VaR
  cut-off (also non-positive). a.k.a. Expected Shortfall.
* **Skewness / Excess kurtosis** — third / fourth standardised central
  moments (sample, Fisher convention for kurtosis so a normal
  distribution has excess kurtosis = 0).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from decimal import Decimal

from investment_dashboard.domain.risk import TRADING_DAYS_PER_YEAR, max_drawdown

DEFAULT_VAR_ALPHA = Decimal("0.05")


def _to_floats(values: Sequence[Decimal]) -> list[float]:
    return [float(v) for v in values]


def calmar_ratio(
    daily_returns: Sequence[Decimal],
    daily_values: Sequence[Decimal],
) -> Decimal | None:
    """Annualised return / |max drawdown|.

    ``daily_returns`` powers the annualised numerator and
    ``daily_values`` powers the drawdown denominator — separate inputs
    because the equity curve has one more point than the returns
    series. Returns ``None`` for degenerate inputs or zero drawdown.
    """
    if len(daily_returns) < 2 or len(daily_values) < 2:
        return None
    mean = sum(_to_floats(daily_returns)) / len(daily_returns)
    annual_return = mean * TRADING_DAYS_PER_YEAR
    dd = max_drawdown(daily_values)
    if dd == 0:
        return None
    return Decimal(repr(annual_return)) / abs(dd)


def ulcer_index(daily_values: Sequence[Decimal]) -> Decimal | None:
    """Root-mean-square of percentage drawdowns from the running peak.

    Returned as a positive ``Decimal`` (a percentage point in decimal
    form, i.e. ``0.05`` = 5%). ``None`` for fewer than two values or a
    series that never establishes a positive peak.
    """
    if len(daily_values) < 2:
        return None
    xs = _to_floats(daily_values)
    peak = xs[0]
    if peak <= 0:
        return None
    sq_sum = 0.0
    count = 0
    for v in xs:
        peak = max(peak, v)
        if peak <= 0:
            continue
        dd_pct = (v - peak) / peak  # ≤ 0
        sq_sum += dd_pct * dd_pct
        count += 1
    if count == 0:
        return None
    return Decimal(repr(math.sqrt(sq_sum / count)))


def historical_var(
    daily_returns: Sequence[Decimal],
    alpha: Decimal = DEFAULT_VAR_ALPHA,
) -> Decimal | None:
    """Historical Value-at-Risk at the ``alpha`` left-tail probability.

    Uses the empirical quantile with ``floor`` indexing (no
    interpolation) — matches the spreadsheet convention and avoids the
    ambiguity around fractional indices. Returns a *non-positive*
    ``Decimal`` (the loss; ``-0.02`` means "2% loss").
    """
    if not daily_returns:
        return None
    if alpha <= 0 or alpha >= 1:
        raise ValueError(f"alpha must be in (0, 1), got {alpha}")
    sorted_returns = sorted(_to_floats(daily_returns))
    idx = max(0, math.floor(float(alpha) * len(sorted_returns)) - 1)
    return Decimal(repr(sorted_returns[idx]))


def historical_cvar(
    daily_returns: Sequence[Decimal],
    alpha: Decimal = DEFAULT_VAR_ALPHA,
) -> Decimal | None:
    """Conditional VaR — mean of the returns at or below the VaR cut-off.

    Returned as a non-positive ``Decimal``. Identical sign convention
    to :func:`historical_var`. ``None`` if the cut-off bucket is empty
    (very small sample with a tiny ``alpha``).
    """
    var = historical_var(daily_returns, alpha)
    if var is None:
        return None
    tail = [r for r in _to_floats(daily_returns) if r <= float(var)]
    if not tail:
        return None
    return Decimal(repr(sum(tail) / len(tail)))


def skewness(daily_returns: Sequence[Decimal]) -> Decimal | None:
    """Sample skewness (third standardised moment).

    Uses the bias-corrected ``g1`` formula
    (``n / ((n-1)(n-2)) * Σ((x − x̄) / s)³``) — what spreadsheets call
    ``SKEW``. Returns ``None`` for fewer than three observations or
    zero variance.
    """
    n = len(daily_returns)
    if n < 3:
        return None
    xs = _to_floats(daily_returns)
    mean = sum(xs) / n
    var = sum((x - mean) ** 2 for x in xs) / (n - 1)
    sd = math.sqrt(var)
    if sd == 0:
        return None
    m3 = sum(((x - mean) / sd) ** 3 for x in xs)
    coeff = n / ((n - 1) * (n - 2))
    return Decimal(repr(coeff * m3))


def excess_kurtosis(daily_returns: Sequence[Decimal]) -> Decimal | None:
    """Sample excess (Fisher) kurtosis.

    Excess = kurtosis − 3, so a normal distribution scores 0; positive
    values mean fat tails. Uses the bias-corrected ``g2`` formula
    (matches Excel's ``KURT``). Returns ``None`` for fewer than four
    observations or zero variance.
    """
    n = len(daily_returns)
    if n < 4:
        return None
    xs = _to_floats(daily_returns)
    mean = sum(xs) / n
    var = sum((x - mean) ** 2 for x in xs) / (n - 1)
    sd = math.sqrt(var)
    if sd == 0:
        return None
    m4 = sum(((x - mean) / sd) ** 4 for x in xs)
    coeff = (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))
    bias = (3 * (n - 1) ** 2) / ((n - 2) * (n - 3))
    return Decimal(repr(coeff * m4 - bias))
