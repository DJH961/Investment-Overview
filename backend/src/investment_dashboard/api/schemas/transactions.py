"""Schemas for ``/api/transactions``. Decimals travel as strings."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from pydantic import ConfigDict, Field

from investment_dashboard.api.schemas.common import ApiModel, DecStr
from investment_dashboard.domain.kinds import TransactionKind


class TransactionOut(ApiModel):
    id: int
    date: str
    settlement_date: str | None = None
    account_id: int | None = None
    account: str
    instrument_id: int | None = None
    kind: str
    symbol: str
    currency: str = Field(description="Native currency of the account.")
    quantity: DecStr | None = None
    price_native: DecStr | None = None
    fees_native: DecStr | None = None
    gross_native: DecStr | None = None
    net_native: DecStr | None = None
    net_eur: DecStr | None = None
    net_usd: DecStr | None = None
    source: str | None = None
    description: str | None = None
    external_id: str | None = None
    is_settlement_leg: bool = False
    fx_incomplete: bool = Field(
        default=False, description="A frozen EUR/USD leg is missing (FX history gap)."
    )
    cash_eur: DecStr | None = Field(
        default=None,
        description="Net cash in EUR from net_native at the trade date's rate (null: no rate).",
    )
    cash_usd: DecStr | None = Field(
        default=None,
        description="Net cash in USD from net_native at the trade date's rate (null: no rate).",
    )


class TransactionSummary(ApiModel):
    count: int
    buy_count: int
    sell_count: int
    avg_trade_size_eur: DecStr
    avg_trade_size_usd: DecStr


class TransactionMonth(ApiModel):
    """Totals of one month over the whole filter (trade-date FX per row)."""

    month: str = Field(description="YYYY-MM")
    count: int
    net_eur: DecStr
    net_usd: DecStr
    fx_incomplete: bool = Field(default=False, description="Rows without a rate were left out.")


class TransactionPage(ApiModel):
    summary: TransactionSummary
    rows: list[TransactionOut]
    months: list[TransactionMonth] = Field(default_factory=list)
    total: int
    limit: int
    offset: int
    sort: str = "date"
    order: str = "desc"


class TransactionAll(ApiModel):
    """The whole ledger in one answer (the client filters, sorts and pages it)."""

    rows: list[TransactionOut]


class ReconcileRequest(ApiModel):
    """Quantity x price = total check for the manual-entry form (magnitudes)."""

    model_config = ConfigDict(extra="forbid")

    quantity: Decimal | None = None
    price: Decimal | None = None
    total: Decimal | None = None


class ReconcileResult(ApiModel):
    quantity: DecStr | None = None
    price: DecStr | None = None
    total: DecStr | None = None
    error: str | None = None
    #: Which field the server filled in (``None`` if nothing was missing).
    filled: str | None = None


class TransactionWrite(ApiModel):
    """Body for create and edit. Type positive magnitudes; the server applies signs."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    account_id: int
    date: dt.date
    kind: TransactionKind
    symbol: str | None = Field(default=None, max_length=32)
    quantity: Decimal | None = Field(default=None, ge=0)
    price: Decimal | None = Field(default=None, ge=0)
    total: Decimal | None = Field(default=None, ge=0)
    fees: Decimal | None = Field(default=None, ge=0)
    description: str | None = Field(default=None, max_length=512)
    route_money_market: bool = Field(
        default=False,
        description="Create: also buy/sell the account's money-market fund for cash moves.",
    )


class TransactionWriteResult(ApiModel):
    transaction: TransactionOut
    warnings: list[str] = Field(default_factory=list)
