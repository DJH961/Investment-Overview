"""``/api/imports/wise``: Wise statement -> preview -> confirm (conversions, 7.3)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, File, HTTPException, UploadFile, status

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.common import OkResponse
from investment_dashboard.api.schemas.wise_imports import (
    WiseColumnField,
    WiseConfirmIn,
    WiseConfirmResult,
    WiseCounts,
    WiseLayoutIn,
    WisePreview,
    WisePreviewRow,
)
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.services import import_staging, settings_service, wise_import_service
from investment_dashboard.services.wise_import_service import RowChoice, StagedWise

router = APIRouter(tags=["imports"])

#: Preview rows returned per upload (counts always cover the whole file).
_ROW_LIMIT = 2000


def _preview(staged: StagedWise) -> WisePreview:
    rows: list[WisePreviewRow] = []
    for r in staged.statement.rows[:_ROW_LIMIT]:
        a = r.amounts
        rows.append(
            WisePreviewRow(
                line=r.line,
                external_id=r.external_id,
                date=r.on.isoformat() if r.on else None,
                status=r.status,
                reason=r.reason,
                description=r.description,
                eur_sent=dec(a.eur_sent) if a else None,
                fees_eur=dec(a.fees_eur) if a else None,
                usd_received=dec(a.usd_received) if a else None,
                rate=dec(a.usd_received / a.eur_sent) if a and a.eur_sent else None,
                fee_stated=r.fee_stated,
                sent_on=r.sent_on,
                is_duplicate=staged.is_duplicate(r),
                warnings=list(r.warnings),
            )
        )
    st = staged.statement
    return WisePreview(
        import_id=staged.id,
        filename=staged.filename,
        counts=WiseCounts(
            rows=len(st.rows),
            new=staged.new_count,
            duplicates=staged.duplicate_count,
            skipped=staged.skipped_count,
        ),
        rows=rows,
        headers=list(st.headers),
        fields=[
            WiseColumnField(id=fid, label=label, required=required, column=st.mapping.get(fid))
            for fid, (label, required) in wise_import_service.FIELD_LABELS.items()
        ],
        missing=list(st.missing),
        ignore_non_usd=bool(
            settings_service.get_or(wise_import_service.SETTING_IGNORE_OTHER, True)
        ),
        expires_at=staged.expires_at,
    )


@router.post("/imports/wise", response_model=WisePreview, status_code=status.HTTP_201_CREATED)
def upload_wise_statement(session: SessionDep, file: Annotated[UploadFile, File()]) -> WisePreview:
    max_bytes = import_staging.max_upload_bytes()
    content = file.file.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise HTTPException(413, "File is too large")
    try:
        staged = wise_import_service.stage(session, filename=file.filename or "", content=content)
    except wise_import_service.WiseImportError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _preview(staged)


@router.post("/imports/wise/{import_id}/layout", response_model=WisePreview)
def set_wise_layout(import_id: str, body: WiseLayoutIn, session: SessionDep) -> WisePreview:
    """Re-parse the staged statement with columns chosen by hand (new ``import_id``)."""
    try:
        staged = wise_import_service.relayout(session, import_id, body.columns)
    except wise_import_service.WiseImportNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except wise_import_service.WiseImportError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _preview(staged)


@router.post("/imports/wise/{import_id}/confirm", response_model=WiseConfirmResult)
def confirm_wise_statement(
    import_id: str, body: WiseConfirmIn, session: SessionDep
) -> WiseConfirmResult:
    choices = {r.line: RowChoice(skip=r.skip, kept_usd=r.kept_usd) for r in body.rows}
    try:
        result = wise_import_service.confirm(session, import_id, choices)
    except wise_import_service.WiseImportNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except wise_import_service.WiseImportError as exc:
        raise HTTPException(422, str(exc)) from exc
    return WiseConfirmResult(
        import_id=import_id,
        imported=result.imported,
        skipped=result.skipped,
        duplicates=result.duplicates,
    )


@router.delete("/imports/wise/{import_id}", response_model=OkResponse)
def discard_wise_statement(import_id: str) -> OkResponse:
    if not wise_import_service.discard(import_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Import not found or expired")
    return OkResponse()
