"""``GET /api/holdings/{instrument_id}/tranches`` on the shared seed ledger.

VTI: Brokerage bought 10 @ 200 (cost 2000) on 5 Jan 2025, Roth 5 @ 210 (1050) on
7 Jan 2025; today's close 250. Gains 10 x 250 - 2000 = 500 and 5 x 250 - 1050 = 200.
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
    assert anon_client.get("/api/holdings/1/tranches").status_code == 401


def test_unknown_instrument(api_client: TestClient, ids: dict[str, int]) -> None:
    assert api_client.get("/api/holdings/99999/tranches").status_code == 404


def test_tranches_shape_and_values(api_client: TestClient, ids: dict[str, int]) -> None:
    res = api_client.get(f"/api/holdings/{ids['VTI']}/tranches")
    assert res.status_code == 200
    body = res.json()
    assert body["symbol"] == "VTI"
    assert body["method"] == "fifo_view"
    assert body["currency"] == "USD"
    assert Decimal(body["price_native"]) == 250
    rows = body["rows"]
    assert [r["account_name"] for r in rows] == ["Brokerage", "Roth"]
    assert [r["acquired_on"] for r in rows] == ["2025-01-05", "2025-01-07"]
    assert [Decimal(r["gain_native"]) for r in rows] == [500, 200]
    assert [Decimal(r["cost_per_share_native"]) for r in rows] == [200, 210]
    assert rows[0]["long_term_on"] == "2026-01-06"
    assert all(r["source"] == "buy" for r in rows)
    assert body["groups"] == []
    totals = body["totals"]
    assert Decimal(totals["quantity_left"]) == 15
    assert Decimal(totals["position_quantity"]) == 15
    assert totals["matches_position"] is True
    assert totals["fully_sold_count"] == 0
