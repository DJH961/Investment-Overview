"""Schemas for ``/api/instruments`` (the instruments editor)."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel

PricingMode = Literal["auto", "manual", "delisted"]
AssetClass = Literal["etf", "mutual_fund", "stock", "cash", "savings", "unknown"]


class InstrumentOut(ApiModel):
    """One instrument with its effective values and the ledger values underneath.

    ``name`` / ``asset_class`` / ``expense_ratio`` are the effective values
    (override, else ledger). ``fetch_symbol`` is the ticker sent to the price
    provider, ``null`` when nothing is fetched (cash, inactive, manual, delisted).
    ``native_currency`` is read-only.
    """

    id: int
    symbol: str
    name: str | None
    ledger_name: str | None
    name_override: str | None
    asset_class: str
    ledger_asset_class: str
    asset_class_override: str | None
    native_currency: str
    expense_ratio: str | None = Field(description="Fraction as a decimal string (0.0003).")
    expense_ratio_override: str | None
    category: str | None
    active: bool
    provider_symbol: str | None
    fetch_symbol: str | None
    pricing_mode: PricingMode
    transaction_count: int
    latest_price_date: str | None


class InstrumentPatch(ApiModel):
    """Only the fields sent are changed; ``null`` clears an override."""

    name: str | None = None
    asset_class: AssetClass | None = None
    expense_ratio: str | None = Field(default=None, description='Fraction, e.g. "0.0003".')
    category: str | None = None
    active: bool | None = None
    provider_symbol: str | None = None
    pricing_mode: PricingMode | None = None


class InstrumentUpdateResult(ApiModel):
    instrument: InstrumentOut
    changed: list[str]
    redownload_suggested: bool = Field(
        description="The price mapping changed: offer job prices.redownload for this instrument."
    )


class InstrumentErrorDto(ApiModel):
    detail: str
    errors: dict[str, str]
