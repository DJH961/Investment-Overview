"""``/api/imports``: upload -> preview (nothing written) -> confirm / discard."""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import JSONResponse

from investment_dashboard.adapters.importer_types import RowIssue, action_key
from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.guards import ActorDep, FreshActorDep, RequestIdDep
from investment_dashboard.api.schemas.common import OkResponse
from investment_dashboard.api.schemas.imports import (
    ActionOverrideIn,
    ActionOverridesOut,
    ImportBatchList,
    ImportBatchOut,
    ImportBroker,
    ImportConfirmResult,
    ImportCounts,
    ImportErrorDto,
    ImportIssue,
    ImportPreview,
    ImportPreviewRow,
    ImportUndoPreview,
    ImportUndoRequest,
    ImportUndoResult,
    ImportUndoRow,
    UnknownAction,
    UnknownActionsOut,
)
from investment_dashboard.errors import ValidationError
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.services import (
    import_staging,
    import_undo_service,
    importer_service,
    settings_registry,
    settings_service,
)
from investment_dashboard.services.import_undo_service import BatchView
from investment_dashboard.services.importer_service import Broker

router = APIRouter(tags=["imports"])

#: Preview rows returned per upload (counts always cover the whole file); the
#: ``import.preview_row_limit`` setting overrides it.
PREVIEW_ROW_LIMIT = 500


def _preview_limit() -> int:
    return int(settings_service.get_or("import.preview_row_limit", PREVIEW_ROW_LIMIT))


def _issues(items: Sequence[RowIssue]) -> list[ImportIssue]:
    return [ImportIssue(message=i.message, line=i.line, raw=i.raw) for i in items]


def _preview(staged: import_staging.StagedImport) -> ImportPreview:
    rows = []
    limit = _preview_limit()
    for pr in staged.rows[:limit]:
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
        rows_truncated=len(staged.rows) > limit,
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
    max_bytes = import_staging.max_upload_bytes()
    content = file.file.read(max_bytes + 1)
    if len(content) > max_bytes:
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
def confirm_import(import_id: str, session: SessionDep, actor: ActorDep) -> ImportConfirmResult:
    try:
        result = import_staging.confirm(session, import_id, actor=actor)
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
        import_batch_id=result.import_batch_id,
    )


