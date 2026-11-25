"""Schemas for ``GET /api/holdings``."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.deps import Ccy
from investment_dashboard.api.schemas.common import ApiModel, DecStr
from investment_dashboard.api.schemas.graphs import GraphSession

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
    est_total_return: DecStr | None = Field(
        default=None,
        description=(
            "Estimated gain since buying in money, reporting currency: the official "
            "total return moved by the same delta the estimate moves the value by"
        ),
    )
    est_total_growth: DecStr | None = Field(
        default=None, description=f"est_total_return over cost basis ({_FRAC})"
    )
    at: str | None = Field(default=None, description="When the twin price used was struck (ISO)")
    at_close: bool = Field(
        default=False,
        description=(
            "The twin price used is its settled close (its market is shut and the price "
            "was struck at or after that session's bell), so the estimate is final "
            "until the next open — the row marks it with the same ✓ a priced holding gets"
        ),
    )
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
    day_session: DecStr | None = Field(
        default=None,
        description=(
            "When the currency moved: the session part of today_move (after the close the last session; while the market trades everything since the open) "
            "(close price x close rate minus the previous-close baseline). "
            "day_session + day_overnight == today_move. Null otherwise."
        ),
    )
    day_session_pct: DecStr | None = Field(
        default=None, description=f"day_session over the previous-close value ({_FRAC})"
    )
    day_overnight: DecStr | None = Field(
        default=None,
        description=(
            "The currency's overnight move. After the US close: value now minus close "
            "price x close rate. While the market trades: last night's (previous close rate "
            "to the open rate). Null when nothing moved (a USD holding in USD)."
        ),
    )
    day_overnight_pct: DecStr | None = Field(
        default=None,
        description=f"day_overnight over the previous-close value, today_pct's base ({_FRAC})",
    )
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
    #: 7.4 KeyFacts: dollars per original euro behind the holding (null without a pool).
    your_rate: DecStr | None = None
    #: 7.4 KeyFacts: the ECB fixing on the holding's buy days (weighted by dollars).
    ecb_buy_avg: DecStr | None = None
    #: 7.4 KeyFacts: EUR growth minus USD growth, each computed on its own (fraction points).
    fx_effect_pp: DecStr | None = None


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
    #: 7.4: your conversions' blend (USD per EUR), the FX tile hint.
    fx_your_rate: DecStr | None = None
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


HistoryRange = Literal["1d", "1w", "1m", "3m", "6m", "ytd", "1y", "all"]
HistoryMode = Literal["value", "price"]
TwinRange = Literal["1d", "1w", "1m", "3m", "6m", "ytd", "1y"]
XMode = Literal["date", "time"]


class HistoryPoint(ApiModel):
    t: str = Field(description="Date (ISO) for a daily range; explicit-UTC instant for 1d / 1w")
    v: DecStr | None = Field(default=None, description="Price, native currency")
    value_native: DecStr | None = Field(
        default=None, description="Value of the holding, native currency (null in price mode)"
    )
    value_eur: DecStr | None = Field(
        default=None, description="Value in EUR at that instant's / day's rate (value mode)"
    )
    value_usd: DecStr | None = Field(
        default=None, description="Value in USD at that instant's / day's rate (value mode)"
    )
    invested_eur: DecStr | None = Field(
        default=None,
        description="Cumulative buys - sells, each at its own date's rate (value mode)",
    )
    invested_usd: DecStr | None = Field(
        default=None,
        description="Cumulative buys - sells, each at its own date's rate (value mode)",
    )


class HistoryTrade(ApiModel):
    t: str = Field(description="Trade date (daily) or that session's close instant (1d / 1w)")
    kind: Literal["buy", "sell"]
    quantity: DecStr | None = Field(default=None, description="Shares, always positive")
    price_native: DecStr | None = None


class HistoryPeriod(ApiModel):
    """The range's figures, server-computed (Modified Dietz, EUR and USD each from
    its own currency's value and flow stream; a return is never converted)."""

    change_eur: DecStr | None = Field(
        default=None,
        description="Gain in the range: closing - opening value - net bought + cash dividends",
    )
    change_usd: DecStr | None = None
    return_eur: DecStr | None = Field(default=None, description=f"Modified Dietz ({_FRAC})")
    return_usd: DecStr | None = Field(default=None, description=f"Modified Dietz ({_FRAC})")
    bought_eur: DecStr | None = Field(
        default=None, description="Net bought (buys - sells), each at its own date's rate"
    )
    bought_usd: DecStr | None = None
    dividends_eur: DecStr | None = Field(
        default=None, description="Dividends (cash + reinvested), each at its own date's rate"
    )
    dividends_usd: DecStr | None = None


