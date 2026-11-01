"""``/api/diagnostics`` -- data-health checks and process-local provider status."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.diagnostics import DiagnosticsOut
from investment_dashboard.readmodels import diagnostics as diagnostics_rm
from investment_dashboard.services import support_bundle

router = APIRouter(prefix="/diagnostics", tags=["diagnostics"])


@router.get("", response_model=DiagnosticsOut)
def get_diagnostics(session: SessionDep) -> dict[str, Any]:
    return diagnostics_rm.build(session)


@router.get("/support-bundle", response_class=PlainTextResponse)
def get_support_bundle() -> PlainTextResponse:
    """Plain-text support bundle (secrets redacted, no raw log) as a download."""
    filename = support_bundle.bundle_filename()
    return PlainTextResponse(
        support_bundle.build_server_bundle(),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
