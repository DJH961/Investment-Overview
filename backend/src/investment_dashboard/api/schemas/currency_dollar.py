"""Schemas for the Currency page's "The dollar" and "What if" sections (v7.2).

* ``GET /api/currency/dollar/both?range=`` -> ``ByCurrency[DollarOut]``
* ``GET /api/currency/scenarios/both`` -> ``ByCurrency[ScenariosOut]``

**Quotes.** Every rate is sent as a :class:`~.currency_rate.RateValue` pair:
``rate`` is USD per 1 EUR (the ECB quote, "EUR/USD") and ``inverse`` is 1 / rate
(EUR per 1 USD, "one dollar in euros", up = dollar stronger). Each side names the
quote it shows in ``quote``: the EUR view shows ``inverse`` (pair ``USD/EUR``), the
USD view shows ``rate`` (pair ``EUR/USD``), the same as the Today card's
``today.pair``. Changes come as both ``rate_pct`` and ``inverse_pct`` so the label
always matches the quote shown.

Fractions: 0.01 = 1 %. Money is in the side's own currency (``ccy``), computed in
it from native amounts at one rate (never converted from the other side). Dollar
amounts (``exposure_usd``, ``usd_now`` …) are native dollars in both views.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.deps import Ccy
from investment_dashboard.api.schemas.common import ApiModel, DecStr
from investment_dashboard.api.schemas.currency_rate import (
    RangeWindow,
    RateChange,
    RateHistoryPoint,
    RatePercentiles,
    RateRange,
    RateValue,
)

#: The page's permanent caption (plan "Tab 2").
CAPTION = (
    "Exchange rates wander and tend to revert over years; this page describes, it does not predict."
)

QuoteField = Literal["rate", "inverse"]


class DollarQuote(ApiModel):
    """Which quote this side shows: ``inverse`` + ``USD/EUR`` (EUR), ``rate`` + ``EUR/USD`` (USD)."""

    pair: Literal["USD/EUR", "EUR/USD"]
    #: The ``RateValue`` field to print, and the ``*_pct`` change to pair with it
    #: (``rate`` -> ``rate_pct``, ``inverse`` -> ``inverse_pct``).
    field: QuoteField


# -- GET /currency/dollar/both ------------------------------------------------


class DollarPosition(ApiModel):
    """The dollar position card (IBKR "Forex P&L" style)."""

    #: Holdings priced in USD (account native currency USD), native dollars.
    exposure_usd: DecStr | None = None
    #: ``exposure_usd`` in this side's currency at the valuation rate (one instant).
    exposure_value: DecStr | None = None
    #: ``exposure_usd`` as a share of the holdings' value (same instant), fraction.
    exposure_share: DecStr | None = None
    #: USD view only: holdings not priced in dollars, in dollars at the valuation
    #: rate (one instant); ``0`` for an all-dollar book.
    other_value: DecStr | None = None
    #: USD view only: ``other_value`` as a share of the holdings' value, fraction.
    other_share: DecStr | None = None
    #: The Overview's ``lifetime.avg_invest_rate``.
    avg_rate: RateValue | None = None
    #: The Overview's ``lifetime.current_rate`` (falls back to today's spot).
    rate_now: RateValue | None = None
    #: From ``avg_rate`` to ``rate_now``.
    change: RateChange | None = None
    #: The Overview's ``lifetime.fx_pnl_eur`` (EUR, both views).
    fx_gain_eur: DecStr | None = None
    #: The Overview's ``lifetime.breakeven_rate``.
    breakeven: RateValue | None = None
    #: Today: from the previous close (``today.prev``) to the spot (``today.spot``).
    today: RateChange | None = None
    #: Over the page range: the settled rate on the range's start to the last close.
    range_change: RateChange | None = None


class NextEuroPoint(ApiModel):
    """One weekly point of the sparkline: dollars that ``amount_eur`` bought on ``t``."""

    t: str
    usd: DecStr


class NextEuro(ApiModel):
    """ "€1,000 buys $X now; $Y a year ago" (a euro notional at one rate each)."""

    amount_eur: DecStr
    usd_now: DecStr
    #: At the settled ECB rate one year ago (forward-filled), or null without history.
    usd_year_ago: DecStr | None = None
    year_ago_date: str | None = None
    #: ``usd_now / usd_year_ago - 1``.
    change_pct: DecStr | None = None
    #: Share of days since your first transaction on which €1 bought fewer dollars
    #: than now (0..1). "Better than on 64 % of days since you started."
    better_than_share: DecStr | None = None
    #: The last year of ``usd_now``-style values, weekly, oldest first.
    spark: list[NextEuroPoint] = Field(default_factory=list)


class DollarRegime(ApiModel):
    """The trend's regime with hysteresis (``domain.fx_trend.regime``).

    In ``DollarTrend.asset``'s terms: the EUR view reads the dollar (``dollar_*``), the
    USD view the euro (``euro_*``, on the EUR/USD rate itself).
    """

    direction: Literal["dollar_up", "dollar_down", "euro_up", "euro_down", "sideways"]
    since: str
    #: The asset's own change since ``since``, fraction.
    since_change_pct: DecStr


class DollarMa200(ApiModel):
    """Today's rate against its 200-day average, and that average's slope."""

    #: The dollar (inverse) above or below its MA200.
    side: Literal["above", "below"]
    ma200: RateValue
    #: ``inverse / ma200.inverse - 1`` (the dollar's distance from its average).
    distance_pct: DecStr
    #: MA200 of the inverse now against ``slope_days`` rows earlier.
    slope: Literal["rising", "falling", "flat"]
    #: ``ma_now / ma_then - 1`` of the inverse.
    slope_pct: DecStr
    slope_days: int


class NormalRange(ApiModel):
    """How today's trailing move compares with every move of the same length."""

    window: Literal["month", "year"]
    #: ECB business days in the window (21 / 252).
    window_days: int
    #: The dollar's (inverse) move over the window, signed fraction.
    move_pct: DecStr
    #: Median |move| over the whole history ("a typical month moves ±X").
    typical_move_pct: DecStr
    #: The 80th percentile of |move|: inside ±this is ``normal``.
    normal_limit_pct: DecStr
    #: Mid-rank percentile of |today's move| among all |moves|, 0..1.
    percentile: DecStr
    label: Literal["normal", "large", "unusual"]


