"""``DomainError`` subclasses map to one HTTP status via the app-level handler."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.api.app import create_app
from investment_dashboard.errors import (
    ConflictError,
    DomainError,
    NotFoundError,
    UpstreamError,
    ValidationError,
)


@pytest.mark.parametrize(
    ("exc", "status"),
    [
        (ValidationError("bad"), 422),
        (NotFoundError("gone"), 404),
        (ConflictError("clash"), 409),
        (UpstreamError("down"), 502),
    ],
)
def test_domain_errors_map_to_status(exc: DomainError, status: int) -> None:
    app = create_app(lifespan=False)

    @app.get("/boom")
    def boom() -> None:
        raise exc

    response = TestClient(app).get("/boom")
    assert response.status_code == status
    assert response.json() == {"detail": str(exc)}


def test_domain_errors_keep_builtin_bases() -> None:
    assert issubclass(ValidationError, ValueError)
    assert issubclass(ConflictError, ValueError)
    assert issubclass(NotFoundError, LookupError)
    assert issubclass(UpstreamError, RuntimeError)
