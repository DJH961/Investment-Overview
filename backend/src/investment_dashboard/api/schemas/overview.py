"""Schemas for ``GET /api/overview``."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.deps import Ccy
from investment_dashboard.api.schemas.common import ApiModel, DecStr
from investment_dashboard.api.schemas.graphs import GraphRange

_FRAC = "fraction, 0.01 = 1%"


class EstimateFund(ApiModel):
    """One fund currently valued from its ETF twin."""

    symbol: str = Field(description="The mutual fund's ticker")
    twin: str = Field(description="The ETF twin's ticker")


class OverviewEstimate(ApiModel):
    """The book valued with every pending mutual fund at its ETF-twin estimate.

    Present only while at least one fund's NAV for the last session has not posted
    and has a twin with data. ``adjustment`` is ``total_value - kpis.total_value``,
    i.e. ``sum(shares x (est_price - previous NAV))`` over ``funds`` valued at one
    EUR/USD rate; it equals the 1D graph's last point and the tick's
    ``total_value_est_*``. XIRR / TWR / gains stay official (``kpis``).
    """

    total_value: DecStr
    daily_move: DecStr | None = Field(
        default=None,
        description=(
            "Total change of the estimated book since the previous close (market open: "
            "official move + adjustment; market shut: ``last_session.move_est + "
            "last_session.overnight_currency_est``, the overnight currency included)"
        ),
    )
    daily_growth_pct: DecStr | None = Field(
        default=None, description=f"Day move of the estimated book ({_FRAC})"
    )
    funds: list[EstimateFund]
    adjustment: DecStr


class OverviewKpis(ApiModel):
    """KPIs in the requested ccy. Ratios are fractions (``0.12`` = 12 %)."""

    total_value: DecStr | None = None
    total_invested: DecStr | None = None
    capital_gain: DecStr | None = Field(
        default=None, description="total_value - total_invested (excludes dividends)"
    )
    total_return: DecStr | None = Field(
        default=None, description="capital_gain + realized cash dividends"
    )
    dividend_income: DecStr | None = None
    dividends_ttm: DecStr | None = None
    xirr: DecStr | None = Field(
        default=None, description=f"Money-weighted annualised return ({_FRAC})"
    )
    total_growth_compounded: DecStr | None = Field(
        default=None, description=f"(1 + XIRR)^years - 1 ({_FRAC})"
    )
    ytd_growth: DecStr | None = Field(default=None, description=f"Year-to-date growth ({_FRAC})")
    ytd_xirr: DecStr | None = Field(default=None, description=f"Year-to-date XIRR ({_FRAC})")
    mtd_growth: DecStr | None = Field(default=None, description=f"Month-to-date growth ({_FRAC})")
    daily_growth_pct: DecStr | None = Field(
        default=None, description=f"Latest daily move ({_FRAC})"
    )
    daily_move: DecStr | None = None
    daily_growth_as_of: str | None = None
    weighted_expense_ratio: DecStr | None = Field(
        default=None, description=f"Weighted expense ratio ({_FRAC})"
    )
    annual_expense_cost: DecStr | None = None
    dividend_yield_pct: DecStr | None = Field(
        default=None, description=f"Dividend yield on income to date ({_FRAC})"
    )
    dividend_yield_ttm_pct: DecStr | None = Field(
        default=None, description=f"Trailing-12-month dividend yield ({_FRAC})"
    )
    estimate: OverviewEstimate | None = Field(
        default=None,
        description=(
            "The same book with pending mutual funds at their ETF-twin estimate "
            "(null when none is estimating). Everything above stays official."
        ),
    )


class CurrencyLifetime(ApiModel):
    avg_invest_rate: DecStr | None = None
    current_rate: DecStr | None = None
    rate_change_pct: DecStr | None = Field(
        default=None, description=f"Current rate vs average invest rate ({_FRAC})"
    )
    fx_pnl_eur: DecStr | None = None
    repatriation_value_eur: DecStr | None = None
    breakeven_rate: DecStr | None = None


class ReturnSplit(ApiModel):
    """Investment return (USD wallet) vs currency effect; independent, never converted."""

    total_return_eur: DecStr | None = Field(
        default=None, description=f"Compounded EUR return ({_FRAC})"
    )
    investment_return: DecStr | None = Field(
        default=None, description=f"Investment return in the USD wallet ({_FRAC})"
    )
    currency_effect_pp: DecStr | None = Field(
        default=None, description="EUR return minus USD return, in percentage points"
    )


class FxRegime(ApiModel):
    market_open: bool
    forex_open: bool
    holiday: bool
    forex_frozen: bool
    weekend_overnight: bool
    single_overnight: bool
    session_view: bool


class FxLegs(ApiModel):
    net: DecStr | None = None
    market_hours: DecStr | None = None
    overnight: DecStr | None = None


class InvestingPower(FxLegs):
    amount_eur: DecStr | None = None
    amount_usd: DecStr | None = Field(
        default=None,
        description="``amount_eur`` valued at the live EUR/USD rate (USD).",
    )


class FxMove(ApiModel):
    """The box's headline rate move, regime-aware (as the NiceGUI currency box)."""

    pct: DecStr | None = Field(
        default=None,
        description=(
            f"Move of the pair shown in ``pair`` ({_FRAC}); positive = the foreign "
            "currency (EUR in USD display, USD in EUR display) got stronger"
        ),
    )
    #: What the move is measured from: the previous close (market open), the
    #: previous close as one overnight drift (US-only holiday), or the session open
    #: (every other closed-market view).
    anchor_kind: Literal["prev_close", "overnight", "session_open"]
    #: Stat label: "Today", or - while forex is frozen for the weekend - "Yesterday"
    #: / the weekday of ``session_date`` (viewer's clock).
    label_kind: Literal["today", "yesterday", "weekday"]
    session_date: str


