"""The API read cache in the real app: writes invalidate, auth is never skipped."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from investment_dashboard.api.app import create_app
from investment_dashboard.api.deps import require_auth
from investment_dashboard.services import read_cache


async def _allow() -> None:
    return None


def test_overview_is_cached_and_a_write_invalidates(api_client: TestClient) -> None:
    assert api_client.get("/api/overview?ccy=EUR").status_code == 200
    assert read_cache.size() >= 1
    # The remembered chart range is part of the cached overview (B-016): it drops the cache.
    api_client.put("/api/graphs/range", json={"range": "1m"})
    assert read_cache.size() == 0
    assert api_client.get("/api/overview?ccy=EUR").status_code == 200
    assert read_cache.size() >= 1
    # A real data write drops it.
    assert api_client.post("/api/diagnostics/problems/dismiss-all").status_code < 400
    assert read_cache.size() == 0


def test_cache_never_answers_without_auth(api_db: Path) -> None:
    authed_app = create_app(lifespan=False)
    authed_app.dependency_overrides[require_auth] = _allow
    with TestClient(authed_app) as authed, TestClient(create_app(lifespan=False)) as anon:
        assert authed.get("/api/overview?ccy=EUR").status_code == 200
        assert read_cache.size() >= 1  # a cached answer exists...
        assert anon.get("/api/overview?ccy=EUR").status_code == 401  # ...and is not handed out