class HoldingHistoryResponse(ApiModel):
    """One holding's chart: native prices (``price`` mode) or its value (``value``)."""

    instrument_id: int
    symbol: str
    range: HistoryRange
    ccy: str = Field(description="The instrument's native currency, for display")
    points: list[HistoryPoint]
    mode: HistoryMode = "price"
    x_mode: XMode = "date"
    sessions: list[GraphSession] = []  # noqa: RUF012 - pydantic copies defaults
    trades: list[HistoryTrade] = []  # noqa: RUF012
    avg_price_native: DecStr | None = Field(
        default=None, description="Average cost per share now, native (the price-mode cost line)"
    )
    period: HistoryPeriod | None = None


class TwinPricePoint(ApiModel):
    t: str
    price_native: DecStr | None = None


class TwinNavPoint(ApiModel):
    t: str
    nav_native: DecStr | None = None


class TwinRebasedPoint(ApiModel):
    t: str
    fund_pct: DecStr | None = Field(default=None, description=f"From the range start ({_FRAC})")
    twin_pct: DecStr | None = Field(default=None, description=f"From the range start ({_FRAC})")
    gap_pp: DecStr | None = Field(default=None, description="twin_pct - fund_pct, in pp")


class TwinNow(ApiModel):
    price_native: DecStr | None = None
    day_pct: DecStr | None = Field(
        default=None, description=f"Against the previous session close ({_FRAC})"
    )
    captured_at: str


class TwinStats(ApiModel):
    median_gap_pp: DecStr | None = Field(default=None, description="Median absolute gap, pp")
    bias_pp: DecStr | None = Field(default=None, description="Mean signed gap, pp (+: twin high)")
    bias_label: Literal["runs_high", "runs_low", "none"] = "none"
    sessions: int = 0


class TwinRecent(ApiModel):
    session_date: str
    estimate_pct: DecStr | None = Field(default=None, description=f"Twin's move ({_FRAC})")
    nav_pct: DecStr | None = Field(default=None, description=f"Fund NAV's move ({_FRAC})")
    gap_pp: DecStr | None = None


class HoldingTwinResponse(ApiModel):
    """A fund's ETF twin on the deep-dive. The 1D estimate is built at read time."""

    instrument_id: int
    symbol: str
    twin_symbol: str
    twin_reason: Literal["same_index", "close_index", "manual"]
    range: TwinRange
    x_mode: XMode
    sessions: list[GraphSession] = []  # noqa: RUF012
    twin_points: list[TwinPricePoint]
    estimate_points: list[TwinPricePoint] = Field(
        description="1d only: prev_NAV x twin_now / twin_prev_close"
    )
    nav_points: list[TwinNavPoint]
    rebased: list[TwinRebasedPoint] | None = None
    twin_now: TwinNow | None = None
    stats: TwinStats
    recent: list[TwinRecent] = Field(description="The last 5 sessions")


class PeekWeekPoint(ApiModel):
    t: str = Field(description="Explicit-UTC instant")
    value_native: DecStr | None = None


class PeekWeek(ApiModel):
    points: list[PeekWeekPoint]
    currency: str = Field(description="Native currency of value_native")
    return_eur: DecStr | None = Field(default=None, description=f"Past week, EUR ({_FRAC})")
    return_usd: DecStr | None = Field(default=None, description=f"Past week, USD ({_FRAC})")


class PeekTranches(ApiModel):
    open_count: int
    next_long_term_on: str | None = Field(default=None, description="ISO date")
    next_long_term_days: int | None = None


class PeekTrade(ApiModel):
    date: str
    kind: Literal["buy", "sell"]
    quantity: DecStr | None = None
    price_native: DecStr | None = None


class PeekDividend(ApiModel):
    date: str
    reinvested: bool
    amount_native: DecStr | None = Field(default=None, description="The amount paid, native")
    reinvested_quantity: DecStr | None = None


class HoldingPeekResponse(ApiModel):
    """What an expanded Holdings row shows that the row itself cannot."""

    instrument_id: int
    #: 7.4: dollars per original euro behind the holding (null without a pool).
    your_rate: DecStr | None = None
    currency: str = Field(description="Native currency of the amounts")
    week: PeekWeek | None = Field(default=None, description="Null for a NAV fund (no intraday)")
    tranches: PeekTranches
    last_trade: PeekTrade | None = None
    last_dividend: PeekDividend | None = None


class HoldingPeeksResponse(ApiModel):
    """Batch peek payload for every currently held instrument."""

    peeks: dict[int, HoldingPeekResponse]
