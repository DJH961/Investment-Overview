"""``/api/imports``: upload -> preview (nothing written) -> confirm / discard."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status

from investment_dashboard.adapters.importer_types import RowIssue
from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.common import OkResponse
from investment_dashboard.api.schemas.imports import (
    ImportBroker,
    ImportConfirmResult,
    ImportCounts,
    ImportIssue,
    ImportPreview,
    ImportPreviewRow,
)
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.services import import_staging
from investment_dashboard.services.importer_service import Broker

router = APIRouter(tags=["imports"])

#: Preview rows returned per upload (counts always cover the whole file).
PREVIEW_ROW_LIMIT = 500


def _issues(items: Sequence[RowIssue]) -> list[ImportIssue]:
    return [ImportIssue(message=i.message, line=i.line, raw=i.raw) for i in items]


def _preview(staged: import_staging.StagedImport) -> ImportPreview:
    rows = []
    for pr in staged.rows[:PREVIEW_ROW_LIMIT]:
        r = pr.row
        rows.append(
            ImportPreviewRow(
                index=pr.index,
                date=r.date.isoformat(),
                settlement_date=r.settlement_date.isoformat() if r.settlement_date else None,
                kind=r.kind,
                symbol=r.symbol,
                quantity=dec(r.quantity),
                price_native=dec(r.price_native),
                fees_native=dec(r.fees_native),
                gross_native=dec(r.gross_native),
                net_native=dec(r.net_native),
                currency=r.native_currency or staged.account_currency,
                description=r.description,
                is_duplicate=pr.is_duplicate,
            )
        )
    report = staged.report
    return ImportPreview(
        import_id=staged.id,
        broker=staged.broker.value,
        account_id=staged.account_id,
        filename=staged.filename,
        counts=ImportCounts(
            rows=len(staged.rows),
            new=staged.new_count,
            duplicates=staged.duplicate_count,
            sweeps_dropped=report.sweeps_dropped,
            errors=len(report.errors),
            warnings=len(report.warnings),
        ),
        rows=rows,
        rows_truncated=len(staged.rows) > PREVIEW_ROW_LIMIT,
        errors=_issues(report.errors),
        warnings=_issues(report.warnings),
        unknown_actions=list(report.unknown_actions),
        expires_at=staged.expires_at,
    )


@router.get("/imports/brokers", response_model=list[ImportBroker])
def list_import_brokers() -> list[ImportBroker]:
    """Importer plugins the server can parse (the frontend builds its picker from this)."""
    return [
        ImportBroker(
            id=b.value, label=b.value.title(), file_types=list(import_staging.ALLOWED_EXTENSIONS)
        )
        for b in Broker
    ]


@router.post("/imports", response_model=ImportPreview, status_code=status.HTTP_201_CREATED)
def upload_import(
    session: SessionDep,
    file: Annotated[UploadFile, File()],
    broker: Annotated[str | None, Form()] = None,
    account_id: Annotated[int | None, Form()] = None,
) -> ImportPreview:
    content = file.file.read(import_staging.MAX_UPLOAD_BYTES + 1)
    if len(content) > import_staging.MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File is too large")
    try:
        staged = import_staging.stage(
            session,
            filename=file.filename or "",
            content=content,
            broker=broker,
            account_id=account_id,
        )
    except import_staging.ImportStagingError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _preview(staged)


@router.post("/imports/{import_id}/confirm", response_model=ImportConfirmResult)
def confirm_import(import_id: str, session: SessionDep) -> ImportConfirmResult:
    try:
        result = import_staging.confirm(session, import_id)
    except import_staging.StagedImportNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return ImportConfirmResult(
        import_id=import_id,
        inserted=result.inserted,
        duplicates=result.duplicates,
        sweeps_dropped=result.sweeps_dropped,
        unknown_actions=list(result.unknown_actions),
        fx_missing_dates=[d.isoformat() for d in result.fx_missing_dates],
        errors=_issues(result.errors),
        warnings=_issues(result.warnings),
        unresolved_symbols=list(result.unresolved_symbols),
    )


@router.delete("/imports/{import_id}", response_model=OkResponse)
def discard_import(import_id: str) -> OkResponse:
    if not import_staging.discard(import_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Import not found or expired")
    return OkResponse(detail="Discarded")
