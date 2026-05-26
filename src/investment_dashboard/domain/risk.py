"""Risk metrics — volatility, Sharpe, Sortino, drawdown, win-rate, beta.

Inputs are sequences of *daily* portfolio returns (decimals — ``0.01`` = 1%)
or daily portfolio *values* (drawdown). All functions are pure.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from decimal import Decimal

TRADING_DAYS_PER_YEAR = 252
TRADING_DAYS_PER_YEAR_DEC = Decimal(TRADING_DAYS_PER_YEAR)


def _to_floats(values: Sequence[Decimal]) -> list[float]:
    return [float(v) for v in values]


def annualized_volatility(daily_returns: Sequence[Decimal]) -> Decimal | None:
    """Annualised standard deviation of daily returns × √252.

    Uses the *sample* standard deviation (``ddof=1``) — matches spreadsheet
    behavior. Returns ``None`` for fewer than two observations.
    """
    if len(daily_returns) < 2:
        return None
    xs = _to_floats(daily_returns)
    mean = sum(xs) / len(xs)
    var = sum((x - mean) ** 2 for x in xs) / (len(xs) - 1)
    sd = math.sqrt(var)
    return Decimal(repr(sd * math.sqrt(TRADING_DAYS_PER_YEAR)))


def sharpe_ratio(
    daily_returns: Sequence[Decimal],
    risk_free_rate_annual: Decimal,
) -> Decimal | None:
    """(annualised return − rf) / annualised vol.

    The annualised return uses the *arithmetic* mean of daily returns × 252,
    consistent with the most common Sharpe definition. ``risk_free_rate_annual``
    is a decimal (``0.035`` = 3.5%).
    """
    if len(daily_returns) < 2:
        return None
    xs = _to_floats(daily_returns)
    mean = sum(xs) / len(xs)
    annual_return = mean * TRADING_DAYS_PER_YEAR
    vol = annualized_volatility(daily_returns)
    if vol is None or vol == 0:
        return None
    return (Decimal(repr(annual_return)) - risk_free_rate_annual) / vol


def sortino_ratio(
    daily_returns: Sequence[Decimal],
    risk_free_rate_annual: Decimal,
) -> Decimal | None:
    """Like Sharpe but using *downside* deviation only.

    Downside deviation uses the daily target = ``rf / 252``; only returns
    below that target contribute to the denominator.
    """
    if len(daily_returns) < 2:
        return None
    xs = _to_floats(daily_returns)
    daily_target = float(risk_free_rate_annual) / TRADING_DAYS_PER_YEAR
    downside_sq = [(min(x - daily_target, 0.0)) ** 2 for x in xs]
    downside_var = sum(downside_sq) / (len(xs) - 1)
    downside_dev = math.sqrt(downside_var) * math.sqrt(TRADING_DAYS_PER_YEAR)
    if downside_dev == 0:
        return None
    annual_return = (sum(xs) / len(xs)) * TRADING_DAYS_PER_YEAR
    return (Decimal(repr(annual_return)) - risk_free_rate_annual) / Decimal(repr(downside_dev))


def max_drawdown(daily_values: Sequence[Decimal]) -> Decimal:
    """Largest peak-to-trough decline as a non-positive decimal.

    Operates on an *equity curve* (portfolio values), not returns.
    Returns ``Decimal(0)`` if the series is monotonically non-decreasing or
    has fewer than two points.
    """
    if len(daily_values) < 2:
        return Decimal(0)
    peak = daily_values[0]
    worst = Decimal(0)
    for v in daily_values[1:]:
        if v > peak:
            peak = v
            continue
        if peak == 0:
            continue
        dd = (v - peak) / peak
        worst = min(worst, dd)
    return worst


def best_worst_month(monthly_returns: Sequence[Decimal]) -> tuple[Decimal, Decimal] | None:
    """``(best, worst)`` monthly return; ``None`` if input is empty."""
    if not monthly_returns:
        return None
    return max(monthly_returns), min(monthly_returns)


def monthly_win_rate(monthly_returns: Sequence[Decimal]) -> Decimal | None:
    """Fraction of months with strictly-positive return (0..1)."""
    if not monthly_returns:
        return None
    wins = sum(1 for r in monthly_returns if r > 0)
    return Decimal(wins) / Decimal(len(monthly_returns))


def beta(
    portfolio_returns: Sequence[Decimal],
    benchmark_returns: Sequence[Decimal],
) -> Decimal | None:
    """OLS beta: ``Cov(port, bench) / Var(bench)``.

    Sequences must be the same length and aligned by date. Returns ``None``
    if the benchmark has zero variance or the inputs are too short.
    """
    if len(portfolio_returns) != len(benchmark_returns) or len(portfolio_returns) < 2:
        return None
    p = _to_floats(portfolio_returns)
    b = _to_floats(benchmark_returns)
    n = len(p)
    pm = sum(p) / n
    bm = sum(b) / n
    cov = sum((p[i] - pm) * (b[i] - bm) for i in range(n)) / (n - 1)
    var_b = sum((bi - bm) ** 2 for bi in b) / (n - 1)
    if var_b == 0:
        return None
    return Decimal(repr(cov / var_b))


def alpha(
    portfolio_returns: Sequence[Decimal],
    benchmark_returns: Sequence[Decimal],
    risk_free_rate_annual: Decimal,
) -> Decimal | None:
    """Annualised Jensen's alpha relative to ``benchmark_returns``.

    ``α = (R_p − rf) − β × (R_b − rf)``, with all returns annualised by
    multiplying daily means by 252.
    """
    b = beta(portfolio_returns, benchmark_returns)
    if b is None:
        return None
    rp = (sum(_to_floats(portfolio_returns)) / len(portfolio_returns)) * TRADING_DAYS_PER_YEAR
    rb = (sum(_to_floats(benchmark_returns)) / len(benchmark_returns)) * TRADING_DAYS_PER_YEAR
    return (Decimal(repr(rp)) - risk_free_rate_annual) - b * (
        Decimal(repr(rb)) - risk_free_rate_annual
    )
