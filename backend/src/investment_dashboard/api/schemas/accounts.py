"""Schemas for ``/api/accounts`` and ``/api/instruments``."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel

BrokerId = Literal["vanguard", "fidelity", "savings_bank"]
AccountType = Literal["brokerage", "savings", "cash"]


class AccountIn(ApiModel):
    account_label: str = Field(min_length=1, max_length=128)
    broker: BrokerId
    native_currency: str = Field(min_length=3, max_length=3)
    account_type: AccountType | None = None


class AccountOut(ApiModel):
    id: int
    account_label: str
    broker: str
    native_currency: str
    account_type: str | None
    active: bool
    transaction_count: int


class InstrumentOut(ApiModel):
    id: int
    symbol: str
    name: str | None
    asset_class: str
    native_currency: str
