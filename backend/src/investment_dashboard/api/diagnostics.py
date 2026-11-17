"""``/api/diagnostics`` -- data-health checks and process-local provider status."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import PlainTextResponse

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.diagnostics import (
    DiagnosticsOut,
    DiagnosticsStatusOut,
    DismissOut,
    ShareCountsIn,
    ShareCountsOut,
)
from investment_dashboard.readmodels import diagnostics as diagnostics_rm
from investment_dashboard.services import (
    broker_share_counts_service,
    diagnostics_service,
    runtime_status,
    support_bundle,
)

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


@router.get("/status", response_model=DiagnosticsStatusOut)
def get_status(session: SessionDep) -> dict[str, Any]:
    """Headline severity + count for the top-bar data-health badge."""
    severity, count = diagnostics_service.quick_status(session)
    return {"severity": severity, "count": count, "problems": len(runtime_status.recent())}


@router.post("/problems/dismiss-all", response_model=DismissOut)
def dismiss_all_problems() -> dict[str, Any]:
    """Clear every recent background problem (a new failure shows up again)."""
    return {"dismissed": runtime_status.dismiss_all()}


@router.post("/problems/{problem_id}/dismiss", response_model=DismissOut)
def dismiss_problem(problem_id: int) -> dict[str, Any]:
    if not runtime_status.dismiss(problem_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "problem not found (already dismissed?)")
    return {"dismissed": 1}


def _share_counts_out(entries: list[broker_share_counts_service.Entry]) -> dict[str, Any]:
    return {
        "counts": [
            {"account_id": a, "instrument_id": i, "shares": format(s.normalize(), "f")}
            for a, i, s in entries
        ]
    }


@router.get("/share-counts", response_model=ShareCountsOut)
def get_share_counts(session: SessionDep) -> dict[str, Any]:
    """Share counts typed from the broker's screen (empty: the check is not set up)."""
    return _share_counts_out(broker_share_counts_service.load(session))


@router.put("/share-counts", response_model=ShareCountsOut)
def put_share_counts(body: ShareCountsIn, session: SessionDep) -> dict[str, Any]:
    """Replace the typed share counts; Data Health compares them with the ledger."""
    entries = [(c.account_id, c.instrument_id, Decimal(c.shares)) for c in body.counts]
    return _share_counts_out(broker_share_counts_service.replace(session, entries))
