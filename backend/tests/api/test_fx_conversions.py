# ruff: noqa: PT018
"""API tests for ``/api/fx-conversions``."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Account, FxHistory, Transaction

BODY = {"date": "2024-01-15", "eur_sent": "1000", "usd_received": "1100", "fees_eur": "10"}


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/fx-conversions").status_code == 401


def test_crud(api_client: TestClient) -> None:
    created = api_client.post("/api/fx-conversions", json=BODY)
    assert created.status_code == 201
    row = created.json()
    assert Decimal(row["eur_sent"]) == 1000
    assert row["effective_rate"].startswith("1.1")
    assert api_client.get("/api/fx-conversions").json()[0]["id"] == row["id"]
    put = api_client.put(f"/api/fx-conversions/{row['id']}", json={**BODY, "note": "n"})
    assert put.status_code == 200 and put.json()["note"] == "n"
    assert api_client.delete(f"/api/fx-conversions/{row['id']}").status_code == 204
    assert api_client.delete(f"/api/fx-conversions/{row['id']}").status_code == 404
    assert api_client.put("/api/fx-conversions/99", json=BODY).status_code == 404


def test_validation(api_client: TestClient) -> None:
    assert api_client.post("/api/fx-conversions", json={**BODY, "eur_sent": "0"}).status_code == 422
    future = (date.today() + timedelta(days=2)).isoformat()
    assert api_client.post("/api/fx-conversions", json={**BODY, "date": future}).status_code == 422


def test_pool(api_client: TestClient) -> None:
    with ledger_session_scope() as s:
        acct = Account(broker="vanguard", account_label="V", native_currency="USD")
        s.add(acct)
        s.flush()
        s.add(FxHistory(date=date(2024, 1, 1), base="EUR", quote="USD", rate=Decimal("1.25")))
        s.add(
            Transaction(
                account_id=acct.id,
                date=date(2024, 2, 1),
                kind="deposit",
                net_native=Decimal("1500"),
                source="manual",
            )
        )
    api_client.post("/api/fx-conversions", json=BODY)
    pool = api_client.get("/api/fx-conversions/pool").json()
    assert len(pool["deposits"]) == 1
    dep = pool["deposits"][0]
    assert dep["fallback_to_ecb"] is True
    assert Decimal(dep["fallback_usd"]) == 400
    assert pool["fallbacks"] == [dep]
    assert Decimal(pool["balance_usd"]) == 0


def _seed_pin_ledger() -> list[int]:
    """Account + D1 (2024-02-01, $1000) + D2 (2024-03-01, $500); returns [d1, d2] ids."""
    with ledger_session_scope() as s:
        acct = Account(broker="vanguard", account_label="V2", native_currency="USD")
        s.add(acct)
        s.flush()
        s.add(FxHistory(date=date(2024, 1, 1), base="EUR", quote="USD", rate=Decimal("1.25")))
        rows = [
            Transaction(
                account_id=acct.id, date=d, kind="deposit", net_native=Decimal(n), source="manual"
            )
            for d, n in ((date(2024, 2, 1), "1000"), (date(2024, 3, 1), "500"))
        ]
        s.add_all(rows)
        s.flush()
        return [r.id for r in rows]


def _conv(api_client: TestClient, on: str, eur: str, usd: str) -> int:
    r = api_client.post(
        "/api/fx-conversions", json={"date": on, "eur_sent": eur, "usd_received": usd}
    )
    assert r.status_code == 201, r.text
    return int(r.json()["id"])


def test_pins_happy_path_unpin_and_sorting(api_client: TestClient) -> None:
    d1, d2 = _seed_pin_ledger()
    c_early = _conv(api_client, "2024-01-10", "900", "1000")
    c_late = _conv(api_client, "2024-03-05", "460", "500")  # 4 days after D2 (2024-03-01)
    listed = api_client.get("/api/fx-conversions").json()
    assert [r["id"] for r in listed] == [c_late, c_early]  # newest first
    assert listed[0]["provider"] is None and listed[0]["from_ccy"] == "EUR"
    assert Decimal(listed[1]["all_in_rate"]) == Decimal("1000") / Decimal("900")

    pre = api_client.get("/api/fx-conversions/pool").json()
    assert [d["transaction_id"] for d in pre["deposits"]] == [d2, d1]  # newest first

    put = api_client.put(
        f"/api/fx-conversions/pins/{d2}", json={"pins": [{"conversion_id": c_late, "usd": "500"}]}
    )
    assert put.status_code == 200, put.text
    dep = put.json()
    assert dep["transaction_id"] == d2 and dep["pinned"] is True
    assert dep["status"] == "matched"
    assert dep["slices"][0]["conversion_id"] == c_late and dep["slices"][0]["pinned"] is True
    assert dep["fallback_to_ecb"] is False

    listed = {r["id"]: r for r in api_client.get("/api/fx-conversions").json()}
    assert listed[c_late]["used_by"][0]["deposit_id"] == d2
    assert listed[c_late]["used_by"][0]["pinned"] is True
    assert Decimal(listed[c_late]["remaining_usd"]) == 0

    assert api_client.delete(f"/api/fx-conversions/pins/{d2}").status_code == 204
    pool = api_client.get("/api/fx-conversions/pool").json()
    dep2 = next(d for d in pool["deposits"] if d["transaction_id"] == d2)
    assert dep2["pinned"] is False and dep2["status"] == "ecb_only"
    assert pool["rejected_pins"] == []


def test_pin_validation_errors(api_client: TestClient) -> None:
    _d1, d2 = _seed_pin_ledger()
    c_far = _conv(api_client, "2024-03-20", "900", "1000")  # 19 days after D2
    c_ok = _conv(api_client, "2024-02-01", "900", "1000")
    url = "/api/fx-conversions/pins/"
    far = api_client.put(f"{url}{d2}", json={"pins": [{"conversion_id": c_far, "usd": "10"}]})
    assert far.status_code == 422
    over = api_client.put(f"{url}{d2}", json={"pins": [{"conversion_id": c_ok, "usd": "501"}]})
    assert over.status_code == 422
    not_deposit = api_client.put(f"{url}9999", json={"pins": []})
    assert not_deposit.status_code == 422


def test_conversion_provider_and_pair_validation(api_client: TestClient) -> None:
    ok = api_client.post("/api/fx-conversions", json={**BODY, "provider": "wise"})
    assert ok.status_code == 201 and ok.json()["provider"] == "wise"
    bad_pair = api_client.post("/api/fx-conversions", json={**BODY, "from_ccy": "GBP"})
    assert bad_pair.status_code == 422
    bad_provider = api_client.post("/api/fx-conversions", json={**BODY, "provider": "bank"})
    assert bad_provider.status_code == 422


def test_reference_published_and_not(api_client: TestClient) -> None:
    with ledger_session_scope() as s:
        s.add(FxHistory(date=date(2024, 1, 15), base="EUR", quote="USD", rate=Decimal("1.0950")))
    hit = api_client.get("/api/fx-conversions/reference", params={"date": "2024-01-15"}).json()
    assert hit == {"date": "2024-01-15", "ecb_rate": "1.0950", "published": True} or (
        Decimal(hit["ecb_rate"]) == Decimal("1.095") and hit["published"] is True
    )
    miss = api_client.get("/api/fx-conversions/reference", params={"date": "2024-01-14"}).json()
    assert miss == {"date": "2024-01-14", "ecb_rate": None, "published": False}