class FxSince(ApiModel):
    pct: DecStr | None = Field(default=None, description=f"Same convention as move ({_FRAC})")
    #: "open": since this session's open (market open); "close": since its close.
    kind: Literal["open", "close"]


class FxAsOf(ApiModel):
    #: Calendar date the displayed rate belongs to.
    as_of: str
    #: "live": an intraday spot (``observed_at`` set); "eod": the ECB end-of-day rate.
    source: Literal["live", "eod"]
    observed_at: str | None = None


class FxSincePhrase(ApiModel):
    """The "Currency effect …" / "Investing power …" title phrase.

    since_yesterday -> "since yesterday"; yesterday -> "yesterday" (frozen weekend,
    one day on); on_day -> "on <weekday of session_date>" (frozen weekend);
    since_day -> "since <weekday of session_date>" (Sunday-evening spill-over).
    """

    kind: Literal["since_yesterday", "yesterday", "on_day", "since_day"]
    session_date: str


class CurrencyToday(ApiModel):
    spot: DecStr | None = None
    prev: DecStr | None = None
    rate_move_pct: DecStr | None = Field(
        default=None,
        description=(
            f"Deprecated: naive EUR/USD move vs previous close ({_FRAC}). Use ``move.pct``."
        ),
    )
    #: "EUR/USD" in USD display, "USD/EUR" in EUR display.
    pair: str | None = None
    #: The spot quoted as ``pair`` (the reciprocal of ``spot`` in EUR display).
    spot_display: DecStr | None = None
    move: FxMove | None = None
    #: Null in the single-overnight (US-holiday) regime.
    since: FxSince | None = None
    as_of: FxAsOf | None = None
    since_phrase: FxSincePhrase | None = None
    #: True when a session open/close FX anchor the regime needs was not captured.
    anchor_missing: bool = False
    spot_observed_at: str | None = None
    regime: FxRegime
    reopen_at: str | None = None
    effect_eur: FxLegs | None = None
    investing_power_usd: InvestingPower | None = None


class CurrencyBlock(ApiModel):
    lifetime: CurrencyLifetime
    return_split: ReturnSplit
    today: CurrencyToday


class MarketVerdict(ApiModel):
    benchmark_symbol: str
    portfolio_return: DecStr | None = Field(
        default=None, description=f"Portfolio compounded return ({_FRAC})"
    )
    benchmark_return: DecStr | None = Field(
        default=None, description=f"Benchmark compounded return ({_FRAC})"
    )
    beating: bool | None = None


class Mover(ApiModel):
    symbol: str
    name: str
    move: DecStr | None = None
    pct: DecStr | None = Field(
        default=None, description=f"Move vs previous close in the reporting currency ({_FRAC})"
    )
    reason: str


