"""``GET /api/holdings/{instrument_id}/peek`` on the shared seed ledger.

VTI: Brokerage bought 10 @ 200 on 5 Jan 2025, Roth 5 @ 210 on 7 Jan 2025; both lots
are long-term already (so nothing is "next"), and the last trade is the Roth buy.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope

from ._seed import seed_ledger


@pytest.fixture
def ids(api_db: object) -> dict[str, int]:
    with ledger_session_scope() as session:
        out = seed_ledger(session)
    return out


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/holdings/1/peek").status_code == 401


def test_unknown_instrument(api_client: TestClient, ids: dict[str, int]) -> None:
    assert api_client.get("/api/holdings/99999/peek").status_code == 404


def test_peek_summarises_tranches_and_last_trade(
    api_client: TestClient, ids: dict[str, int]
) -> None:
    res = api_client.get(f"/api/holdings/{ids['VTI']}/peek")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["instrument_id"] == ids["VTI"]
    assert body["currency"] == "USD"
    assert body["tranches"] == {
        "open_count": 2,
        "next_long_term_on": None,
        "next_long_term_days": None,
    }
    trade = body["last_trade"]
    assert trade["date"] == "2025-01-07"
    assert trade["kind"] == "buy"
    assert Decimal(trade["quantity"]) == 5
    assert Decimal(trade["price_native"]) == 210
    # The week block is present for a listed ETF (points may be empty without stored bars).
    assert body["week"] is not None
    assert isinstance(body["week"]["points"], list)
