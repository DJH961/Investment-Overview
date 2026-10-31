"""Pure financial-math layer. No I/O, no DB, no HTTP.

Public functions live in:

* :mod:`investment_dashboard.domain.currency` — FX conversion helpers.
* :mod:`investment_dashboard.domain.returns` — XIRR, TWR, CAGR, growth %.
* :mod:`investment_dashboard.domain.risk` — volatility, Sharpe, Sortino,
  drawdown, win-rate, beta / alpha.
* :mod:`investment_dashboard.domain.allocation` — rebalance planner.

This package is the *only* place where financial math lives; mypy is run in
``--strict`` mode here per spec §2.
"""

from investment_dashboard.domain.allocation import (
    RebalancePlan,
    RebalanceRow,
    plan_rebalance,
)
from investment_dashboard.domain.currency import (
    eur_to_native,
    lookup_rate_with_forward_fill,
    native_to_eur,
)
from investment_dashboard.domain.returns import (
    Cashflow,
    DailyValuation,
    annualize_return,
    cagr,
    capital_gain,
    total_growth_pct,
    twr,
    xirr,
)
from investment_dashboard.domain.risk import (
    alpha,
    annualized_volatility,
    best_worst_month,
    beta,
    max_drawdown,
    monthly_win_rate,
    sharpe_ratio,
    sortino_ratio,
)

__all__ = [
    "Cashflow",
    "DailyValuation",
    "RebalancePlan",
    "RebalanceRow",
    "alpha",
    "annualize_return",
    "annualized_volatility",
    "best_worst_month",
    "beta",
    "cagr",
    "capital_gain",
    "eur_to_native",
    "lookup_rate_with_forward_fill",
    "max_drawdown",
    "monthly_win_rate",
    "native_to_eur",
    "plan_rebalance",
    "sharpe_ratio",
    "sortino_ratio",
    "total_growth_pct",
    "twr",
    "xirr",
]
