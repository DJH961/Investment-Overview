"""``/api/settings``: read and partially update the user's preferences."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.settings import SettingsDto, SettingsUpdate
from investment_dashboard.readmodels import settings as settings_rm

router = APIRouter(tags=["settings"])


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
