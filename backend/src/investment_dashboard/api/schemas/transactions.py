"""Schemas for ``/api/transactions``. Decimals travel as strings."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from pydantic import ConfigDict, Field

from investment_dashboard.api.schemas.common import ApiModel, DecStr
from investment_dashboard.models.transaction import TransactionKind


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


class TransactionSummary(ApiModel):
    count: int
    buy_count: int
    sell_count: int
    avg_trade_size_eur: DecStr
    avg_trade_size_usd: DecStr


class TransactionPage(ApiModel):
    summary: TransactionSummary
    rows: list[TransactionOut]
    total: int
    limit: int
    offset: int


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
