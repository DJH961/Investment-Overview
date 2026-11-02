"""Schemas for ``/api/imports`` (upload -> preview -> confirm)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field

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
    #: Import batch the rows belong to (undo it via ``/api/imports/batches``).
    import_batch_id: int | None = None


class ImportBroker(ApiModel):
    """One available importer plugin."""

    id: str
    label: str
    file_types: list[str]


# -- import history / undo ------------------------------------------------------


class ImportBatchOut(ApiModel):
    id: int
    created_at: datetime
    account_id: int
    account_label: str | None
    broker: str
    filename: str
    #: Rows the import inserted.
    row_count: int
    #: Rows still attached (hand-edited / deleted rows are no longer counted).
    current_rows: int
    duplicate_count: int
    status: Literal["active", "undone"]
    actor: str | None
    undone_at: datetime | None
    undone_by: str | None
    undone_rows: int | None
    can_undo: bool


class ImportBatchList(ApiModel):
    batches: list[ImportBatchOut]
    #: Imports made before batches existed are not listed and cannot be undone.
    note: str


class ImportUndoRow(ApiModel):
    id: int
    date: str
    kind: str
    symbol: str | None
    quantity: DecStr | None
    net_native: DecStr | None
    description: str | None


class ImportUndoPreview(ApiModel):
    batch: ImportBatchOut
    rows: list[ImportUndoRow]
    rows_truncated: bool
    total: int
    detached: int
    earliest_date: str | None
    latest_date: str | None
    confirm_word: str


class ImportUndoRequest(ApiModel):
    confirm: str = ""


class ImportUndoResult(ApiModel):
    batch: ImportBatchOut
    deleted: int
    backup: str | None
    invalidated_from: str | None


class ImportErrorDto(ApiModel):
    detail: str
    errors: dict[str, str]


# -- action mapping ---------------------------------------------------------------


class UnknownAction(ApiModel):
    action: str
    count: int


class UnknownActionsOut(ApiModel):
    """Unknown broker actions in the latest (or given) staged preview."""

    import_id: str | None
    broker: str | None
    filename: str | None
    actions: list[UnknownAction]
    #: What an action can be mapped to: a transaction kind, or ``ignore``.
    targets: list[str]
    #: The broker's saved mapping (``import.action_overrides.<broker>``).
    overrides: dict[str, str]


class ActionOverrideIn(ApiModel):
    action: str = Field(min_length=1, max_length=512)
    #: A target from ``targets``; ``null`` removes the mapping.
    kind: str | None = None


class ActionOverridesOut(ApiModel):
    broker: str
    overrides: dict[str, str]
