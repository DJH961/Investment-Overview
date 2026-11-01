"""The v6 server: FastAPI app factory.

Every resource has its own router module in this package exposing a module
level ``router: APIRouter``. :data:`ROUTER_MODULES` lists them; each is
mounted under ``/api``. Routers other than ``health`` and ``auth`` are guarded
by :func:`investment_dashboard.api.deps.require_auth`.

When ``settings.frontend_dist`` is set, the built React app is served at ``/``
with an SPA fallback (any non-``/api`` path returns ``index.html``).
"""

from __future__ import annotations

import importlib
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from investment_dashboard import __version__
from investment_dashboard.api.deps import require_auth
from investment_dashboard.config import get_settings
from investment_dashboard.errors import DomainError

API_PREFIX = "/api"

#: Router modules mounted without the auth guard (they guard per-route).
PUBLIC_ROUTER_MODULES: tuple[str, ...] = ("health", "auth")

#: Router modules mounted behind :func:`require_auth`.
GUARDED_ROUTER_MODULES: tuple[str, ...] = (
    # B1 reads A
    "overview",
    "holdings",
    "allocations",
    "graphs",
    # B2 reads B
    "periods",
    "analytics",
    "deposits",
    "diagnostics",
    "onboarding",
    "calculator",
    # B3 writes
    "transactions",
    "imports",
    "settings",
    "accounts",
    "ops",
    # B5 currency
    "fx_conversions",
    # B6 live
    "stream",
)

_SECURITY_HEADERS = {
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
        "base-uri 'self'; form-action 'self'"
    ),
}


def _load_router(name: str) -> APIRouter:
    module = importlib.import_module(f"investment_dashboard.api.{name}")
    router = getattr(module, "router")  # noqa: B009 - explicit contract attribute
    if not isinstance(router, APIRouter):  # pragma: no cover - contract guard
        raise TypeError(f"api.{name}.router must be an APIRouter")
    return router


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    from investment_dashboard.services import server_runtime  # noqa: PLC0415

    await server_runtime.startup(app)
    try:
        yield
    finally:
        await server_runtime.shutdown(app)


def _mount_frontend(app: FastAPI, dist: Path) -> None:
    index = dist / "index.html"
    assets = dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> Response:
        if full_path.startswith("api/") or full_path == "api":
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        candidate = (dist / full_path).resolve()
        if full_path and candidate.is_file() and dist.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(index)


def create_app(*, lifespan: bool = True) -> FastAPI:
    """Build the v6 app. ``lifespan=False`` skips boot/scheduler (tests, OpenAPI export)."""
    settings = get_settings()
    app = FastAPI(
        title="Investment Overview",
        version=__version__,
        summary="v6 API: the server owns data, prices and all maths.",
        lifespan=_lifespan if lifespan else None,
    )

    @app.middleware("http")
    async def security_headers(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)
        for key, value in _SECURITY_HEADERS.items():
            response.headers.setdefault(key, value)
        if request.url.path.startswith(API_PREFIX):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.exception_handler(DomainError)
    async def domain_error_handler(request: Request, exc: DomainError) -> JSONResponse:
        # One mapping for every service error that no route handled itself.
        return JSONResponse({"detail": str(exc)}, status_code=exc.http_status)

    if settings.dev_cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.dev_cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    for name in PUBLIC_ROUTER_MODULES:
        app.include_router(_load_router(name), prefix=API_PREFIX)
    for name in GUARDED_ROUTER_MODULES:
        app.include_router(
            _load_router(name), prefix=API_PREFIX, dependencies=[Depends(require_auth)]
        )

    if settings.frontend_dist is not None and (settings.frontend_dist / "index.html").is_file():
        _mount_frontend(app, settings.frontend_dist)
    return app


def run() -> None:  # pragma: no cover - thin uvicorn launcher
    """Entry point for the ``inv-dashboard-server`` script."""
    import uvicorn  # noqa: PLC0415

    from investment_dashboard.logging import configure_logging  # noqa: PLC0415

    configure_logging()
    settings = get_settings()
    uvicorn.run(
        create_app(),
        host=settings.host,
        port=settings.port,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
