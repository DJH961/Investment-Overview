# ruff: noqa: PT018
"""``/api/imports/wise``, kept dollars and "received in USD" deposits (7.3)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Account, FxConversion, FxHistory, Transaction
from investment_dashboard.services import settings_service, wise_import_service

FIXTURE = Path(__file__).parents[1] / "fixtures" / "wise_statement.csv"


@pytest.fixture(autouse=True)
def _clean() -> Iterator[None]:
    wise_import_service.clear()
    yield
    wise_import_service.clear()


def _upload(client: TestClient, content: bytes | None = None) -> dict[str, Any]:
    data = FIXTURE.read_bytes() if content is None else content
    res = client.post("/api/imports/wise", files={"file": ("wise.csv", data, "text/csv")})
    assert res.status_code == 201, res.text
    return dict(res.json())


def test_requires_auth(anon_client: TestClient) -> None:
    res = anon_client.post("/api/imports/wise", files={"file": ("a.csv", b"x", "text/csv")})
    assert res.status_code == 401


def test_preview_lists_every_row_with_reasons(api_client: TestClient) -> None:
    prev = _upload(api_client)
    by_status: dict[str, list[dict[str, Any]]] = {}
    for r in prev["rows"]:
        by_status.setdefault(r["status"], []).append(r)
    assert {k: len(v) for k, v in by_status.items()} == {
        "conversion": 3,
        "skipped": 4,
        "ignored": 1,
    }
    assert all(r["reason"] for r in by_status["skipped"] + by_status["ignored"])
    assert prev["counts"] == {"rows": 8, "new": 3, "duplicates": 0, "skipped": 5}
    assert prev["ignore_non_usd"] is True and prev["missing"] == []
    assert api_client.get("/api/fx-conversions").json() == []  # nothing written


def test_confirm_writes_chosen_rows_and_reimport_is_all_duplicates(
    api_client: TestClient,
) -> None:
    prev = _upload(api_client)
    conv = {r["external_id"]: r for r in prev["rows"] if r["status"] == "conversion"}
    assert set(conv) == {"CONVERSION_ORDER-111", "TRANSFER-222", "CONVERSION_ORDER-777"}
    # tick off the 777 row, keep $15 of the 111 conversion
    res = api_client.post(
        f"/api/imports/wise/{prev['import_id']}/confirm",
        json={
            "rows": [
                {"line": conv["CONVERSION_ORDER-777"]["line"], "skip": True},
                {"line": conv["CONVERSION_ORDER-111"]["line"], "kept_usd": "15"},
            ]
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["imported"] == 2 and res.json()["skipped"] == 6
    rows = {r["note"] or r["usd_received"]: r for r in api_client.get("/api/fx-conversions").json()}
    assert len(rows) == 2
    with ledger_session_scope() as s:
        saved = {r.external_id: r for r in s.query(FxConversion).all()}
    assert set(saved) == {"CONVERSION_ORDER-111", "TRANSFER-222"}
    assert saved["CONVERSION_ORDER-111"].provider == "wise"
    assert saved["CONVERSION_ORDER-111"].kept_usd == Decimal("15")
    assert saved["TRANSFER-222"].kept_usd == 0
    assert saved["TRANSFER-222"].fees_eur == Decimal("2.34")
    # an exact re-import: everything is a duplicate
    again = _upload(api_client)
    assert again["counts"]["new"] == 1  # only the row that was ticked off before
    assert again["counts"]["duplicates"] == 2
    assert api_client.get("/api/fx-conversions").json()[0]["kept_usd"] in {"15.000000", "0.000000"}


def test_kept_beyond_received_is_rejected(api_client: TestClient) -> None:
    prev = _upload(api_client)
    row = next(r for r in prev["rows"] if r["external_id"] == "TRANSFER-222")
    res = api_client.post(
        f"/api/imports/wise/{prev['import_id']}/confirm",
        json={"rows": [{"line": row["line"], "kept_usd": "999999"}]},
    )
    assert res.status_code == 422


def test_other_pair_unsupported_when_the_setting_is_off(api_client: TestClient) -> None:
    settings_service.set_many({"import.ignore_non_usd_conversions": False}, actor="test")
    prev = _upload(api_client)
    gbp = next(r for r in prev["rows"] if r["external_id"] == "CONVERSION_ORDER-666")
    assert gbp["status"] == "unsupported" and "only EUR to USD" in gbp["reason"]
    assert prev["ignore_non_usd"] is False


def test_unknown_layout_asks_for_columns_and_maps_by_hand(api_client: TestClient) -> None:
    text = FIXTURE.read_text(encoding="utf-8").replace("TransferWise ID", "Ref")
    prev = _upload(api_client, text.encode())
    assert prev["missing"] == ["id"] and prev["rows"] == []
    res = api_client.post(
        f"/api/imports/wise/{prev['import_id']}/layout",
        json={"columns": {"id": prev["headers"].index("Ref")}},
    )
    assert res.status_code == 200 and res.json()["missing"] == []
    assert res.json()["counts"]["new"] == 3
    assert api_client.post("/api/imports/wise/nope/layout", json={"columns": {}}).status_code == 404


def test_discard_and_expired(api_client: TestClient) -> None:
    prev = _upload(api_client)
    assert api_client.delete(f"/api/imports/wise/{prev['import_id']}").status_code == 200
    assert api_client.delete(f"/api/imports/wise/{prev['import_id']}").status_code == 404
    res = api_client.post(f"/api/imports/wise/{prev['import_id']}/confirm", json={"rows": []})
    assert res.status_code == 404


def test_garbage_is_a_422(api_client: TestClient) -> None:
    res = api_client.post("/api/imports/wise", files={"file": ("a.csv", b"", "text/csv")})
    assert res.status_code == 422


# ----------------------------------------------------------------- kept dollars


def _usd_account_with_deposits(*amounts: tuple[date, str]) -> list[int]:
    with ledger_session_scope() as s:
        acct = Account(broker="vanguard", account_label="K", native_currency="USD")
        s.add(acct)
        s.flush()
        s.add(FxHistory(date=date(2024, 1, 1), base="EUR", quote="USD", rate=Decimal("1.25")))
        rows = [
            Transaction(
                account_id=acct.id, date=d, kind="deposit", net_native=Decimal(n), source="manual"
            )
            for d, n in amounts
        ]
        s.add_all(rows)
        s.flush()
        return [r.id for r in rows]


def test_kept_dollars_stay_out_of_the_pool(api_client: TestClient) -> None:
    (dep,) = _usd_account_with_deposits((date(2024, 2, 1), "1000"))
    body = {"date": "2024-01-15", "eur_sent": "800", "usd_received": "1000", "kept_usd": "250"}
    created = api_client.post("/api/fx-conversions", json=body)
    assert created.status_code == 201
    assert Decimal(created.json()["kept_usd"]) == 250
    assert Decimal(created.json()["remaining_usd"]) == 0  # the deposit used the other 750
    pool = api_client.get("/api/fx-conversions/pool").json()
    match = pool["deposits"][0]
    assert Decimal(match["fallback_usd"]) == 250 and match["status"] == "partial"
    assert Decimal(pool["balance_usd"]) == 0
    assert dep == match["transaction_id"]
    # kept above the dollars received is refused
    assert (
        api_client.post("/api/fx-conversions", json={**body, "kept_usd": "1001"}).status_code == 422
    )
    assert (
        api_client.post("/api/fx-conversions", json={**body, "kept_usd": "-1"}).status_code == 422
    )


# -------------------------------------------------------- received in USD + health


def test_received_in_usd_mark_status_and_quiet_health_check(api_client: TestClient) -> None:
    d1, d2 = _usd_account_with_deposits((date(2024, 2, 1), "500"), (date(2024, 3, 1), "700"))
    api_client.post(
        "/api/fx-conversions", json={"date": "2024-01-15", "eur_sent": "10", "usd_received": "10"}
    )

    def health() -> dict[str, Any]:
        checks = api_client.get("/api/diagnostics").json()["checks"]
        return next(c for c in checks if c["id"] == "ecb_fallback_deposits")

    assert health()["severity"] == "info" and health()["count"] == 2
    assert "valued at the ECB rate with no conversion" in health()["detail"]
    assert health()["actions"][0]["href"] == "/conversions"

    res = api_client.put(f"/api/fx-conversions/received-in-usd/{d2}")
    assert res.status_code == 200
    assert res.json()["status"] == "received_usd" and res.json()["received_in_usd"] is True
    assert health()["count"] == 1
    pool = {
        d["transaction_id"]: d
        for d in api_client.get("/api/fx-conversions/pool").json()["deposits"]
    }
    assert pool[d1]["status"] == "partial" and pool[d2]["status"] == "received_usd"
    # a marked deposit never takes pool dollars and cannot be pinned
    pin = api_client.put(
        f"/api/fx-conversions/pins/{d2}", json={"pins": [{"conversion_id": 1, "usd": "1"}]}
    )
    assert pin.status_code == 422
    # unmark brings it back
    assert api_client.delete(f"/api/fx-conversions/received-in-usd/{d2}").status_code == 204
    assert health()["count"] == 2
    assert api_client.put("/api/fx-conversions/received-in-usd/9999").status_code == 422
