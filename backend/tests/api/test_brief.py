"""Tests for ``GET /api/brief`` and ``POST /api/brief/ack`` (Daily Brief)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.api import brief as brief_api
from investment_dashboard.api import deps as api_deps
from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import accounts_repo, fx_repo, intraday_repo
from investment_dashboard.services import app_config_service, brief_service, fx_service, read_cache

#: Wed 28 Oct 2026, 11:00 ET (EDT): a session is open.
NOW = datetime(2026, 10, 28, 15, 0, tzinfo=UTC)
#: Tue 27 Oct 2026, after the close.
BEFORE_OPEN = datetime(2026, 10, 27, 22, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _clock(
    api_db: object, api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> Iterator[None]:
    api_client.headers["X-Visible"] = "1"  # the tab is visible unless a test says otherwise
    read_cache.invalidate(*read_cache.ALL_DEPS, read_cache.BRIEF)
    monkeypatch.setattr(brief_api, "_utcnow", lambda: NOW)
    monkeypatch.setattr(api_deps, "visit_clock", lambda: NOW)
    yield
    read_cache.invalidate(*read_cache.ALL_DEPS, read_cache.BRIEF)


def _set_marker(left_at: datetime) -> None:
    """A visit that started at NOW after an absence that began at ``left_at``."""
    with ledger_session_scope() as session:
        app_config_service.set_value(session, brief_service.FROM_KEY, left_at.isoformat())
        app_config_service.set_value(session, brief_service.START_KEY, NOW.isoformat())
        app_config_service.set_value(session, brief_service.SEEN_KEY, NOW.isoformat())
    read_cache.invalidate(read_cache.BRIEF)


def _set_ack(moment: datetime) -> None:
    with ledger_session_scope() as session:
        app_config_service.set_value(session, brief_service.CONFIG_KEY, moment.isoformat())
    read_cache.invalidate(read_cache.BRIEF)


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/brief").status_code == 401


def test_first_visit_starts_the_heartbeat_and_is_not_due(api_client: TestClient) -> None:
    body = api_client.get("/api/brief").json()
    assert body["due"] is False
    assert body["kind"] is None
    with ledger_session_scope() as session:
        assert brief_service.get_last_seen(session) == NOW
        assert brief_service.get_visit(session) is None


def test_overview_read_is_a_heartbeat(api_client: TestClient) -> None:
    assert api_client.get("/api/overview/both").status_code == 200
    with ledger_session_scope() as session:
        assert brief_service.get_last_seen(session) == NOW


def _seed_seen(moment: datetime) -> None:
    with ledger_session_scope() as session:
        app_config_service.set_value(session, brief_service.SEEN_KEY, moment.isoformat())
    read_cache.invalidate(read_cache.BRIEF)


def _at(monkeypatch: pytest.MonkeyPatch, moment: datetime) -> None:
    monkeypatch.setattr(brief_api, "_utcnow", lambda: moment)
    monkeypatch.setattr(api_deps, "visit_clock", lambda: moment)


def _visit() -> tuple[datetime, datetime] | None:
    with ledger_session_scope() as session:
        return brief_service.get_visit(session)


def test_invisible_reads_never_move_last_seen(api_client: TestClient) -> None:
    hidden = {"X-Visible": "0"}
    assert api_client.get("/api/overview/both", headers=hidden).status_code == 200
    assert api_client.get("/api/brief", headers=hidden).status_code == 200
    with ledger_session_scope() as session:
        assert brief_service.get_last_seen(session) is None
    _seed_seen(NOW - timedelta(hours=2))
    api_client.get("/api/brief", headers=hidden)
    with ledger_session_scope() as session:
        assert brief_service.get_last_seen(session) == NOW - timedelta(hours=2)
    assert _visit() is None


def test_away_20_minutes_across_the_open_is_due(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    left = datetime(2026, 10, 28, 13, 20, tzinfo=UTC)  # the open is 13:30 UTC
    back = left + timedelta(minutes=20)
    _at(monkeypatch, back)
    _seed_seen(left)
    brief = api_client.get("/api/brief").json()  # the same request rolls AND computes
    assert _visit() == (left, back)
    assert brief["due"] is True
    assert brief["kind"] == "session"
    assert [b["kind"] for b in brief["boundaries"]] == ["open"]
    # The window stays frozen for the whole visit.
    _at(monkeypatch, back + timedelta(minutes=3))
    again = api_client.get("/api/brief").json()
    assert _visit() == (left, back)
    assert again["due"] is True
    assert [b["kind"] for b in again["boundaries"]] == ["open"]


def test_a_3_minute_tab_switch_across_the_open_is_not_a_new_visit(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    left = datetime(2026, 10, 28, 13, 29, tzinfo=UTC)
    _at(monkeypatch, left + timedelta(minutes=3))
    _seed_seen(left)
    assert api_client.get("/api/brief").json()["due"] is False
    assert _visit() is None


def test_an_open_that_passes_while_visible_does_not_brief(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Away 11:00-12:00 UTC (no boundary), then visible through the 13:30 open.
    left = datetime(2026, 10, 28, 11, 0, tzinfo=UTC)
    back = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)
    _at(monkeypatch, back)
    _seed_seen(left)
    api_client.get("/api/brief")
    for minute in range(2, 160, 2):  # polling while visible across the open
        _at(monkeypatch, datetime(2026, 10, 28, 12, 0, tzinfo=UTC) + timedelta(minutes=minute))
        api_client.get("/api/overview/both")
    assert _visit() == (left, back)
    assert api_client.get("/api/brief").json()["due"] is False


def test_overnight_gap_without_a_boundary_is_not_due(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    morning = datetime(2026, 10, 28, 12, 30, tzinfo=UTC)  # 08:30 ET, before the open
    _at(monkeypatch, morning)
    left = datetime(2026, 10, 27, 22, 10, tzinfo=UTC)  # after yesterday's close
    _seed_seen(left)
    brief = api_client.get("/api/brief").json()
    assert _visit() == (left, morning)
    assert brief["due"] is False
    assert brief["currency_effect_since"] is None


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
    _set_ack(NOW)
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


def _seed_cash(currency: str, amount: str) -> None:
    with ledger_session_scope() as session:
        acct = accounts_repo.create_account(
            session,
            broker="fidelity",
            account_label=f"Cash {currency}",
            native_currency=currency,
            account_type="cash",
        )
        session.add(
            Transaction(
                account_id=acct.id,
                date=date(2026, 10, 1),
                kind="deposit",
                source=TransactionSource.MANUAL,
                net_native=Decimal(amount),
                created_at=datetime(2026, 10, 1, 14, 0),
            )
        )
        fx_repo.upsert_rates(session, {date(2026, 10, 1): Decimal("1.1600")})
    read_cache.invalidate()


@pytest.fixture
def live_spot() -> Iterator[Decimal]:
    rate = Decimal("1.1650")
    fx_service.set_live_spot("USD", rate, observed_on=NOW.date(), observed_at=NOW)
    yield rate
    fx_service.clear_live_spot()


def _seed_sample(moment: datetime, rate: Decimal) -> None:
    with ledger_session_scope() as session:
        intraday_repo.insert_sample(
            session,
            moment.replace(tzinfo=None),
            Decimal("1000"),
            fx_eur_usd=rate,
            market_value_usd=Decimal("1160"),
        )


def test_currency_effect_since_the_last_visit(api_client: TestClient, live_spot: Decimal) -> None:
    _seed_cash("USD", "10000")
    _seed_cash("EUR", "2000")
    # rate_then is the intraday sample at (just before) the previous visit's last heartbeat.
    _seed_sample(BEFORE_OPEN - timedelta(minutes=5), Decimal("1.1600"))
    _set_marker(BEFORE_OPEN)
    brief = api_client.get("/api/brief").json()
    effect, power = brief["currency_effect_since"], brief["investing_power_since"]
    assert effect is not None
    assert power is not None
    # Each view its own line: EUR = currency effect, USD = investing power.
    assert effect["USD"] is None
    assert power["EUR"] is None
    eur, usd = effect["EUR"], power["USD"]
    for side in (eur, usd):
        assert datetime.fromisoformat(side["since"]) == BEFORE_OPEN
        assert Decimal(side["rate_then"]) == Decimal("1.1600")
    rate_now = Decimal(eur["rate_now"])
    assert rate_now > 0
    assert Decimal(usd["rate_now"]) == rate_now
    # EUR: the dollars revalued at two instants; the euros do not move.
    expected_eur = Decimal("10000") / rate_now - Decimal("10000") / Decimal("1.1600")
    assert abs(Decimal(eur["amount"]) - expected_eur) < Decimal("1e-12")
    base_eur = Decimal("10000") / Decimal("1.1600") + Decimal("2000")
    assert abs(Decimal(eur["pct"]) - expected_eur / base_eur) < Decimal("1e-12")
    # USD: the regular amount (default EUR 100) in dollars, then vs now.
    amount = Decimal(usd["amount_eur"])
    assert amount == Decimal("100")
    assert Decimal(usd["amount_usd_then"]) == amount * Decimal("1.1600")
    assert Decimal(usd["amount_usd_now"]) == amount * rate_now
    assert Decimal(usd["net"]) == amount * (rate_now - Decimal("1.1600"))


def test_currency_effect_since_is_null_without_a_rate_then(
    api_client: TestClient, live_spot: Decimal
) -> None:
    _seed_cash("USD", "10000")
    _set_marker(BEFORE_OPEN)  # no rate recorded with it, no intraday sample there
    brief = api_client.get("/api/brief").json()
    assert brief["due"] is True
    assert brief["currency_effect_since"] is None
    assert brief["investing_power_since"] is None


def test_ack_hides_only_this_visit(api_client: TestClient) -> None:
    _set_marker(BEFORE_OPEN)
    assert api_client.get("/api/brief").json()["due"] is True
    api_client.post("/api/brief/ack", json={"seen_at": NOW.isoformat()})
    assert api_client.get("/api/brief").json()["due"] is False


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


def test_visit_fields_are_reported(api_client: TestClient) -> None:
    _set_marker(BEFORE_OPEN)
    body = api_client.get("/api/brief").json()
    assert datetime.fromisoformat(body["visit_from"]) == BEFORE_OPEN
    assert datetime.fromisoformat(body["last_seen_at"]) == NOW


def test_put_visit_sets_the_window_by_hand_and_clears_the_dismissal(
    api_client: TestClient,
) -> None:
    _set_marker(NOW - timedelta(minutes=1))
    _set_ack(NOW)
    assert api_client.get("/api/brief").json()["due"] is False
    put = api_client.put("/api/brief/visit", json={"visit_from": BEFORE_OPEN.isoformat()})
    assert put.status_code == 200
    body = put.json()
    assert body["due"] is True
    assert body["kind"] == "session"
    assert datetime.fromisoformat(body["visit_from"]) == BEFORE_OPEN
    assert datetime.fromisoformat(body["last_seen_at"]) == NOW
    assert body["last_ack_at"] is None
    assert api_client.get("/api/brief").json()["due"] is True  # it sticks


@pytest.mark.parametrize(
    "value",
    [
        "2030-01-01T00:00:00+00:00",  # the future
        "2026-10-28T15:00:00+00:00",  # now itself
        "2026-09-01T00:00:00+00:00",  # older than 30 days
        "2026-10-27T22:00:00",  # no offset
        "not a date",
    ],
)
def test_put_visit_validates(api_client: TestClient, value: str) -> None:
    assert api_client.put("/api/brief/visit", json={"visit_from": value}).status_code == 422
    assert _visit() is None


def test_delete_visit_goes_back_to_automatic(api_client: TestClient) -> None:
    api_client.put("/api/brief/visit", json={"visit_from": BEFORE_OPEN.isoformat()})
    gone = api_client.delete("/api/brief/visit")
    assert gone.status_code == 200
    assert gone.json()["due"] is False
    assert gone.json()["visit_from"] is None
    assert _visit() is None
