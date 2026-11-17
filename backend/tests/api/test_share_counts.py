"""``/api/diagnostics/share-counts`` (v7 P7)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.repositories import accounts_repo, instruments_repo


def _seed() -> tuple[int, int]:
    with ledger_session_scope() as session:
        account = accounts_repo.create_account(
            session,
            broker="fidelity",
            account_label="Main",
            native_currency="USD",
            account_type="brokerage",
        )
        instr = instruments_repo.get_or_create(session, symbol="FAKE1", asset_class="etf")
        session.flush()
        return account.id, instr.id


def test_empty_until_set(api_client: TestClient) -> None:
    assert api_client.get("/api/diagnostics/share-counts").json() == {"counts": []}


def test_put_then_get_round_trip_and_clear(api_client: TestClient) -> None:
    account_id, instrument_id = _seed()
    body = {
        "counts": [{"account_id": account_id, "instrument_id": instrument_id, "shares": "12.50"}]
    }
    res = api_client.put("/api/diagnostics/share-counts", json=body)
    assert res.status_code == 200
    expected = {
        "counts": [{"account_id": account_id, "instrument_id": instrument_id, "shares": "12.5"}]
    }
    assert res.json() == expected
    assert api_client.get("/api/diagnostics/share-counts").json() == expected
    assert api_client.put("/api/diagnostics/share-counts", json={"counts": []}).json() == {
        "counts": []
    }
    assert api_client.get("/api/diagnostics/share-counts").json() == {"counts": []}


def test_unknown_account_and_duplicates_are_rejected(api_client: TestClient) -> None:
    account_id, instrument_id = _seed()
    unknown = {"counts": [{"account_id": 999, "instrument_id": instrument_id, "shares": "1"}]}
    assert api_client.put("/api/diagnostics/share-counts", json=unknown).status_code == 422
    entry = {"account_id": account_id, "instrument_id": instrument_id, "shares": "1"}
    dup = {"counts": [entry, entry]}
    assert api_client.put("/api/diagnostics/share-counts", json=dup).status_code == 422
    negative = {"counts": [{**entry, "shares": "-1"}]}
    assert api_client.put("/api/diagnostics/share-counts", json=negative).status_code == 422
