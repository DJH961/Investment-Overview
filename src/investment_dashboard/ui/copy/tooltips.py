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
    "total_invested": (
        "The sum of all your net contributions — money paid in, less anything "
        "withdrawn. This is the cost side that Capital Gain is measured against."
    ),
    "total_growth": (
        "Total portfolio growth since inception, expressed as a percentage of net "
        "contributions. (Closing value + cumulative cash dividends) / net contributions - 1."
    ),
    "total_growth_compounded": (
        "Cumulative growth since the first cashflow, expressed as "
        '(1 + XIRR) ^ years - 1. This is XIRR "stretched" over the actual time '
        "you've been invested, so a 10 %/yr return over 5 years shows as ~61 %. "
        "Computed independently per currency (EUR vs USD), so FX swings show up."
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
    "mtd_growth": (
        "Portfolio growth since the 1st of the current month, excluding new "
        "contributions — a short-horizon read on how the holdings are moving."
    ),
    "daily_growth": (
        "Single-day change in portfolio value on the most recent completed "
        "trading day — the latest date any holding repriced. On a weekend or "
        "before the market close it shows the last business day's move (the "
        "as-of date is labelled). Mutual-fund NAVs lag ETFs by a day; the whole "
        "book is valued consistently on each date."
    ),
    "expense_ratio": (
        "The value-weighted average annual fund fee (TER) across your holdings, "
        "with the estimated euro cost per year at today's marks. Lower is better."
    ),
    "dividend_return": (
        "Lifetime cumulative dividend return — every cash dividend ever received "
        "(paid out or reinvested) divided by today's portfolio value. A running "
        "total since inception, not an annual rate."
    ),
    "dividend_yield": (
        "Per-year dividend yield — the trailing twelve months of cash dividends "
        "divided by today's portfolio value. A rolling 12-month window (not "
        "calendar year-to-date) so it stays a meaningful annual rate even in "
        "early January, shown with the last-12-months dividends in the display "
        "currency."
    ),
    "fx_rate": (
        "Live EUR→USD spot rate used to convert between your two display "
        "currencies, with the change since the previous completed trading day."
    ),
    "market_verdict": (
        "Compares your portfolio's total growth since inception against simply "
        "buying and holding the benchmark index over the same period."
    ),
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
    "calmar": (
        "Annualised return divided by the maximum drawdown. "
        "Punishes deep drawdowns harder than volatility does; higher is better."
    ),
    "ulcer": (
        "Root-mean-square of percentage drawdowns from the running peak. "
        "Bigger number = more sustained pain. Lower is better."
    ),
    "var": (
        "Historical Value-at-Risk at the 5% tail. "
        "'On the worst 1-in-20 days you lost at least this much.'"
    ),
    "cvar": (
        "Average loss on the days at or below the 5% VaR cut-off. Also known as Expected Shortfall."
    ),
    "skew": (
        "Asymmetry of the daily-return distribution. "
        "Negative = occasional big losses; positive = occasional big gains."
    ),
    "kurtosis": (
        "Excess kurtosis (Fisher). 0 is normal-distribution-like; "
        "positive = fat tails, more extreme days than a bell curve predicts."
    ),
    "risk_free": (
        "Annualised risk-free rate used by Sharpe, Sortino and Alpha. "
        "Fetched from the 13-week US T-bill yield (^IRX) by default; "
        "you can pin a manual rate in Settings."
    ),
    "benchmark": (
        "Index used as the market reference for Beta, Alpha and the "
        "comparison curve. Default is VT (Vanguard Total World)."
    ),
    "attribution": (
        "Per-instrument contribution to the portfolio's overall P&L over the window. "
        "Sums to the portfolio total return (modulo rounding)."
    ),
    "projection_expected": (
        "The default growth assumption is your portfolio's own historical XIRR — "
        "what your money has earned so far. Edit it to model a more or less "
        "aggressive future"
    ),
    "projection_band": (
        "How far the optimistic and pessimistic lines fan out above and below the "
        "expected return, in annual percentage points. A wider band means more "
        "uncertainty about future returns"
    ),
    "projection_stepup": (
        "An annual raise applied to your contribution, for when you expect to invest "
        "more over time. Set it to zero to keep contributions flat"
    ),
    "projection_inflation": (
        "Discounts future values back into today's purchasing power so amounts stay "
        "comparable to now. Set it to zero to see raw nominal figures"
    ),
    "projection_target": (
        "A milestone you are aiming for. The tool shows when each scenario reaches it "
        "and what contribution would get you there by the end of the horizon"
    ),
    "projection_real": (
        "Inflation-adjusted value — what the projected balance would be worth in "
        "today's money after discounting by your inflation assumption"
    ),
}


def get(key: str) -> str:
    """Return the tooltip for ``key`` or an empty string if missing."""
    return TOOLTIPS.get(key, "")
