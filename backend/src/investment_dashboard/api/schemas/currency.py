"""Schemas for ``GET /api/currency/both`` (the Currency page: strip + Today, v7.0).

Rates are always USD per 1 EUR ("EUR/USD") unless a field says ``_display``
(quoted as ``today.pair``). Fractions: 0.01 = 1 %. Money is in the side's own
currency, computed in it (never converted from the other side).
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.deps import Ccy
from investment_dashboard.api.schemas.common import ApiModel, DecStr
from investment_dashboard.api.schemas.overview import CurrencyLifetime, CurrencyToday, ReturnSplit

#: Strip tiles shipped in 7.0. 7.2 adds keys; a tile without data is not sent.
StatKey = Literal[
    "rate_now",
    "effect_today",
    "investing_power_today",
    "lifetime_effect",
    "avg_rate_vs_now",
    "one_cent",
]
StatUnit = Literal["rate", "fraction", "money"]


class CurrencyStat(ApiModel):
    """One strip tile (the ``stats`` shape push 6 extends)."""

    key: StatKey
    value: DecStr
    #: ``rate``: USD per 1 EUR; ``fraction``: 0.01 = 1 %; ``money``: in ``currency``.
    unit: StatUnit
    currency: Ccy | None = None
    secondary: DecStr | None = None
    secondary_unit: StatUnit | None = None
    secondary_currency: Ccy | None = None
    #: Tailwind / headwind word for the side's reader; null when it does not apply.
    kind: Literal["tailwind", "headwind", "neutral"] | None = None


class CurrencyRateRange(ApiModel):
    """Today's EUR/USD low and high from the stored intraday samples (market hours)."""

    session_date: str
    low: DecStr
    high: DecStr
    #: ``low``/``high`` quoted as ``today.pair`` (in the EUR view the reciprocals,
    #: so ``low_display`` comes from ``high``).
    low_display: DecStr
    high_display: DecStr
    samples: int
    first_at: str
    last_at: str


class CurrencyBuys(ApiModel):
    """ "€X buys $Y; yesterday $Z" (``domain/session_fx.fx_buying_power_split``).

    ``amount_eur`` is the owner's regular investment amount, the same setting the
    Overview's investing-power card uses (``investing_power.amount_eur``, default
    €100); print it with the line. USD figures are that amount at one rate each.
    """

    #: The owner's investing-power amount in EUR (default 100).
    amount_eur: DecStr
    usd_now: DecStr
    usd_prev: DecStr | None = None
    change_usd: DecStr | None = None
    market_hours_usd: DecStr | None = None
    overnight_usd: DecStr | None = None


class CurrencyOneCent(ApiModel):
    """The book's value at the rate and at the rate + 0.01, one instant, this side's ccy."""

    rate: DecStr
    value_at_rate: DecStr
    value_at_rate_plus: DecStr
    #: ``value_at_rate_plus - value_at_rate``: what one cent of EUR/USD is worth.
    change: DecStr


class CurrencyOut(ApiModel):
    ccy: Ccy
    as_of: str
    generated_at: str
    #: Exactly the Overview's ``currency.today`` for this side.
    today: CurrencyToday
    #: Exactly the Overview's ``currency.lifetime``.
    lifetime: CurrencyLifetime
    #: Exactly the Overview's ``currency.return_split``.
    return_split: ReturnSplit
    rate_range: CurrencyRateRange | None = None
    buys: CurrencyBuys | None = None
    one_cent: CurrencyOneCent | None = None
    stats: list[CurrencyStat] = Field(default_factory=list)


__all__ = [
    "CurrencyBuys",
    "CurrencyOneCent",
    "CurrencyOut",
    "CurrencyRateRange",
    "CurrencyStat",
]
