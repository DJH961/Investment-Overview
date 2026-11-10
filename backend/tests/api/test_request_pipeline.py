"""Request pipeline: commit before the response (B-001), ETag clock (B-002),
read-only POSTs (B-003), ``GET /api/live`` catch-up fields (B-012), background
refetches do not slide the session (B-015)."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from investment_dashboard import activity_log
from investment_dashboard.api import activity
from investment_dashboard.api import app as app_module
from investment_dashboard.api.app import create_app
from investment_dashboard.api.deps import SessionDep, require_auth
from investment_dashboard.services import live_bus, read_cache


async def _allow() -> None:
    return None


@pytest.fixture
def pipeline_client(api_db: object) -> Iterator[TestClient]:
    """App with one extra write route that publishes a live event; 5xx is returned, not raised."""
    app = create_app(lifespan=False)
    app.dependency_overrides[require_auth] = _allow

    def write(session: SessionDep) -> dict[str, bool]:
        live_bus.bus.publish({"type": "refresh", "ts": "2024-01-01T00:00:00+00:00"})
        return {"ok": True}

    app.add_api_route("/api/_pipeline/write", write, methods=["POST"])
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def test_failed_commit_is_a_5xx_and_fires_nothing(
    pipeline_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(self: Session) -> None:
        raise OperationalError("COMMIT", {}, Exception("database is locked"))

    monkeypatch.setattr(Session, "commit", boom)
    before = read_cache.generations()

    response = pipeline_client.post("/api/_pipeline/write")

    assert response.status_code >= 500
    assert read_cache.generations() == before  # no generation bumped, no event published


def test_successful_write_fires_its_event_only_after_the_commit(
    pipeline_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    order: list[str] = []
    real_commit = Session.commit
    real_event = read_cache.invalidate_for_event

    def commit(self: Session) -> None:
        order.append("commit")  # the after_commit listeners run inside real_commit
        real_commit(self)

    def event(*args: Any, **kwargs: Any) -> None:
        order.append("event")
        real_event(*args, **kwargs)

    monkeypatch.setattr(Session, "commit", commit)
    monkeypatch.setattr(read_cache, "invalidate_for_event", event)
    before = read_cache.generations()

    response = pipeline_client.post("/api/_pipeline/write")

    assert response.status_code == 200
    assert order.index("event") > order.index("commit")
    assert read_cache.generations() != before


def test_refused_write_publishes_nothing(pipeline_client: TestClient) -> None:
    before = read_cache.generations()
    # 405 from the router: never reaches the route, nothing may fire.
    assert pipeline_client.put("/api/_pipeline/write").status_code == 405
    assert read_cache.generations() == before


# --- B-002 ---------------------------------------------------------------------------


def _at(hour: int, day: int = 8, minute: int = 0) -> float:
    # 2024-01-08 is a Monday; 15:00 UTC is 10:00 New York (open), 23:00 UTC is closed.
    return datetime(2024, 1, day, hour, minute, tzinfo=UTC).timestamp()


def test_time_component_changes_with_exchange_date_market_state_and_ttl_bucket() -> None:
    base = read_cache.time_component(_at(15))
    assert read_cache.time_component(_at(15)) == base
    assert read_cache.time_component(_at(23)) != base  # market state (open -> closed)
    assert read_cache.time_component(_at(15, day=9)) != base  # exchange date
    later = _at(15) + read_cache.TTL_SECONDS + 1
    assert read_cache.time_component(later) != base  # TTL bucket


def test_both_etag_stops_matching_when_the_clock_component_moves(
    pipeline_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = pipeline_client.get("/api/overview/both")
    assert first.status_code == 200
    etag = first.headers["etag"]
    assert (
        pipeline_client.get("/api/overview/both", headers={"If-None-Match": etag}).status_code
        == 304
    )

    monkeypatch.setattr(read_cache, "time_component", lambda now=None: "next-day/closed/9")
    stale = pipeline_client.get("/api/overview/both", headers={"If-None-Match": etag})
    assert stale.status_code == 200
    assert stale.headers["etag"] != etag


# --- B-003 ---------------------------------------------------------------------------


def test_one_shared_set_of_read_only_posts() -> None:
    assert activity._READ_ONLY_WRITES is activity_log.READ_ONLY_POSTS
    assert activity_log.READ_ONLY_POSTS <= app_module._CACHE_NEUTRAL_WRITES
    for path in (
        "/api/calculator",
        "/api/allocations/plan",
        "/api/transactions/reconcile",
        "/api/maintenance/probe",
    ):
        assert path in activity_log.READ_ONLY_POSTS
        assert activity.subject_for("POST", path) is None  # no activity line for any of them


def test_calculator_post_keeps_the_read_cache(api_client: TestClient) -> None:
    assert api_client.get("/api/overview?ccy=EUR").status_code == 200
    cached = read_cache.size()
    assert cached >= 1
    gens = read_cache.generations()

    assert api_client.post("/api/calculator", json={}).status_code == 200

    assert read_cache.size() == cached
    assert read_cache.generations() == gens


def test_a_real_write_is_still_logged_and_flushes(api_client: TestClient) -> None:
    assert api_client.get("/api/overview?ccy=EUR").status_code == 200
    assert api_client.post("/api/diagnostics/problems/dismiss-all").status_code == 200
    assert read_cache.size() == 0
    assert activity.subject_for("POST", "/api/diagnostics/problems/dismiss-all") == "changes"


# --- B-012 ---------------------------------------------------------------------------


def test_live_reports_boot_id_and_generations(api_client: TestClient) -> None:
    body = api_client.get("/api/live").json()
    assert body["boot_id"] == read_cache.boot_id() != ""
    assert set(body["generations"]) == {"ledger", "prices", "fx"}
    read_cache.invalidate(read_cache.FX)
    after = api_client.get("/api/live").json()
    assert after["generations"]["fx"] == body["generations"]["fx"] + 1
    assert after["generations"]["ledger"] == body["generations"]["ledger"]


# --- B-015 ---------------------------------------------------------------------------


def test_background_validation_does_not_slide_the_session(
    api_db: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    from investment_dashboard.config import get_settings
    from investment_dashboard.db import config_session_scope
    from investment_dashboard.repositories import auth_repo
    from investment_dashboard.services import auth_service

    settings = get_settings()
    with config_session_scope() as db:
        token = auth_service.create_session(db, settings, "pytest")
    sid = auth_service._hash_token(token)
    old = auth_service.now() - timedelta(minutes=10)

    def last_seen() -> datetime:
        with config_session_scope() as db:
            row = auth_repo.get_session(db, sid)
            assert row is not None
            return row.last_seen_at

    with config_session_scope() as db:
        row = auth_repo.get_session(db, sid)
        assert row is not None
        row.last_seen_at = old
    stamp: Callable[[], datetime] = last_seen

    with config_session_scope() as db:
        assert auth_service.validate_session(db, settings, token, slide=False) == sid
    assert stamp() == old
    with config_session_scope() as db:
        assert auth_service.validate_session(db, settings, token) == sid
    assert stamp() > old