class Movers(ApiModel):
    basis_date: str | None = None
    eligible_count: int
    winners: list[Mover]
    losers: list[Mover]


class OverviewWarnings(ApiModel):
    zero_value: list[str]
    bad_history: list[str]
    missing_fx: list[str]


class Freshness(ApiModel):
    """How fresh the figures are (drives the Live / Updated / Updating... chip)."""

    market_state: Literal["open", "closed", "holiday"]
    #: Market open, a pull landed within 2.5 min, the newest price itself is at
    #: most 2.5 min old and the feed is not serving frozen quotes.
    prices_live: bool
    #: Start of a price-feed stall in progress (quotes frozen), else null.
    feed_stalled_since: str | None = None
    #: When the last refresh brought in new prices (this server process).
    last_price_update_at: str | None = None
    #: Newest provider market time across holdings (when the prices are *from*).
    price_market_at: str | None = None
    #: Newest pull instant across holdings (persisted cache).
    price_observed_at: str | None = None
    refresh_running: bool
    refresh_source: str | None = None
    #: A historic-data download is running (``progress_*`` describe it).
    historical: bool = False
    progress_done: int = 0
    progress_total: int = 0
    progress_label: str | None = None


class DailyCaption(ApiModel):
    """The day the "Today" move lands on (NiceGUI ``build_daily_growth_caption``)."""

    #: "Today" | "Yesterday" | short date such as "Fri 26 Jun".
    title: str
    #: "live", or the settled close clock "16:00" (settings timezone); null for older.
    corner_text: str | None = None
    live: bool
    #: "live" | "today" | "as of Fri 26 Jun" | "awaiting two priced days".
    as_of_text: str
    #: "as of 22:00 · updated 22:05" in the settled-today state.
    updated_text: str | None = None


class LastSessionMove(ApiModel):
    """Outside the session: the day move split into the last session + overnight currency.

    ``move`` is the official closes/NAVs of ``session_date`` vs ``prev_date``, each
    valued at its own session's 16:00 EUR/USD rate; ``overnight_currency`` the same
    holdings revalued from that close rate to the rate now. ``move +
    overnight_currency`` is the change in ``value_now`` since the previous close.
    Amounts in the response currency (each computed in it, never converted).
    """

    session_date: str
    prev_date: str
    move: DecStr
    move_pct: DecStr | None = None
    overnight_currency: DecStr
    value_now: DecStr
    fx_close: DecStr
    fx_now: DecStr
    #: OFFICIAL total change since the previous close, overnight currency included:
    #: ``move + overnight_currency`` = ``value_now`` minus the previous-close value (at
    #: the previous close's rate). Mirrors ``kpis.estimate.daily_move`` /
    #: ``daily_growth_pct``: their difference is exactly ``kpis.estimate.adjustment``.
    day_move: DecStr | None = None
    day_move_pct: DecStr | None = None
    #: The same split on the estimated book (null / empty when no fund is estimating):
    #: ``move_est + overnight_currency_est == value_now_est - previous-close value``.
    move_est: DecStr | None = None
    move_pct_est: DecStr | None = None
    overnight_currency_est: DecStr | None = None
    value_now_est: DecStr | None = None
    estimated_funds: list[str] = []  # noqa: RUF012 - pydantic copies defaults


class OverviewResponse(ApiModel):
    ccy: Ccy
    as_of: str
    generated_at: str
    fx_eur_usd: DecStr | None = None
    #: Deprecated: NYSE open (not price freshness). Use ``freshness.prices_live``.
    is_live: bool
    position_count: int
    kpis: OverviewKpis
    #: The other currency (USD when ``ccy`` is EUR and vice versa).
    secondary_ccy: Ccy
    #: The same KPIs computed in ``secondary_ccy`` (its own cashflows; never converted).
    kpis_secondary: OverviewKpis
    freshness: Freshness
    daily_caption: DailyCaption
    #: Market-aware range the value graph should open on (1d while the market is open).
    default_range: GraphRange
    #: False when a holding has no price, a corrupt price or EUR/USD is missing.
    total_value_complete: bool
    currency: CurrencyBlock
    market_verdict: MarketVerdict
    movers: Movers
    warnings: OverviewWarnings
    #: Market shut: last session's move + overnight currency (null while it trades).
    last_session: LastSessionMove | None = None
