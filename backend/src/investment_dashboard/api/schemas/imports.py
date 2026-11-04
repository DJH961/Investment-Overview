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


#: ``keep`` = import as the file has it; ``fix_price`` = recompute the price from
#: amount and quantity; ``skip`` = leave the row out.
RowFix = Literal["keep", "fix_price", "skip"]


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
    #: Left out of the import (the user chose to skip it).
    skipped: bool = False
    #: Consistency warnings for this row as the file has it ("doesn't add up").
    warnings: list[str] = Field(default_factory=list)
    #: Ways to resolve those warnings (see ``ImportResolveRow.action``).
    fixes: list[RowFix] = Field(default_factory=list)
    #: The resolution picked for this row, if any.
    resolution: RowFix | None = None


class ImportCounts(ApiModel):
    rows: int
    new: int
    duplicates: int
    sweeps_dropped: int
    errors: int
    warnings: int
    #: Rows the user chose to leave out.
    skipped: int = 0
    #: Rows with warnings not resolved yet (all rows, not just the preview page).
    unresolved: int = 0


class ImportField(ApiModel):
    """A ledger field a file column can be mapped to."""

    id: str
    label: str
    help: str
    required: bool = False


class ImportColumn(ApiModel):
    """One column of the uploaded table, with what it was matched to."""

    index: int
    header: str
    samples: list[str]
    field: str | None = None
    #: 0..1; ``by`` says how: ``header`` name, cell ``content``, ``user`` choice.
    confidence: float = 0
    by: str | None = None


class ImportQuestion(ApiModel):
    """Something to settle before confirming: pick a column, derive it, or cancel."""

    field: str
    message: str
    can_derive: bool = False
    derive_hint: str = ""


class ImportLayout(ApiModel):
    """How the flexible reader sees the file (the page's column editor)."""

    sheets: list[str]
    sheet: int
    #: 0-based grid row of the header; ``None`` = the file has no header row.
    header_row: int | None
    columns: list[ImportColumn]
    fields: list[ImportField]
    decimal: Literal[".", ","]
    date_order: Literal["MDY", "DMY", "YMD"]
    derive: list[str]
    questions: list[ImportQuestion]
    notes: list[str]
    #: Key "remember" saves the layout under (empty when there is no header row).
    signature: str


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
    #: ``standard`` = the broker's own parser read it; ``flexible`` = the
    #: flexible reader did (``layout`` is what it used).
    parser: Literal["standard", "flexible"] = "standard"
    layout: ImportLayout | None = None
    #: False while a layout question is open (confirm would be refused).
    can_confirm: bool = True


class ImportLayoutIn(ApiModel):
    """Corrections from the column editor; re-parses the staged file."""

    #: field id -> column index, or ``null`` for "this file has no such column".
    columns: dict[str, int | None] = Field(default_factory=dict)
    decimal: Literal[".", ","] | None = None
    date_order: Literal["MDY", "DMY", "YMD"] | None = None
    #: Fields to work out from the others (``price``, ``quantity``, ``amount``).
    derive: list[Literal["price", "quantity", "amount"]] = Field(default_factory=list)
    header_row: int | None = -1
    sheet: int | None = None
    #: Remember this layout for future files with the same column names.
    remember: bool = False


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


class ImportResolveRow(ApiModel):
    index: int
    #: ``null`` clears an earlier choice.
    action: RowFix | None = None


class ImportResolveIn(ApiModel):
    """Resolutions for flagged preview rows (by preview row ``index``)."""

    rows: list[ImportResolveRow] = Field(min_length=1)


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