class Week52(ApiModel):
    """The last 365 days of settled rows. ``low`` / ``high`` are the lowest / highest
    **rate** (EUR/USD); in the dollar's terms the low rate is the dollar's high."""

    low: RateHistoryPoint
    high: RateHistoryPoint
    #: Today's rate against the low / high rate: ``rate_now / rate_at - 1``.
    from_low_rate_pct: DecStr
    from_high_rate_pct: DecStr
    #: The same in the dollar's (inverse) terms: ``inverse_now / inverse_at - 1``.
    from_low_inverse_pct: DecStr
    from_high_inverse_pct: DecStr


class RunMonth(ApiModel):
    """One month of the run: ``YYYY-MM`` and the dollar's move over it."""

    month: str
    move: Literal["rose", "fell", "flat"]


class DollarRun(ApiModel):
    """ "The dollar fell in 5 of the last 6 months" (calendar months, last ECB day each)."""

    direction: Literal["rose", "fell"]
    count: int
    of: int
    unit: Literal["month"] = "month"
    #: The ``of`` months, oldest to newest.
    months: list[RunMonth] = Field(default_factory=list)


class LongRun(ApiModel):
    """Distance from the mean since 1999 (ECB history)."""

    since: str
    mean: RateValue
    #: ``inverse_now / mean.inverse - 1``.
    distance_inverse_pct: DecStr
    #: The asset's own distance: the dollar's (as above) or the euro's
    #: (``rate_now / mean.rate - 1``).
    distance_pct: DecStr | None = None


class DollarTrend(ApiModel):
    """The trend of one currency against the other, in its own terms.

    ``asset`` says whose: ``dollar`` (the EUR view: every move, average, run and
    percentile is the dollar's, on EUR per USD) or ``euro`` (the USD view: the same
    figures computed on the EUR/USD rate itself, never the dollar's negated).
    ``ma200.distance_pct``, ``normal_*.move_pct``, ``run``, ``percentiles`` (days the
    asset was cheaper than today), ``long_run.distance_pct`` and
    ``above_entry_share`` (days the asset stood above your average rate) follow it.
    """

    asset: Literal["dollar", "euro"] = "dollar"
    regime: DollarRegime | None = None
    ma200: DollarMa200 | None = None
    normal_month: NormalRange | None = None
    normal_year: NormalRange | None = None
    #: Share of days the dollar was cheaper than today, per window (0..1).
    percentiles: RatePercentiles = Field(default_factory=RatePercentiles)
    week52: Week52 | None = None
    run: DollarRun | None = None
    long_run: LongRun | None = None
    #: Share of days since your first transaction on which the dollar was above your
    #: average entry (rate below ``avg_invest_rate``), 0..1.
    above_entry_share: DecStr | None = None


