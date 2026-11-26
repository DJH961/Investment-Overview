"""Schemas for "Follow your dollars" (7.4 contract §8).

* ``GET /api/currency/journey`` -> :class:`JourneyBoth` (``eur`` / ``usd`` views)
* ``GET /api/trail/{kind}/{id}`` -> :class:`TrailOut`
* ``POST /api/cash-out/preview`` -> :class:`CashOutOut` (nothing is saved)

Money is a decimal string rounded to the cent, rates have 4 decimals (USD per 1 EUR),
fractions are 0.01 = 1 %, dates are ISO. In the USD view every amount is native
dollars; the euro-only figures are ``null``.
"""

from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel, DecStr


class JourneyBucket(ApiModel):
    """One place the dollars are now: native dollars, their EUR cost and EUR value now."""

    usd: DecStr
    #: The pool's book EUR (original euros plus market EUR realised into them).
    eur_cost: DecStr | None = None
    #: ``usd / rate_now`` (one instant).
    eur_now: DecStr | None = None
    #: The rate's part: ``eur_now - eur_cost`` (minus the market part for holdings).
    currency_eur: DecStr | None = None
    #: Original dollar cost in the USD view (rate-free native dollars), if applicable.
    usd_cost: DecStr | None = None


class JourneyInvested(JourneyBucket):
    #: ``(value - native cost) / rate_now``.
    market_eur: DecStr | None = None
    #: Native dollar gain ``(value - native cost)``.
    market_usd: DecStr | None = None


class JourneyYourRate(ApiModel):
    #: Your conversions' blend: dollars received over all-in euros.
    rate: DecStr | None = None
    #: The ECB fixing over the same conversions (weighted by their dollars).
    ecb_avg: DecStr | None = None
    #: The live rate the buckets are valued at.
    now: DecStr | None = None


class JourneyStats(ApiModel):
    """Always four tiles."""

    usd_account: JourneyBucket
    broker_cash: JourneyBucket
    invested: JourneyInvested
    your_rate: JourneyYourRate


BridgeKey = Literal["conversion_cost", "waiting", "cash", "holdings", "realised"]


class JourneyBridgeLine(ApiModel):
    key: BridgeKey
    eur: DecStr


class JourneyBridge(ApiModel):
    """Where the currency effect came from (EUR view only); the lines add up to the total."""

    lines: list[JourneyBridgeLine]
    #: Equals the Overview card's ``lifetime.fx_pnl_eur``.
    total_eur: DecStr


class JourneyIdle(ApiModel):
    """Dollars a conversion delivered that no deposit took, waiting over 30 days."""

    conversion_id: int
    date: dt.date
    usd: DecStr
    days: int


class JourneyBackInEuros(ApiModel):
    count: int
    eur_received: DecStr
    orig_eur: DecStr
    realised_eur: DecStr


class CashOutEur(ApiModel):
    put_in: DecStr | None = None
    market: DecStr | None = None
    currency: DecStr | None = None
    conversion_cost: DecStr | None = None
    realised: DecStr | None = None
    realised_pct: DecStr | None = None
    #: Money-weighted EUR return a year (from euros only).
    xirr: DecStr | None = None


class CashOutUsd(ApiModel):
    """Dollars only, from native USD flows (never euros times a rate)."""

    put_in: DecStr | None = None
    market: DecStr | None = None
    realised: DecStr | None = None
    realised_pct: DecStr | None = None
    xirr: DecStr | None = None


class CashOutOut(ApiModel):
    #: ``null`` for a preview.
    conversion_id: int | None = None
    date: dt.date
    usd_sent: DecStr
    eur_received: DecStr
    fees_eur: DecStr
    eur: CashOutEur
    usd: CashOutUsd
    #: One sentence comparing the yearly euro and dollar results.
    note: str
    flagged: bool = False


class JourneyFlagged(ApiModel):
    uncovered_buys: int = 0
    ecb_fallback_deposits: int = 0


class JourneyView(ApiModel):
    stats: JourneyStats
    bridge: JourneyBridge | None = None
    idle: list[JourneyIdle] = Field(default_factory=list)
    back_in_euros: JourneyBackInEuros | None = None
    cash_outs: list[CashOutOut] = Field(default_factory=list)
    flagged: JourneyFlagged


class JourneyBoth(ApiModel):
    eur: JourneyView
    usd: JourneyView


# -- trail ----------------------------------------------------------------------------

TrailKind = Literal["deposit", "buy", "sell", "withdrawal", "conversion"]
StepKey = Literal[
    "sent", "converted", "waited", "deposited", "bought", "sold", "withdrawn", "back", "worth_now"
]


class TrailStep(ApiModel):
    key: StepKey
    date: dt.date | None = None
    label: str
    figure: str | None = None
    figure_ccy: Literal["EUR", "USD"] | None = None
    #: At most 24 characters (the trail's aligned rows never wrap).
    detail: str | None = Field(default=None, max_length=24)
    link: str | None = None
    #: Signed change shown with the figure ("worth now" gain, "back" realised), or null.
    change: DecStr | None = None


class TrailPath(ApiModel):
    #: This path's share of the transaction's dollars (fraction).
    usd_share: DecStr | None = None
    steps: list[TrailStep]


class TrailSplit(ApiModel):
    """For a buy: its value now; for a cash-out: what was realised."""

    market_eur: DecStr
    currency_eur: DecStr
    conversion_cost_eur: DecStr
    total_eur: DecStr


class TrailOut(ApiModel):
    kind: TrailKind
    id: int
    paths: list[TrailPath]
    #: Paths beyond the first 3 ("and N more").
    more_paths: int = 0
    split: TrailSplit | None = None
    your_rate: DecStr | None = None
    ecb_rate: DecStr | None = None
    flagged: bool = False


# -- cash-out preview -------------------------------------------------------------------


class CashOutPreviewIn(ApiModel):
    withdrawal_id: int | None = None
    usd_sent: DecStr
    eur_received: DecStr
    fees_eur: DecStr = "0"
    date: dt.date
