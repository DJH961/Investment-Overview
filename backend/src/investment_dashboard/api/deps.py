"""Shared FastAPI dependencies for the v6 routers.

* :func:`get_session` — one ledger-tier session per request (commit on success,
  rollback on error). Cache-tier data is still read/written only through its
  service (``prices_service``/``fx_service``/``snapshots_service``), which use
  ``db.cache_read_session``/``cache_write_session`` with this session as the
  fallback — never via repositories on this session.
* :func:`get_config_session` — config-tier session (settings, auth).
* :data:`ReportCcy` — the ``?ccy=EUR|USD`` reporting-currency query parameter.
* :func:`require_auth` — the guard on every non-public router; the logic lives in
  :mod:`investment_dashboard.api.security`.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated, Literal

from fastapi import Depends, Query, Request
from sqlalchemy.orm import Session

from investment_dashboard.db import config_session_scope, ledger_session_scope

#: Reporting currencies the API supports today. Extend here (and only here).
Ccy = Literal["EUR", "USD"]


def get_session() -> Iterator[Session]:
    with ledger_session_scope() as session:
        yield session


def get_config_session() -> Iterator[Session]:
    with config_session_scope() as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]
ConfigSessionDep = Annotated[Session, Depends(get_config_session)]
ReportCcy = Annotated[Ccy, Query(description="Reporting currency.")]


async def require_auth(request: Request) -> None:
    """Reject the request with 401 unless it carries a valid session or token."""
    from investment_dashboard.api import security  # noqa: PLC0415

    await security.authenticate(request)