@router.delete("/imports/{import_id}", response_model=OkResponse)
def discard_import(import_id: str) -> OkResponse:
    if not import_staging.discard(import_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Import not found or expired")
    return OkResponse(detail="Discarded")


@router.post("/imports/{import_id}/reparse", response_model=ImportPreview)
def reparse_import(import_id: str, session: SessionDep) -> ImportPreview:
    """Parse a staged upload again with the current action mapping (new ``import_id``)."""
    try:
        staged = import_staging.restage(session, import_id)
    except import_staging.StagedImportNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except import_staging.ImportStagingError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _preview(staged)


# -- action mapping ----------------------------------------------------------------


def _broker(raw: str) -> Broker:
    try:
        return Broker(raw.strip().lower())
    except ValueError as exc:
        raise HTTPException(404, f"unknown broker {raw!r}") from exc


@router.get("/imports/unknown-actions", response_model=UnknownActionsOut)
def unknown_actions(import_id: Annotated[str | None, Query()] = None) -> UnknownActionsOut:
    """Unknown actions in the given (or the latest) staged preview, to map in the UI."""
    if import_id:
        try:
            staged: import_staging.StagedImport | None = import_staging.get(import_id)
        except import_staging.StagedImportNotFoundError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    else:
        staged = import_staging.latest()
    targets = list(settings_registry.ACTION_OVERRIDE_TARGETS)
    if staged is None:
        return UnknownActionsOut(
            import_id=None, broker=None, filename=None, actions=[], targets=targets, overrides={}
        )
    counts = Counter(a.strip() for a in staged.report.unknown_actions if a and a.strip())
    return UnknownActionsOut(
        import_id=staged.id,
        broker=staged.broker.value,
        filename=staged.filename,
        actions=[UnknownAction(action=a, count=n) for a, n in counts.most_common()],
        targets=targets,
        overrides=importer_service.action_overrides(staged.broker),
    )


@router.get("/imports/action-overrides/{broker}", response_model=ActionOverridesOut)
def get_action_overrides(broker: str) -> ActionOverridesOut:
    b = _broker(broker)
    return ActionOverridesOut(broker=b.value, overrides=importer_service.action_overrides(b))


@router.put(
    "/imports/action-overrides/{broker}",
    response_model=ActionOverridesOut,
    responses={422: {"model": ImportErrorDto}},
)
def put_action_override(
    broker: str, body: ActionOverrideIn, actor: ActorDep, rid: RequestIdDep
) -> Any:
    """Map one broker action to a kind (or ``ignore``); ``kind: null`` removes it.

    Stored in the setting ``import.action_overrides.<broker>`` (settings history
    keeps every change). Re-run the preview with ``POST /imports/{id}/reparse``.
    """
    b = _broker(broker)
    key = f"import.action_overrides.{b.value}"
    current = importer_service.action_overrides(b)
    action = " ".join(body.action.split())
    merged = {k: v for k, v in current.items() if action_key(k) != action_key(action)}
    if body.kind is not None:
        merged[action] = body.kind
    try:
        settings_service.set_many({key: merged}, actor=actor, request_id=rid)
    except settings_service.SettingsValidationError as exc:
        return JSONResponse(
            {"detail": "invalid action mapping", "errors": exc.errors}, status_code=422
        )
    return ActionOverridesOut(broker=b.value, overrides=importer_service.action_overrides(b))


# -- import history / undo ---------------------------------------------------------


def _batch_out(v: BatchView) -> ImportBatchOut:
    return ImportBatchOut(
        id=v.id,
        created_at=v.created_at,
        account_id=v.account_id,
        account_label=v.account_label,
        broker=v.broker,
        filename=v.filename,
        row_count=v.row_count,
        current_rows=v.current_rows,
        duplicate_count=v.duplicate_count,
        status=v.status,  # type: ignore[arg-type]
        actor=v.actor,
        undone_at=v.undone_at,
        undone_by=v.undone_by,
        undone_rows=v.undone_rows,
        can_undo=v.can_undo,
    )


@router.get("/imports/batches", response_model=ImportBatchList)
def list_batches(
    session: SessionDep, limit: Annotated[int, Query(ge=1, le=500)] = 100
) -> ImportBatchList:
    return ImportBatchList(
        batches=[_batch_out(v) for v in import_undo_service.list_batches(session, limit=limit)],
        note="Imports made before import history existed are not listed and cannot be undone.",
    )


@router.get("/imports/batches/{batch_id}/undo-preview", response_model=ImportUndoPreview)
def undo_preview(batch_id: int, session: SessionDep) -> ImportUndoPreview:
    p = import_undo_service.preview(session, batch_id)
    return ImportUndoPreview(
        batch=_batch_out(p.batch),
        rows=[
            ImportUndoRow(
                id=r.id,
                date=r.date.isoformat(),
                kind=r.kind,
                symbol=r.symbol,
                quantity=dec(r.quantity),
                net_native=dec(r.net_native),
                description=r.description,
            )
            for r in p.rows
        ],
        rows_truncated=p.total > len(p.rows),
        total=p.total,
        detached=p.detached,
        earliest_date=p.earliest_date.isoformat() if p.earliest_date else None,
        latest_date=p.latest_date.isoformat() if p.latest_date else None,
        confirm_word=p.confirm_word,
    )


@router.post(
    "/imports/batches/{batch_id}/undo",
    response_model=ImportUndoResult,
    responses={422: {"model": ImportErrorDto}},
)
def undo_batch(
    batch_id: int, body: ImportUndoRequest, session: SessionDep, actor: FreshActorDep
) -> Any:
    """Delete the batch's transactions (browser session + typed ``UNDO``; backup first)."""
    try:
        result = import_undo_service.undo(session, batch_id, confirm=body.confirm, actor=actor)
    except ValidationError as exc:
        return JSONResponse({"detail": str(exc), "errors": {"confirm": str(exc)}}, status_code=422)
    return ImportUndoResult(
        batch=_batch_out(result.batch),
        deleted=result.deleted,
        backup=result.backup,
        invalidated_from=result.invalidated_from.isoformat() if result.invalidated_from else None,
    )
