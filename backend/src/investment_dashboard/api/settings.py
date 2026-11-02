"""``/api/settings``: user preferences.

* ``GET/PUT /settings`` — the original typed view (kept until the frontend moves).
* ``/settings/schema|values|reset|history|export|import`` — the registry-driven
  settings (``services/settings_registry``). Writes are all-or-nothing; a 422
  carries ``{"detail", "errors": {key: message}}``. Secrets are write-only and
  changing one needs a browser session (fresh once the security branch lands).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from investment_dashboard.api.deps import ConfigSessionDep, SessionDep
from investment_dashboard.api.guards import ActorDep, RequestIdDep, require_fresh
from investment_dashboard.api.schemas.settings import (
    SettingsAuditRow,
    SettingsChangedDto,
    SettingsDto,
    SettingsErrorDto,
    SettingsExportDto,
    SettingsHistoryDto,
    SettingsImportResult,
    SettingsPatch,
    SettingsReset,
    SettingsSchemaDto,
    SettingsUpdate,
    SettingsValuesDto,
)
from investment_dashboard.db import config_session_scope
from investment_dashboard.readmodels import settings as settings_rm
from investment_dashboard.services import settings_registry, settings_service
from investment_dashboard.services.settings_service import SettingsValidationError

router = APIRouter(tags=["settings"])

_ERRORS: dict[int | str, dict[str, Any]] = {422: {"model": SettingsErrorDto}}


@router.get("/settings", response_model=SettingsDto)
def get_settings_dto(session: SessionDep) -> SettingsDto:
    return SettingsDto(**settings_rm.build(session))


@router.put("/settings", response_model=SettingsDto)
def update_settings(body: SettingsUpdate, session: SessionDep) -> SettingsDto:
    try:
        settings_rm.apply(session, **body.model_dump(exclude_none=True))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return SettingsDto(**settings_rm.build(session))


# -- v2 ------------------------------------------------------------------------------


def _invalid(exc: SettingsValidationError) -> JSONResponse:
    return JSONResponse({"detail": "Invalid settings", "errors": exc.errors}, status_code=422)


@router.get("/settings/schema", response_model=SettingsSchemaDto)
def get_schema() -> dict[str, Any]:
    return settings_service.schema_view()


@router.get("/settings/values", response_model=SettingsValuesDto)
def get_values(session: ConfigSessionDep) -> dict[str, Any]:
    return {"values": settings_service.values(session)}


def _patch(changes: dict[str, Any], actor: str, rid: str | None) -> dict[str, Any]:
    changed = settings_service.set_many(changes, actor=actor, request_id=rid)
    with config_session_scope() as cfg:
        return {"changed": changed, "values": settings_service.values(cfg)}


@router.patch("/settings/values", response_model=SettingsChangedDto, responses=_ERRORS)
async def patch_values(
    body: SettingsPatch, request: Request, actor: ActorDep, rid: RequestIdDep
) -> Any:
    secrets = [k for k in body.changes if getattr(settings_registry.BY_KEY.get(k), "secret", False)]
    if secrets:
        actor = await require_fresh(request)
    try:
        return await run_in_threadpool(_patch, body.changes, actor, rid)
    except SettingsValidationError as exc:
        return _invalid(exc)


def _reset(body: SettingsReset, actor: str, rid: str | None) -> dict[str, Any]:
    changed = settings_service.reset(
        keys=body.keys, section=body.section, everything=body.all, actor=actor, request_id=rid
    )
    with config_session_scope() as cfg:
        return {"changed": changed, "values": settings_service.values(cfg)}


@router.post("/settings/reset", response_model=SettingsChangedDto, responses=_ERRORS)
async def reset_values(
    body: SettingsReset, request: Request, actor: ActorDep, rid: RequestIdDep
) -> Any:
    keys = (
        list(settings_registry.BY_KEY)
        if body.all
        else [
            *(body.keys or []),
            *(d.key for d in settings_registry.DEFS if d.section == body.section),
        ]
    )
    if any(getattr(settings_registry.BY_KEY.get(k), "secret", False) for k in keys):
        actor = await require_fresh(request)
    try:
        return await run_in_threadpool(_reset, body, actor, rid)
    except SettingsValidationError as exc:
        return _invalid(exc)


@router.get("/settings/history", response_model=SettingsHistoryDto)
def get_history(
    session: ConfigSessionDep,
    key: str | None = None,
    limit: int = Query(100, ge=1, le=1000),
) -> dict[str, Any]:
    rows = settings_service.history(key=key, limit=limit, session=session)
    return {"rows": [SettingsAuditRow.model_validate(r, from_attributes=True) for r in rows]}


@router.post(
    "/settings/history/{audit_id}/revert", response_model=SettingsChangedDto, responses=_ERRORS
)
def revert_change(audit_id: int, actor: ActorDep, rid: RequestIdDep) -> Any:
    try:
        changed = settings_service.revert(audit_id, actor=actor, request_id=rid)
    except SettingsValidationError as exc:
        return _invalid(exc)
    with config_session_scope() as cfg:
        return {"changed": changed, "values": settings_service.values(cfg)}


@router.get("/settings/export", response_model=SettingsExportDto)
def export_settings() -> JSONResponse:
    payload = settings_service.export_json()
    return JSONResponse(
        payload, headers={"Content-Disposition": 'attachment; filename="settings.json"'}
    )


@router.post("/settings/import", response_model=SettingsImportResult, responses=_ERRORS)
def import_settings(
    body: dict[str, Any],
    actor: ActorDep,
    rid: RequestIdDep,
    dry_run: bool = Query(True, description="Only show the diff."),
) -> Any:
    try:
        diff = settings_service.import_json(body, dry_run=dry_run, actor=actor, request_id=rid)
    except SettingsValidationError as exc:
        return _invalid(exc)
    return {"dry_run": dry_run, "diff": diff}
