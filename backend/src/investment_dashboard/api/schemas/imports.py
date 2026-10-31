"""Schemas for ``/api/imports`` (upload -> preview -> confirm)."""

from __future__ import annotations

from datetime import datetime

from investment_dashboard.api.schemas.common import ApiModel, DecStr


class ImportIssue(ApiModel):
    message: str
    line: int | None = None
    raw: str = ""


class ImportPreviewRow(ApiModel):
    index: int
    date: str
    settlement_date: str | None = None
    kind: str
    symbol: str | None = None
    quantity: DecStr | None = None
    price_native: DecStr | None = None
    fees_native: DecStr | None = None
    gross_native: DecStr | None = None
    net_native: DecStr | None = None
    currency: str
    description: str | None = None
    is_duplicate: bool


class ImportCounts(ApiModel):
    rows: int
    new: int
    duplicates: int
    sweeps_dropped: int
    errors: int
    warnings: int


class ImportPreview(ApiModel):
    import_id: str
    broker: str
    account_id: int
    filename: str
    counts: ImportCounts
    rows: list[ImportPreviewRow]
    rows_truncated: bool = False
    errors: list[ImportIssue]
    warnings: list[ImportIssue]
    unknown_actions: list[str]
    expires_at: datetime


class ImportConfirmResult(ApiModel):
    import_id: str
    inserted: int
    duplicates: int
    sweeps_dropped: int
    unknown_actions: list[str]
    fx_missing_dates: list[str]
    errors: list[ImportIssue]
    warnings: list[ImportIssue]
    unresolved_symbols: list[str]
