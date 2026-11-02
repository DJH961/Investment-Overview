"""Schemas for ``/api/settings``."""

from __future__ import annotations

from datetime import datetime
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


# -- v2: registry-driven settings (``/api/settings/schema|values|...``) ----------

#: A setting value as JSON: decimals are strings, lists stay lists, maps objects.
SettingJson = bool | int | str | list[str] | dict[str, str] | None

SettingTypeName = Literal[
    "bool",
    "int",
    "decimal",
    "percent",
    "string",
    "enum",
    "symbol",
    "symbol_list",
    "percent_list",
    "time_hm",
    "duration_s",
    "json_map",
]


class SettingSection(ApiModel):
    id: str
    label: str


class SettingField(ApiModel):
    key: str
    type: SettingTypeName
    section: str
    label: str
    help: str
    default: SettingJson = Field(description="Default value (null for secrets).")
    min: DecStr | None = None
    max: DecStr | None = None
    choices: list[str]
    level: Literal["user", "advanced"]
    secret: bool = Field(description="Write-only: the value is never returned.")
    nullable: bool
    restart_required: bool
    env_var: str | None = Field(description="Env var that supplies a fallback value.")
    env_bound: Literal["ceiling", "floor"] | None = Field(
        description="Env value bounds the app value (security settings)."
    )
    danger: str | None
    unit: str | None
    since: str


class SettingsSchemaDto(ApiModel):
    sections: list[SettingSection]
    fields: list[SettingField]


class SettingValueDto(ApiModel):
    value: SettingJson = Field(description="Effective value; always null for secrets.")
    source: Literal["db", "env", "default"]
    default: SettingJson
    env_value_present: bool
    modified_at: datetime | None
    is_set: bool = Field(description="A value is in effect (the only info for secrets).")
    stored_invalid: bool = Field(description="The stored value was unreadable and is ignored.")


class SettingsValuesDto(ApiModel):
    values: dict[str, SettingValueDto]


class SettingsPatch(ApiModel):
    model_config = ConfigDict(extra="forbid")

    changes: dict[str, SettingJson] = Field(
        description="key -> new value; null clears a nullable setting."
    )


class SettingsErrorDto(ApiModel):
    detail: str
    errors: dict[str, str] = Field(description="Per-key messages.")


class SettingsChangedDto(ApiModel):
    changed: list[str]
    values: dict[str, SettingValueDto]


class SettingsReset(ApiModel):
    model_config = ConfigDict(extra="forbid")

    keys: list[str] | None = None
    section: str | None = None
    all: bool = False


class SettingsAuditRow(ApiModel):
    id: int
    key: str
    old_value: str | None = Field(description="Stored text; '<redacted>' for secrets.")
    new_value: str | None
    changed_at: datetime
    actor: str
    action: Literal["set", "reset", "import", "revert"]
    request_id: str | None


class SettingsHistoryDto(ApiModel):
    rows: list[SettingsAuditRow]


class SettingsExportDto(ApiModel):
    kind: str
    version: int
    exported_at: str
    settings: dict[str, SettingJson]


class SettingsImportDiff(ApiModel):
    key: str
    current: SettingJson
    new: SettingJson


class SettingsImportResult(ApiModel):
    dry_run: bool
    diff: list[SettingsImportDiff]
