"""Tooltip copy strings — single source of truth (spec §10).

Editing copy here does not touch any component code; pages reference
``TOOLTIPS[key]`` and call :func:`get`.
"""

from __future__ import annotations

from typing import Final

TOOLTIPS: Final[dict[str, str]] = {
    "total_value": (
        "The current market value of every position in the portfolio, "
        "summed and converted to the display currency using the latest FX rate."
    ),
    "total_gain": (
        "Current portfolio value minus the sum of all your net contributions. "
        "Positive means you've made money; negative means you've lost money."
    ),
    "xirr": (
        "The annualized return that makes the value of all your contributions and "
        "withdrawals (each weighted by when they happened) sum to your current "
        "portfolio value. Best for portfolios with irregular deposits."
    ),
    "twr": (
        "How much the investments themselves grew, ignoring when you happened to "
        "deposit money. Best for comparing to a benchmark like the S&P 500."
    ),
    "cagr": (
        "If your money had grown at a single constant rate from start to today, "
        "that rate. Simpler than XIRR but assumes one initial lump sum."
    ),
    "ytd_growth": (
        "Portfolio growth percentage since 1 January of the current year. "
        "Excludes new contributions — pure investment performance."
    ),
    "ytd_xirr": ("Like XIRR but restricted to cashflows from 1 January of the current year."),
    "max_drawdown": (
        "The biggest peak-to-trough drop the portfolio experienced — a measure of worst-case pain."
    ),
    "sharpe": (
        "Return per unit of total volatility above the risk-free rate. "
        "Higher is better; >1 is solid."
    ),
    "sortino": ("Like Sharpe but only penalizes downside volatility. Higher is better."),
    "volatility": (
        "Standard deviation of returns, annualized. A rough measure of how much "
        "the portfolio bounces around."
    ),
    "beta": (
        "How much the portfolio moves with the benchmark. 1.0 = moves in lockstep; "
        ">1 = more volatile than the benchmark; <1 = less."
    ),
    "alpha": (
        "Excess return over what the benchmark and beta would have predicted. "
        "Positive = outperformed; negative = underperformed."
    ),
    "drift": (
        "Difference between current allocation and target allocation. "
        "Positive means over-allocated; negative means under-allocated."
    ),
}


def get(key: str) -> str:
    """Return the tooltip for ``key`` or an empty string if missing."""
    return TOOLTIPS.get(key, "")
