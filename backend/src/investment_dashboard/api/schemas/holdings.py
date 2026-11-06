"""Schemas for ``GET /api/holdings``."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.deps import Ccy
from investment_dashboard.api.schemas.common import ApiModel, DecStr

_FRAC = "fraction, 0.01 = 1%"


class TwinDivergence(ApiModel):
    """How far a fund's ETF twin strayed from the fund's official NAV return.

    Gaps are ``twin return - fund return``: positive means the twin ran ahead, i.e.
    the estimate was too high. Percentage points (``0.03`` = 0.03 pp), not fractions.
    Sessions with a dividend or distribution are left out.
    """

    last_pp: DecStr | None = Field(
        default=None, description="Newest usable session's gap, in percentage points"
    )
    last_money: DecStr | None = Field(
        default=None,
        description=(
            "That gap in money (estimate minus official value of the holding, reporting "
            "currency, at the rate now)"
        ),
    )
    last_date: str | None = Field(default=None, description="Session the last_* figures are from")
    median_abs_pp: DecStr = Field(description="Median absolute gap over the window, pp")
    bias_pp: DecStr = Field(description="Mean signed gap over the window, pp (positive: twin high)")
    sessions: int = Field(description="Sessions actually used (at most ``window``)")
    window: int = Field(description="Setting twin.divergence_window, in sessions")


class TwinView(ApiModel):
    """A mutual fund's ETF-twin estimate (``pending``) and/or its accuracy record.

    ``pending`` true: the fund's NAV for the last session has not posted; the ``est_*``
    fields value the holding from the twin. ``pending`` false: the NAV posted (until
    the next open the row only carries ``divergence``; ``est_*`` and ``at`` are null).
    """

    symbol: str = Field(description="The twin ETF's ticker")
    tier: Literal["same_index", "close", "manual"]
    est_price: DecStr | None = Field(
        default=None, description="Estimated NAV per share, native currency"
    )
    est_value: DecStr | None = Field(
        default=None, description="Estimated value of the holding, reporting currency"
    )
    est_today_move: DecStr | None = Field(
        default=None, description="Estimated day move in money, reporting currency"
    )
    est_today_pct: DecStr | None = Field(
        default=None, description=f"Estimated day move ({_FRAC}), reporting currency"
    )
    at: str | None = Field(default=None, description="When the twin price used was struck (ISO)")
    pending: bool
    divergence: TwinDivergence | None = None


class HoldingRow(ApiModel):
    instrument_id: int
    symbol: str
    name: str
    category: str
    asset_class: str
    account: str
    native_currency: str
    shares: DecStr
    avg_price_native: DecStr | None = None
    price_native: DecStr | None = None
    price_as_of: str | None = None
    updated_at: str | None = None
    price_market_at: str | None = Field(
        default=None,
        description="When the price is from (close print or NAV publish time), if known",
    )
    price_type: str = Field(
        description='"nav" for NAV-priced funds (and money market), else "market"'
    )
    is_money_market: bool
    market_open: bool
    expense_ratio: DecStr | None = Field(default=None, description=f"Annual fee ({_FRAC})")
    cost_basis: DecStr | None = None
    value: DecStr | None = None
    capital_gain: DecStr | None = Field(
        default=None,
        description="Unrealised gain on this holding (value - cost basis), no dividends",
    )
    dividends: DecStr | None = Field(
        default=None, description="Lifetime dividends of this holding (cash and reinvested)"
    )
    total_return: DecStr | None = Field(
        default=None, description="capital_gain + dividends (same basis as the overview)"
    )
    xirr: DecStr | None = Field(default=None, description=f"Annualised return ({_FRAC})")
    total_growth: DecStr | None = Field(
        default=None, description=f"Compounded return since first purchase ({_FRAC})"
    )
    ytd_growth: DecStr | None = Field(default=None, description=f"Year to date ({_FRAC})")
    mtd_growth: DecStr | None = Field(default=None, description=f"Month to date ({_FRAC})")
    today_pct: DecStr | None = Field(default=None, description=f"Latest daily move ({_FRAC})")
    today_move: DecStr | None = None
    daily_growth_as_of: str | None = None
    daily_is_stale: bool
    weight_pct: DecStr | None = Field(
        default=None, description=f"Share of portfolio value ({_FRAC})"
    )
    value_warning: bool
    price_data_warning: bool
    twin: TwinView | None = Field(
        default=None,
        description="ETF-twin estimate / accuracy for a mutual fund with a twin; one row per fund",
    )


class HoldingsSummary(ApiModel):
    best_symbol: str | None = None
    best_growth: DecStr | None = Field(
        default=None, description=f"total_growth of the best holding ({_FRAC})"
    )
    worst_symbol: str | None = None
    worst_growth: DecStr | None = Field(
        default=None, description=f"total_growth of the worst holding ({_FRAC})"
    )
    most_concentrated_symbol: str | None = None
    most_concentrated_weight_pct: DecStr | None = Field(
        default=None, description=f"Largest weight ({_FRAC})"
    )
    gainers: int = Field(description="Holdings up today (daily money move > 0)")
    losers: int = Field(description="Holdings down today (daily money move < 0)")
    in_profit: int = Field(description="Holdings with capital_gain > 0 (total, not today)")
    in_loss: int = Field(description="Holdings with capital_gain < 0 (total, not today)")


GroupBy = Literal["none", "account", "asset_class", "currency", "category"]


class HoldingGroup(ApiModel):
    """Subtotals of one group, in the reporting ccy (``null`` when a member lacks the leg)."""

    key: str
    count: int
    instrument_ids: list[int] = Field(description="Members, in the order of ``holdings``")
    value: DecStr | None = None
    cost_basis: DecStr | None = None
    capital_gain: DecStr | None = None
    dividends: DecStr | None = None
    total_return: DecStr | None = None
    total_growth: DecStr | None = Field(
        default=None,
        description=(
            f"total_return / cost_basis of the group ({_FRAC}), in the response currency; "
            "a simple return on cost (not the members' compounded total_growth). "
            "Null when the cost basis is not positive or a member lacks a leg"
        ),
    )
    weight_pct: DecStr | None = Field(default=None, description=f"Summed weight ({_FRAC})")
    today_move: DecStr | None = Field(
        default=None, description="Sum of the members' official day moves (null if one lacks it)"
    )
    today_pct: DecStr | None = Field(
        default=None,
        description=(
            f"today_move over the group's previous value ({_FRAC}). A pending-NAV member "
            "contributes its last published move, so prefer est_today_pct when it is set"
        ),
    )
    est_value: DecStr | None = Field(
        default=None, description="value with pending mutual funds at their twin estimate"
    )
    est_today_move: DecStr | None = Field(
        default=None,
        description="today_move with pending funds at their twin estimate (null: none pending)",
    )
    est_today_pct: DecStr | None = Field(
        default=None,
        description=f"est_today_move over the group's estimated previous value ({_FRAC})",
    )


class HoldingsFx(ApiModel):
    pair: str = Field(description='"USD/EUR" (EUR reporting) or "EUR/USD" (USD reporting)')
    spot: DecStr
    move_pct: DecStr | None = Field(
        default=None, description=f"Move vs the previous close ({_FRAC})"
    )
    as_of: str | None = None
    source: Literal["live", "eod"] | None = None
    observed_at: str | None = None


class HoldingsResponse(ApiModel):
    ccy: Ccy
    as_of: str
    fx_eur_usd: DecStr | None = None
    total_value: DecStr | None = None
    total_cost_basis: DecStr | None = Field(default=None, description="Sum of cost bases")
    total_capital_gain: DecStr | None = Field(
        default=None,
        description=(
            "Whole-portfolio capital gain, the same number as the overview: realised plus "
            "unrealised price gain after fees, no dividends. "
            "total_unrealised_gain + total_realised_other"
        ),
    )
    total_unrealised_gain: DecStr | None = Field(
        default=None, description="Sum of the listed holdings' capital_gain (still held)"
    )
    total_realised_other: DecStr | None = Field(
        default=None,
        description=(
            "total_capital_gain - total_unrealised_gain: gains realised by selling, closed "
            "positions, cash and savings balances, fees"
        ),
    )
    total_dividends: DecStr | None = Field(
        default=None, description="Sum of the listed holdings' dividends"
    )
    total_return: DecStr | None = Field(
        default=None,
        description=(
            "Whole-portfolio total return, the same number as the overview: "
            "total_capital_gain + dividend_income"
        ),
    )
    xirr: DecStr | None = Field(default=None, description=f"Portfolio XIRR ({_FRAC})")
    total_growth: DecStr | None = Field(
        default=None, description=f"Portfolio compounded growth ({_FRAC})"
    )
    dividend_income: DecStr | None = Field(
        default=None, description="Lifetime cash dividends received"
    )
    dividends_ttm: DecStr | None = Field(default=None, description="Dividends, last 12 months")
    dividend_yield_pct: DecStr | None = Field(
        default=None, description=f"Lifetime dividends / value ({_FRAC})"
    )
    dividend_yield_ttm_pct: DecStr | None = Field(
        default=None, description=f"Trailing-12-month yield ({_FRAC})"
    )
    weighted_expense_ratio: DecStr | None = Field(default=None, description=_FRAC)
    annual_expense_cost: DecStr | None = Field(
        default=None, description="Estimated yearly fees in ccy (spot-converted)"
    )
    fx: HoldingsFx | None = Field(
        default=None, description="Current FX; null when every holding is in ccy"
    )
    group_by: GroupBy = "none"
    groups: list[HoldingGroup] = Field(default_factory=list)
    holdings: list[HoldingRow]
    summary: HoldingsSummary


HistoryRange = Literal["1m", "3m", "6m", "ytd", "1y", "all"]


class HistoryPoint(ApiModel):
    t: str = Field(description="Date (ISO), one close per trading day")
    v: DecStr | None = None


class HoldingHistoryResponse(ApiModel):
    """Daily closes of one instrument in its native currency (never converted)."""

    instrument_id: int
    symbol: str
    range: HistoryRange
    ccy: str = Field(description="The instrument's native currency, for display")
    points: list[HistoryPoint]
