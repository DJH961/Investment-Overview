"""Tests for ``GET /api/brief`` and ``POST /api/brief/ack`` (Daily Brief)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.api import brief as brief_api
from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import accounts_repo
from investment_dashboard.services import app_config_service, brief_service, read_cache

#: Wed 28 Oct 2026, 11:00 ET (EDT): a session is open.
NOW = datetime(2026, 10, 28, 15, 0, tzinfo=UTC)
#: Tue 27 Oct 2026, after the close.
BEFORE_OPEN = datetime(2026, 10, 27, 22, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _clock(api_db: object, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    read_cache.invalidate(*read_cache.ALL_DEPS, read_cache.BRIEF)
    monkeypatch.setattr(brief_api, "_utcnow", lambda: NOW)
    yield
    read_cache.invalidate(*read_cache.ALL_DEPS, read_cache.BRIEF)


def _set_marker(moment: datetime) -> None:
    with ledger_session_scope() as session:
        app_config_service.set_value(session, brief_service.CONFIG_KEY, moment.isoformat())
    read_cache.invalidate(read_cache.BRIEF)


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/brief").status_code == 401


def test_first_visit_sets_marker_and_is_not_due(api_client: TestClient) -> None:
    body = api_client.get("/api/brief").json()
    assert body["due"] is False
    assert body["kind"] is None
    with ledger_session_scope() as session:
        assert brief_service.get_last_ack(session) == NOW


def test_due_session_copies_the_overview_move(api_client: TestClient) -> None:
    _set_marker(BEFORE_OPEN)
    brief = api_client.get("/api/brief").json()
    assert brief["due"] is True
    assert brief["kind"] == "session"
    assert brief["sessions_passed"] == 1
    assert brief["sessions"] == ["2026-10-28"]
    assert [b["kind"] for b in brief["boundaries"]] == ["open"]
    overview = api_client.get("/api/overview/both").json()
    for ccy in ("EUR", "USD"):
        assert brief["move"][ccy]["day_move"] == overview[ccy]["kpis"]["daily_move"]
        assert brief["move"][ccy]["day_move_pct"] == overview[ccy]["kpis"]["daily_growth_pct"]
    assert brief["fx_move"] is None


def test_ack_dismisses_for_good_and_old_etag_gives_200(api_client: TestClient) -> None:
    _set_marker(BEFORE_OPEN)
    first = api_client.get("/api/brief")
    etag = first.headers["etag"]
    assert first.json()["due"] is True
    # Same ETag while nothing changed: 304.
    assert api_client.get("/api/brief", headers={"If-None-Match": etag}).status_code == 304
    acked = api_client.post("/api/brief/ack", json={"seen_at": NOW.isoformat()})
    assert acked.status_code == 200
    assert datetime.fromisoformat(acked.json()["last_ack_at"]) == NOW
    again = api_client.get("/api/brief", headers={"If-None-Match": etag})
    assert again.status_code == 200
    assert again.json()["due"] is False


def test_ack_never_moves_backwards_or_past_now(api_client: TestClient) -> None:
    _set_marker(NOW)
    early = api_client.post("/api/brief/ack", json={"seen_at": BEFORE_OPEN.isoformat()})
    assert datetime.fromisoformat(early.json()["last_ack_at"]) == NOW
    future = api_client.post("/api/brief/ack", json={"seen_at": "2030-01-01T00:00:00+00:00"})
    assert datetime.fromisoformat(future.json()["last_ack_at"]) == NOW


def test_ack_leaves_the_other_cached_reads_alone(api_client: TestClient) -> None:
    api_client.get("/api/overview/both")
    before_gens = read_cache.generations()
    before_size = read_cache.size()
    assert api_client.post("/api/brief/ack", json={}).status_code == 200
    assert read_cache.generations() == before_gens
    assert read_cache.size() == before_size


def test_new_ledger_rows_show_up_as_events(api_client: TestClient) -> None:
    _set_marker(BEFORE_OPEN)
    with ledger_session_scope() as session:
        acct = accounts_repo.create_account(
            session,
            broker="fidelity",
            account_label="Main",
            native_currency="USD",
            account_type="brokerage",
        )
        session.add(
            Transaction(
                account_id=acct.id,
                date=date(2026, 10, 28),
                kind="deposit",
                source=TransactionSource.MANUAL,
                net_native=Decimal("100"),
                created_at=datetime(2026, 10, 28, 14, 0),
            )
        )
        session.add(
            Transaction(
                account_id=acct.id,
                date=date(2026, 10, 1),
                kind="deposit",
                source=TransactionSource.MANUAL,
                net_native=Decimal("50"),
                created_at=datetime(2026, 10, 1, 14, 0),
            )
        )
    read_cache.invalidate()
    brief = api_client.get("/api/brief").json()
    assert brief["events_total"] == 1
    assert [e["kind"] for e in brief["events"]] == ["deposit"]
    assert brief["events"][0]["date"] == "2026-10-28"
    assert brief["events"][0]["symbol"] is None
