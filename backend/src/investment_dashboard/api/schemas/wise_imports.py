"""Schemas for ``/api/imports/wise`` (Wise statement -> conversions)."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel, DecStr

WiseRowStatus = Literal["conversion", "skipped", "ignored", "unsupported"]


class WiseColumnField(ApiModel):
    id: str
    label: str
    required: bool
    #: Column index the field is mapped to (``None`` = not found).
    column: int | None


class WisePreviewRow(ApiModel):
    #: The row's line in the file; the key the confirm choices use.
    line: int
    external_id: str
    date: str | None
    status: WiseRowStatus
    #: Why the row is not importable (skipped / ignored / unsupported rows).
    reason: str | None = None
    description: str | None = None
    eur_sent: DecStr | None = None
    fees_eur: DecStr | None = None
    usd_received: DecStr | None = None
    #: usd_received / eur_sent.
    rate: DecStr | None = None
    #: The fee is on the statement row (otherwise derived from the quoted rate).
    fee_stated: bool = False
    #: A send-with-conversion: the dollars went straight on, so kept defaults to 0.
    sent_on: bool = False
    is_duplicate: bool = False
    warnings: list[str] = Field(default_factory=list)


class WiseCounts(ApiModel):
    rows: int
    new: int
    duplicates: int
    skipped: int


class WisePreview(ApiModel):
    import_id: str
    filename: str
    counts: WiseCounts
    rows: list[WisePreviewRow]
    headers: list[str]
    fields: list[WiseColumnField]
    #: Required columns that were not found: the page asks the owner to map them.
    missing: list[str]
    #: The setting "Import: ignore conversions not into USD" as it applied to this preview.
    ignore_non_usd: bool
    expires_at: datetime


class WiseLayoutIn(ApiModel):
    columns: dict[str, int | None]


class WiseRowChoiceIn(ApiModel):
    line: int
    skip: bool = False
    kept_usd: Decimal = Field(default=Decimal(0), ge=0)


class WiseConfirmIn(ApiModel):
    rows: list[WiseRowChoiceIn] = Field(default_factory=list)


class WiseConfirmResult(ApiModel):
    import_id: str
    imported: int
    skipped: int
    duplicates: int
