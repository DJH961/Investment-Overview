"""Tests for ``/api/allocations`` (GET, PUT, rebalance plan)."""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope

from ._seed import RATE_NOW, seed_ledger


@pytest.fixture
def ids(api_db: object) -> Iterator[dict[str, int]]:
    with ledger_session_scope() as session:
        seeded = seed_ledger(session)
    return seeded


def _target(ids: dict[str, int], **overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "name": "60/40",
        "active": True,
        "allow_sell": False,
        "items": [
            {"instrument_id": ids["VTI"], "weight_pct": "60"},
            {"instrument_id": ids["BND"], "weight_pct": "40"},
        ],
    }
    body.update(overrides)
    return body


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/allocations").status_code == 401
    assert anon_client.put("/api/allocations", json={}).status_code == 401


def test_current_mix_without_target(api_client: TestClient, ids: dict[str, int]) -> None:
    body = api_client.get("/api/allocations?ccy=USD").json()
    assert body["targets"] == []
    assert body["drift"] == []
    assert Decimal(body["total_value"]) == 5150
    by_cat = {b["label"]: b for b in body["current_by_category"]}
    assert Decimal(by_cat["US Stocks"]["value"]) == 3750
    assert Decimal(by_cat["Bonds"]["value"]) == 1400
    assert Decimal(by_cat["US Stocks"]["pct"]) == pytest.approx(Decimal(3750) / 5150)
    eur = api_client.get("/api/allocations?ccy=EUR").json()
    # A value converts at the instant's rate; a percentage does not change.
    assert Decimal(eur["total_value"]) == pytest.approx(
        Decimal(5150) / RATE_NOW, rel=Decimal("1e-9")
    )
    assert eur["current_by_category"][0]["pct"] == body["current_by_category"][0]["pct"]


def test_put_then_get_drift(api_client: TestClient, ids: dict[str, int]) -> None:
    saved = api_client.put("/api/allocations", json=_target(ids))
    assert saved.status_code == 200
    target = saved.json()
    assert target["active"] is True
    assert target["name"] == "60/40"
    assert {i["symbol"]: Decimal(i["weight_pct"]) for i in target["items"]} == {
        "VTI": Decimal("0.6"),
        "BND": Decimal("0.4"),
    }
    body = api_client.get("/api/allocations?ccy=USD").json()
    assert body["active_target_id"] == target["id"]
    drift = {r["label"]: r for r in body["drift"]}
    assert Decimal(drift["VTI"]["current_pct"]) == pytest.approx(Decimal(3750) / 5150)
    assert Decimal(drift["VTI"]["drift_pp"]) == pytest.approx(
        Decimal(3750) / 5150 * 100 - 60, rel=Decimal("1e-9")
    )
    assert Decimal(drift["VTI"]["drift_pp"]) > 0  # over-allocated
    assert Decimal(drift["BND"]["drift_pp"]) < 0
    # Amount to hit target: 60 % of 5150 = 3090 vs 3750 held.
    assert Decimal(drift["VTI"]["delta_value"]) == Decimal(3090) - 3750
    assert body["drift"][0]["label"] == "VTI"  # sorted by |drift|


def test_put_normalises_replaces_and_validates(api_client: TestClient, ids: dict[str, int]) -> None:
    first = api_client.put(
        "/api/allocations",
        json=_target(
            ids,
            items=[
                {"instrument_id": ids["VTI"], "weight_pct": "3"},
                {"instrument_id": ids["BND"], "weight_pct": "1", "no_buy": True},
            ],
        ),
    ).json()
    weights = {i["symbol"]: Decimal(i["weight_pct"]) for i in first["items"]}
    assert weights == {"VTI": Decimal("0.75"), "BND": Decimal("0.25")}
    assert next(i for i in first["items"] if i["symbol"] == "BND")["no_buy"] is True

    replaced = api_client.put(
        "/api/allocations", json=_target(ids, id=first["id"], name="renamed", active=False)
    )
    assert replaced.status_code == 200
    listed = api_client.get("/api/allocations").json()["targets"]
    assert [t["name"] for t in listed] == ["renamed"]

    dup = api_client.put("/api/allocations", json=_target(ids, name="renamed"))
    assert dup.status_code == 409
    assert api_client.put("/api/allocations", json=_target(ids, items=[])).status_code == 422
    unknown = _target(ids, name="x", items=[{"instrument_id": 9999, "weight_pct": "10"}])
    assert api_client.put("/api/allocations", json=unknown).status_code == 422
    assert (
        api_client.put("/api/allocations", json=_target(ids, id=4242, name="y")).status_code == 422
    )
    assert (
        api_client.put("/api/allocations", json=_target(ids, display_currency="GBP")).status_code
        == 422
    )


def test_rebalance_plan(api_client: TestClient, ids: dict[str, int]) -> None:
    api_client.put("/api/allocations", json=_target(ids))
    usd = api_client.get("/api/allocations/rebalance?amount=1200&ccy=USD&fractional=true")
    assert usd.status_code == 200
    plan = usd.json()
    rows = {r["symbol"]: r for r in plan["rows"]}
    adds = [Decimal(r["add_value"]) for r in plan["rows"]]
    assert sum(adds) + Decimal(plan["residual_cash"]) == pytest.approx(Decimal(1200))
    assert all(a >= 0 for a in adds)  # buy-only
    assert Decimal(rows["BND"]["add_value"]) > Decimal(rows["VTI"]["add_value"])

    # The same cash expressed in EUR (1200 USD = 1000 EUR at the spot) gives the same plan.
    eur = api_client.get("/api/allocations/rebalance?amount=1000&ccy=EUR&fractional=true").json()
    eur_rows = {r["symbol"]: r for r in eur["rows"]}
    for sym in ("VTI", "BND"):
        assert Decimal(eur_rows[sym]["add_shares"]) == pytest.approx(
            Decimal(rows[sym]["add_shares"]), rel=Decimal("1e-6")
        )
    assert Decimal(eur_rows["BND"]["add_value"]) * RATE_NOW == pytest.approx(
        Decimal(rows["BND"]["add_value"]), rel=Decimal("1e-6")
    )


def test_rebalance_errors(api_client: TestClient, ids: dict[str, int]) -> None:
    no_target = api_client.get("/api/allocations/rebalance?amount=100")
    assert no_target.status_code == 422
    api_client.put("/api/allocations", json=_target(ids))
    assert api_client.get("/api/allocations/rebalance").status_code == 422  # amount required
    assert api_client.get("/api/allocations/rebalance?amount=-5").status_code == 422
    assert api_client.get("/api/allocations/rebalance?amount=0").status_code == 422  # buy-only
    assert api_client.get("/api/allocations/rebalance?amount=10&ccy=GBP").status_code == 422
