"""Schemas for ``GET /api/currency/effect/both?range=`` (Currency page, Impact section, 7.2).

One payload per reporting currency (``ByCurrency``). Each side is built in its own
currency: in the EUR view the effect is what the rate did to the non-EUR holdings
(the dollars), in the USD view what it did to the non-USD holdings (the euros).

Conventions:

* **Money** (``DecStr``) is in the side's own currency (``ccy``): sums of daily
  parts, each part valued at its own day's rate (never converted afterwards).
* **Fractions**: 0.01 = 1 %. ``effect_pp`` is a fraction of points: EUR return
  minus USD return, both computed on their own (``-0.012`` = -1.2 pp).
* **Rates**: USD per 1 EUR ("EUR/USD").
* **Kinds**: ``tailwind`` = the currency added value for this side's reader,
  ``headwind`` = it took value away, ``neutral`` = zero.
* Every identity is exact on the server: ``bridge.start + deposits + market +
  currency == bridge.end``; ``months`` sum to the range's currency effect;
  ``session_split.inside + outside == covered_currency``.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.deps import Ccy
from investment_dashboard.api.schemas.common import ApiModel, DecStr

#: ``1d|1w|1m|3m|ytd|1y|3y|5y|10y|all`` or a calendar year (``2025``).
EFFECT_RANGE_PATTERN = r"^(1d|1w|1m|3m|ytd|1y|3y|5y|10y|all|\d{4})$"

EffectKind = Literal["tailwind", "headwind", "neutral"]
EffectGranularity = Literal["intraday", "daily", "weekly"]
#: How the headline returns were computed, each currency on its own: ``daily_chain``
#: = the hardened daily time-weighted chain over the lifetime's days, sliced to the
#: range (every range but 1D, All included; a day the book does not see the money of
#: yet is merged with the next days); ``day`` = the Overview's own day growth of
#: each side (1D).
ReturnBasis = Literal["daily_chain", "day"]
#: What the headline leads with: ``effect`` = the money effect on this side's book;
#: ``gap`` = the euro return minus the dollar return (when the rate did nothing to
#: this side's book, e.g. the USD view of an all-dollar portfolio).
#: ``deposits`` = the USD view's investing effect (``investing.effect``: what the rate
#: did to the euros you sent into your dollar accounts).
HeadlineLead = Literal["effect", "gap", "deposits"]

EffectStatKey = Literal[
    "eur_return",
    "usd_return",
    "effect_pp",
    "effect",
    "currency_share",
    "best_month",
    "worst_month",
    "tailwind_share",
    "longest_tailwind",
    "longest_headwind",
    "typical_day",
    "largest_day",
    "months_of_contributions",
    "inside_hours",
    "outside_hours",
    "rate_range_today",
    "buys_now",
]
#: ``count``: a plain number (months in a run).
EffectStatUnit = Literal["rate", "fraction", "money", "count"]


class EffectHeadline(ApiModel):
    """EUR return, USD return, the effect between them and the effect in money."""

    #: EUR return of the range (EUR cashflow stream), fraction; null when unknown.
    eur_return: DecStr | None = None
    #: USD return of the range (USD cashflow stream), fraction; null when unknown.
    usd_return: DecStr | None = None
    #: ``eur_return - usd_return`` (fraction points); null when either is missing.
    effect_pp: DecStr | None = None
    #: The range's currency effect in ``ccy`` (sum of the daily currency parts).
    effect: DecStr
    #: The range's market part in ``ccy`` (price moves, dividends, interest).
    market: DecStr
    #: Share of the period's change the currency explains, 0..1:
    #: ``|currency| / (|market| + |currency|)``; null when both are zero or the
    #: rate did nothing to this side's book.
    currency_share: DecStr | None = None
    #: Follows the lead figure: the money effect (``lead == "effect"``) or the gap
    #: (``lead == "gap"``: tailwind = the euro result is the higher one).
    kind: EffectKind
    lead: HeadlineLead = "effect"
    return_basis: ReturnBasis
    #: Why the money figure and the gap point different ways, when they do.
    note: str | None = None
    #: ``lead == "gap"`` only: the other side's money effect, in ``other_ccy`` (the
    #: USD view gets the EUR side's own effect: what the gap is in euros).
    other_effect: DecStr | None = None
    other_ccy: Ccy | None = None


class EffectPoint(ApiModel):
    """One point of the constant-currency chart.

    ``constant_currency = value - currency``: the actual value minus the currency
    effect accumulated since the range start (each rate move counted only for the
    money held when it happened). The gap between the two lines is ``currency``.
    """

    #: ISO date (daily/weekly) or ISO datetime in UTC (intraday).
    t: str
    value: DecStr
    constant_currency: DecStr
    #: Currency effect accumulated since the range start, ``ccy``.
    currency: DecStr


class EffectBridge(ApiModel):
    """``start + deposits + market + currency == end`` exactly, in ``ccy``."""

    #: The close the range starts from (ISO date).
    start_on: str
    end_on: str
    start: DecStr
    #: Net external flows (deposits minus withdrawals) at their own dates' rates.
    deposits: DecStr
    market: DecStr
    currency: DecStr
    end: DecStr


class EffectBar(ApiModel):
    """One month (``YYYY-MM``) or year (``YYYY``) of the currency effect."""

    label: str
    currency: DecStr
    kind: EffectKind


class EffectGridRow(ApiModel):
    """One year of the month x year grid: 12 cells (Jan..Dec), null = no data."""

    year: int
    months: list[DecStr | None] = Field(min_length=12, max_length=12)
    total: DecStr
    kind: EffectKind


class EffectRollingPoint(ApiModel):
    """Currency effect summed over the ``rolling_window_days`` business days to ``t``."""

    t: str
    currency: DecStr


class EffectRun(ApiModel):
    """The current streak of same-sign months (lifetime), e.g. "helped 7 months running"."""

    kind: Literal["tailwind", "headwind"]
    months: int
    #: First month of the streak, ``YYYY-MM``.
    since: str
    #: The streak's summed effect, ``ccy``.
    currency: DecStr
    #: One plain sentence, ready to print.
    statement: str


class EffectRecord(ApiModel):
    """A record: a day (ISO date), month (``YYYY-MM``) or year (``YYYY``)."""

    label: str
    currency: DecStr


class EffectRecords(ApiModel):
    """Best / worst currency day, month and year of the range, plus lifetime figures."""

    best_day: EffectRecord | None = None
    worst_day: EffectRecord | None = None
    best_month: EffectRecord | None = None
    worst_month: EffectRecord | None = None
    best_year: EffectRecord | None = None
    worst_year: EffectRecord | None = None
    #: Lifetime currency effect, day by day (the All range's figure), ``ccy``.
    lifetime_effect: DecStr | None = None
    #: The average monthly net contribution over the lifetime, ``ccy``.
    average_monthly_contribution: DecStr | None = None
    #: ``lifetime_effect / average_monthly_contribution``: "= 3.2 monthly deposits".
    lifetime_months_of_contributions: DecStr | None = None


class HoldingEffect(ApiModel):
    """One holding's change over the range, three ways, in ``ccy``.

    ``price + dividends + currency == total``. ``price``: the change in value not
    explained by flows or the rate (the holding's market move); ``dividends``:
    paid in the range, each at its own date's rate; ``currency``: each day's
    holding revalued from the previous day's rate to that day's.
    """

    instrument_id: int
    symbol: str
    name: str | None = None
    native_ccy: str
    price: DecStr
    dividends: DecStr
    currency: DecStr
    total: DecStr


class SessionSplit(ApiModel):
    """The range's currency effect inside vs outside US market hours.

    Only days with recorded session open/close rates are split
    (``covered_currency``); earlier days are ``uncovered_currency``.
    ``inside + outside == covered_currency`` exactly;
    ``covered_currency + uncovered_currency`` = the range's currency effect.
    """

    inside: DecStr
    outside: DecStr
    covered_currency: DecStr
    uncovered_currency: DecStr
    #: First session date with recorded rates (ISO), null when none is recorded.
    available_from: str | None = None
    #: "split not available before <date>" when part of the range is uncovered.
    note: str | None = None


class EffectBuys(ApiModel):
    """ "€1,000 buys $X; yesterday $Y" (``domain/session_fx.fx_buying_power_split``)."""

    amount_eur: DecStr
    usd_now: DecStr
    usd_prev: DecStr | None = None
    change_usd: DecStr | None = None
    market_hours_usd: DecStr | None = None
    overnight_usd: DecStr | None = None


class EffectStat(ApiModel):
    """One Impact tile (same shape as the strip's ``CurrencyStat``)."""

    key: EffectStatKey
    value: DecStr
    unit: EffectStatUnit
    currency: Ccy | None = None
    secondary: DecStr | None = None
    secondary_unit: EffectStatUnit | None = None
    secondary_currency: Ccy | None = None
    #: A date (ISO), month (``YYYY-MM``) or year the figure belongs to.
    label: str | None = None
    kind: EffectKind | None = None


class DepositEffectRow(ApiModel):
    """One USD deposit against the range's start rate (the investing view)."""

    transaction_id: int
    #: ISO date.
    on: str
    #: Dollars received, native.
    usd: DecStr
    #: Euros it cost: your recorded conversions where matched, else the ECB fixing.
    eur: DecStr
    #: ``usd / eur``: the rate you got (USD per EUR).
    rate: DecStr
    start_rate: DecStr
    #: ``usd - eur * start_rate`` (dollars): positive = your euros bought more.
    effect: DecStr
    source: Literal["matched", "partly", "ecb"]


class RateOnly(ApiModel):
    """EUR 1,000 at the range start's rate and at its end's (the rate alone)."""

    amount_eur: DecStr
    start_rate: DecStr
    end_rate: DecStr
    usd_at_start: DecStr
    usd_now: DecStr
    change: DecStr
    kind: EffectKind


class InvestingEffect(ApiModel):
    """The USD view's investing perspective (``readmodels/currency_deposits``).

    Your euros become dollars: each USD deposit's dollars minus what its euros would
    have bought at ``start_rate`` (the rate on the range's start close; for All the
    rate on your first transaction's day). Money in dollars. ``series`` is the
    cumulative dollars received (``value``) and the same euros at the start rate
    (``constant_currency``), so the gap between them (``currency``) is the effect.
    ``months`` / ``years`` / ``grid`` / ``records`` / ``rolling`` are the same shapes
    as the EUR view's, built on this effect (``records.best_day`` = best deposit).
    """

    start_on: str
    end_on: str
    start_rate: DecStr
    end_rate: DecStr
    effect: DecStr
    kind: EffectKind
    deposit_count: int
    eur_sent: DecStr
    usd_received: DecStr
    #: ``eur_sent * start_rate``: the dollars at the start rate.
    usd_at_start: DecStr
    #: ``usd_received / eur_sent`` over the range; null without deposits.
    average_rate: DecStr | None = None
    series: list[EffectPoint] = Field(default_factory=list)
    months: list[EffectBar] = Field(default_factory=list)
    years: list[EffectBar] = Field(default_factory=list)
    grid: list[EffectGridRow] = Field(default_factory=list)
    #: At each week end: the deposits of the 12 months before it against the rate
    #: 12 months earlier.
    rolling: list[EffectRollingPoint] = Field(default_factory=list)
    records: EffectRecords = Field(default_factory=EffectRecords)
    #: The range's deposits, largest effect first.
    deposits: list[DepositEffectRow] = Field(default_factory=list)
    rate_only: RateOnly
    stats: list[EffectStat] = Field(default_factory=list)


class CurrencyEffectOut(ApiModel):
    ccy: Ccy
    #: The requested range key (``1d`` .. ``all`` or a year).
    range: str
    as_of: str
    generated_at: str
    #: The close the range starts from and its last close (ISO dates).
    start_on: str | None = None
    end_on: str | None = None
    granularity: EffectGranularity
    headline: EffectHeadline
    series: list[EffectPoint] = Field(default_factory=list)
    bridge: EffectBridge | None = None
    months: list[EffectBar] = Field(default_factory=list)
    years: list[EffectBar] = Field(default_factory=list)
    grid: list[EffectGridRow] = Field(default_factory=list)
    #: Rolling 12-month effect (lifetime series, the points inside the range).
    rolling: list[EffectRollingPoint] = Field(default_factory=list)
    rolling_window_days: int = 252
    run: EffectRun | None = None
    records: EffectRecords = Field(default_factory=EffectRecords)
    holdings: list[HoldingEffect] = Field(default_factory=list)
    session_split: SessionSplit | None = None
    #: 1D / 1W only.
    buys: EffectBuys | None = None
    stats: list[EffectStat] = Field(default_factory=list)
    #: An info-tip sentence (the All range: why it differs from the Overview card).
    explainer: str | None = None
    #: Days in the range a broker account's cash would have gone below zero (the
    #: book holds each account's idle cash; a shortfall is counted as a deposit).
    missing_deposit_days: int = 0
    #: One plain sentence about those days for a tip; null when there are none.
    book_note: str | None = None
    #: USD view only: the investing perspective (null without USD deposits).
    investing: InvestingEffect | None = None


__all__ = [
    "EFFECT_RANGE_PATTERN",
    "CurrencyEffectOut",
    "DepositEffectRow",
    "EffectBar",
    "EffectBridge",
    "EffectBuys",
    "EffectGridRow",
    "EffectHeadline",
    "EffectPoint",
    "EffectRecord",
    "EffectRecords",
    "EffectRollingPoint",
    "EffectRun",
    "EffectStat",
    "HoldingEffect",
    "InvestingEffect",
    "RateOnly",
    "SessionSplit",
]
