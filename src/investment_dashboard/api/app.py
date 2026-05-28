"""Headless JSON API exposing the shared read-models.

Read-only by design (the mobile companion only *views* data). Every
endpoint reuses the exact same :mod:`investment_dashboard.readmodels`
builders the snapshot/export path uses, so the API and the cloud-synced
file can never drift from each other — or from the NiceGUI web app, which
shares the underlying ``domain``/``services`` compute.

Two ways to run it:

* mounted on the existing NiceGUI server via :func:`mount_api` (enabled
  with ``INV_DASHBOARD_API_ENABLED=true``); or
* standalone via :func:`create_app` and the ``inv-dashboard-api`` script.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, FastAPI

from investment_dashboard import __version__, readmodels
from investment_dashboard.api.auth import require_token
from investment_dashboard.db import session_scope
from investment_dashboard.readmodels import SCHEMA_VERSION

API_PREFIX = "/api"


def _section(builder: Callable[..., dict[str, Any]]) -> Callable[[], dict[str, Any]]:
    """Wrap a read-model builder in a session-scoped endpoint handler."""

    def handler() -> dict[str, Any]:
        with session_scope() as session:
            return builder(session)

    return handler


def create_router() -> APIRouter:
    """Build the ``/api`` router. All routes are GET and read-only."""
    router = APIRouter(prefix=API_PREFIX, tags=["read-models"])

    # Unauthenticated liveness/version probe — safe to expose so a client
    # can discover the schema version before sending a token.
    @router.get("/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "app_version": __version__,
            "schema_version": SCHEMA_VERSION,
        }

    guarded = APIRouter(dependencies=[Depends(require_token)])
    guarded.add_api_route("/snapshot", _section(readmodels.build_snapshot), methods=["GET"])
    guarded.add_api_route("/overview", _section(readmodels.overview.build), methods=["GET"])
    guarded.add_api_route("/deposits", _section(readmodels.deposits.build), methods=["GET"])
    guarded.add_api_route("/transactions", _section(readmodels.transactions.build), methods=["GET"])
    guarded.add_api_route("/monthly", _section(readmodels.periods.build_monthly), methods=["GET"])
    guarded.add_api_route("/yearly", _section(readmodels.periods.build_yearly), methods=["GET"])
    guarded.add_api_route("/analytics", _section(readmodels.analytics.build), methods=["GET"])
    guarded.add_api_route("/calculator", _section(readmodels.calculator.build), methods=["GET"])
    router.include_router(guarded)
    return router


def mount_api(app: FastAPI) -> None:
    """Attach the ``/api`` router to an existing FastAPI app (e.g. NiceGUI's)."""
    app.include_router(create_router())


def create_app() -> FastAPI:
    """Create a standalone FastAPI app serving only the JSON API."""
    app = FastAPI(
        title="Investment Dashboard API",
        version=__version__,
        summary="Read-only JSON read-models for the mobile companion app.",
    )
    mount_api(app)
    return app


def run() -> None:  # pragma: no cover - thin uvicorn launcher
    """Entry point for the ``inv-dashboard-api`` script."""
    import uvicorn  # noqa: PLC0415

    from investment_dashboard.boot import run_boot_sequence  # noqa: PLC0415
    from investment_dashboard.config import get_settings  # noqa: PLC0415
    from investment_dashboard.logging import configure_logging  # noqa: PLC0415

    configure_logging()
    run_boot_sequence()
    settings = get_settings()
    uvicorn.run(create_app(), host=settings.host, port=settings.port)