class RollingPoint(ApiModel):
    t: str
    #: The dollar's (inverse) trailing change, signed fraction.
    inverse_pct: DecStr
    #: The EUR/USD rate's trailing change, signed fraction.
    rate_pct: DecStr


class RollingSeries(ApiModel):
    window: Literal["1m", "3m", "1y"]
    window_days: int
    points: list[RollingPoint] = Field(default_factory=list)
    #: Median |move| of the dollar over the full history.
    typical_move_pct: DecStr | None = None
    #: The normal band is ``±normal_limit_pct`` (80th percentile of |move|).
    normal_limit_pct: DecStr | None = None


DollarStatKey = Literal[
    "percentile_since_start",
    "percentile_y5",
    "percentile_y10",
    "percentile_since_1999",
    "week52_low",
    "week52_high",
    "low_since_start",
    "high_since_start",
    "avg_rate_holding",
    "share_above_avg",
    "rate_volatility",
]
ScenarioStatKey = Literal[
    "one_cent",
    "breakeven",
    "value_at_low",
    "value_at_high",
    "volatility",
    "deepest_fall",
    "dollar_rose_on_down_days",
]
StatUnit = Literal["rate", "fraction", "money"]


class SectionStat(ApiModel):
    """One section strip tile (a tile without data is not sent).

    ``unit = rate``: ``value`` is USD per 1 EUR and ``value_display`` the same rate in
    the side's ``quote``. ``secondary`` follows ``secondary_unit`` the same way.
    """

    key: str
    value: DecStr
    unit: StatUnit
    value_display: DecStr | None = None
    currency: Ccy | None = None
    secondary: DecStr | None = None
    secondary_unit: StatUnit | None = None
    secondary_display: DecStr | None = None
    secondary_currency: Ccy | None = None
    #: ISO date the figure belongs to (lows / highs).
    date: str | None = None


class DollarStat(SectionStat):
    key: DollarStatKey  # type: ignore[assignment]


class DollarOut(ApiModel):
    ccy: Ccy
    as_of: str | None = None
    generated_at: str
    range: RateRange
    quote: DollarQuote
    caption: str = CAPTION
    position: DollarPosition = Field(default_factory=DollarPosition)
    next_euro: NextEuro | None = None
    trend: DollarTrend = Field(default_factory=DollarTrend)
    rolling: list[RollingSeries] = Field(default_factory=list)
    stats: list[DollarStat] = Field(default_factory=list)
    #: 1D / 1W: trailing month-plus changes say nothing about so short a range.
    rolling_too_short: bool = False
    #: The range as dates (one meaning for the whole page, 7.3.1).
    window: RangeWindow | None = None


# -- GET /currency/scenarios/both ---------------------------------------------


class ScenarioRow(ApiModel):
    """The book valued at one EUR/USD ``rate`` (a single-instant valuation)."""

    rate: DecStr
    #: ``rate`` quoted as the side's ``quote``.
    rate_display: DecStr
    #: The holdings' value in ``ccy`` at ``rate``.
    value: DecStr
    #: The book in the other currency at `rate` (what still moves for an all-native book).
    other_value: DecStr | None = None
    #: Invest view: dollars the euro unit / the regular amount buy at ``rate``, the change
    #: from today's rate, and from your average conversion rate (null without one).
    per_unit: DecStr | None = None
    per_monthly: DecStr | None = None
    unit_change: DecStr | None = None
    monthly_change: DecStr | None = None
    unit_vs_avg: DecStr | None = None
    monthly_vs_avg: DecStr | None = None
    #: The currency gain in ``ccy`` at ``rate`` against your average rate: the
    #: holdings whose native currency is not ``ccy`` valued at ``rate`` minus at
    #: ``avg_invest_rate``. Null without an average rate.
    gain: DecStr | None = None
    #: Break-even minus this row, both in the side's ``quote`` (> 0: the quote must rise
    #: this far to reach break-even).
    to_breakeven: DecStr | None = None
    #: The same move as a fraction of this row's ``rate_display``.
    to_breakeven_pct: DecStr | None = None


class ScenarioMark(ApiModel):
    key: Literal["average", "breakeven", "today", "range_start", "historic_low", "historic_high"]
    rate: DecStr
    rate_display: DecStr
    date: str | None = None
    #: Index into ``rows`` of the nearest slider row.
    row_index: int


