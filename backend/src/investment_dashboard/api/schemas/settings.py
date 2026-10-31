"""Schemas for ``/api/settings``."""

from __future__ import annotations

from typing import Literal

from pydantic import ConfigDict, Field

from investment_dashboard.api.schemas.common import ApiModel, DecStr

Theme = Literal["auto", "light", "dark"]
ClockFormat = Literal["auto", "12h", "24h"]
DisplayCcy = Literal["EUR", "USD"]


class SettingsOptions(ApiModel):
    currencies: list[str]
    themes: list[str]
    clock_formats: list[str]
    timezones: list[str]
    auto_refresh_min_seconds: int
    auto_refresh_max_seconds: int
    investment_amount_min_eur: DecStr
    investment_amount_max_eur: DecStr
    chart_pref_keys: dict[str, list[str] | None] = Field(
        description="Allowed chart-pref keys; a list is the allowed values, null = free text."
    )


class SettingsDto(ApiModel):
    display_ccy: DisplayCcy
    theme: Theme
    timezone: str
    clock_format: ClockFormat
    auto_refresh_seconds: int
    investment_amount_eur: DecStr
    chart_prefs: dict[str, str]
    onboarded: bool = Field(description="At least one account exists (read-only).")
    options: SettingsOptions


class SettingsUpdate(ApiModel):
    """Partial update: only the fields present are changed."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    display_ccy: DisplayCcy | None = None
    theme: Theme | None = None
    timezone: str | None = None
    clock_format: ClockFormat | None = None
    auto_refresh_seconds: int | None = Field(default=None, ge=15, le=3600)
    investment_amount_eur: DecStr | None = None
    chart_prefs: dict[str, str] | None = None