class StressRow(ApiModel):
    """The book with the side's ``quote`` moved by ``shift_pct`` from today's value."""

    #: Fraction (-0.10 = the quote falls 10 %), applied to the quote shown.
    shift_pct: DecStr
    rate: DecStr
    rate_display: DecStr
    value: DecStr
    #: ``value`` minus today's value, in ``ccy``.
    change: DecStr
    #: The same two figures for the book in the other currency.
    other_value: DecStr | None = None
    other_change: DecStr | None = None
    #: Invest view: dollars the euro unit / the regular amount buy after the move, and
    #: the change from today's.
    per_unit: DecStr | None = None
    per_monthly: DecStr | None = None
    unit_change: DecStr | None = None
    monthly_change: DecStr | None = None


class InvestAmounts(ApiModel):
    """The euros the invest view prices (the USD Scenarios)."""

    #: A round unit: "what does EUR 1,000 buy".
    unit_eur: DecStr
    #: The owner's regular amount (``investing_power.amount_eur``).
    monthly_eur: DecStr


class Sensitivity(ApiModel):
    """ "1 ct = €X": the book at today's ``rate`` and after one cent of the quote shown."""

    rate: DecStr
    value_at_rate: DecStr
    value_at_rate_plus: DecStr
    change: DecStr


class Cushion(ApiModel):
    """Does the dollar cushion or amplify your swings? (``domain.risk`` on both series)."""

    #: First day of the measured window (the page range's start, or your first invested
    #: day if later).
    since: str
    #: The window is too short for a meaningful volatility: only ``since`` is set.
    too_short: bool = False
    #: Annualised volatility of the flow-adjusted daily returns, per currency.
    volatility_eur: DecStr | None = None
    volatility_usd: DecStr | None = None
    #: Deepest peak-to-trough fall of the growth index (non-positive fraction).
    max_drawdown_eur: DecStr | None = None
    max_drawdown_usd: DecStr | None = None
    #: Trading days on which the holdings fell in their own dollars.
    down_days: int = 0
    #: Of those, days on which the dollar rose against the euro (settled ECB rates).
    down_days_dollar_rose: int = 0
    #: ``down_days_dollar_rose / down_days`` (null without down days).
    dollar_rose_share: DecStr | None = None


class ScenarioStat(SectionStat):
    key: ScenarioStatKey  # type: ignore[assignment]


class ScenariosOut(ApiModel):
    ccy: Ccy
    as_of: str | None = None
    generated_at: str
    quote: DollarQuote
    caption: str = CAPTION
    #: The page range the marks, low/high stats and cushion describe, and its first day.
    range: RateRange = "max"
    range_start: str | None = None
    #: ``value`` (EUR view: today's holdings at other rates, a strong dollar is good) or
    #: ``invest`` (USD view: what the euros you send in buy, a strong euro is good).
    perspective: Literal["value", "invest"] = "value"
    #: ``invest`` only: the euro unit ("what does EUR 1,000 buy") and the regular amount.
    invest: InvestAmounts | None = None
    other_ccy: Ccy = "USD"
    #: The book in ``other_ccy`` at today's rate (the secondary line of the invest view).
    value_now_other: DecStr | None = None
    #: Slider step, and the first / last row, in the side's ``quote`` (rows ascend in it).
    step: DecStr
    min_rate: DecStr
    max_rate: DecStr
    #: Today's rate (the Overview's spot) and the book's value at it.
    rate_now: RateValue | None = None
    value_now: DecStr | None = None
    #: The Overview's ``lifetime.avg_invest_rate`` / ``breakeven_rate``.
    avg_rate: RateValue | None = None
    breakeven: RateValue | None = None
    rows: list[ScenarioRow] = Field(default_factory=list)
    marks: list[ScenarioMark] = Field(default_factory=list)
    stress: list[StressRow] = Field(default_factory=list)
    sensitivity: Sensitivity | None = None
    cushion: Cushion | None = None
    stats: list[ScenarioStat] = Field(default_factory=list)
    #: The range as dates (one meaning for the whole page, 7.3.1).
    window: RangeWindow | None = None


__all__ = [
    "CAPTION",
    "Cushion",
    "DollarMa200",
    "DollarOut",
    "DollarPosition",
    "DollarQuote",
    "DollarRegime",
    "DollarRun",
    "DollarStat",
    "DollarStatKey",
    "DollarTrend",
    "InvestAmounts",
    "LongRun",
    "NextEuro",
    "NormalRange",
    "RollingPoint",
    "RollingSeries",
    "ScenarioMark",
    "ScenarioRow",
    "ScenarioStat",
    "ScenarioStatKey",
    "ScenariosOut",
    "SectionStat",
    "Sensitivity",
    "StressRow",
    "Week52",
]
