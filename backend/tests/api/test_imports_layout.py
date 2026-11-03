"""``/api/imports``: the flexible importer (generic broker, layout questions, ``/layout``)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.adapters.frankfurter_client import FrankfurterError
from investment_dashboard.db import ledger_session_scope
from investment_dashboard.repositories import accounts_repo, fx_repo
from investment_dashboard.services import (
    fx_service,
    import_staging,
    importer_service,
    instrument_enrichment_service,
    settings_service,
)

FIXTURES = Path(__file__).parents[1] / "adapters" / "fixtures"


@pytest.fixture(autouse=True)
def _offline() -> Iterator[None]:
    import_staging.clear()
    settings_service.invalidate()
    with (
        patch.object(fx_service, "fetch_rates", side_effect=FrankfurterError("offline")),
        patch.object(instrument_enrichment_service, "fetch_instrument_info", return_value=None),
    ):
        yield
    import_staging.clear()
    settings_service.invalidate()


def _seed_account(broker: str) -> int:
    with ledger_session_scope() as s:
        acct = accounts_repo.create_account(
            s,
            broker=broker,
            account_label=broker.title(),
            native_currency="USD",
            account_type="brokerage",
        )
        fx_repo.upsert_rates(
            s, {date(2024, 1, 15): Decimal("1.08"), date(2024, 2, 15): Decimal("1.07")}
        )
        return acct.id


@pytest.fixture
def account_id(api_db: object) -> int:
    return _seed_account("fidelity")


@pytest.fixture
def bank_account_id(api_db: object) -> int:
    return _seed_account("savings_bank")


_GENERIC = (
    "Date,Action,Symbol,Quantity,Price,Amount\n"
    "01/15/2024,Buy,VWRL,10,100.00,-1000.00\n"
    "02/15/2024,Sell,VWRL,-4,110.00,440.00\n"
)
_NO_PRICE = (
    "Date,Action,Symbol,Quantity,Amount\n"
    "01/15/2024,Buy,VWRL,10,-1000.00\n"
    "02/15/2024,Sell,VWRL,-4,440.00\n"
)
_NO_PRICE_REORDERED = (
    "Amount,Quantity,Symbol,Action,Date\n"
    "-300.00,3,VWRL,Buy,01/15/2024\n"
    "-100.00,1,VWRL,Buy,02/15/2024\n"
)


def _upload(client: TestClient, content: str, name: str = "trades.csv", **form: object) -> Any:
    return client.post(
        "/api/imports",
        files={"file": (name, content.encode(), "text/csv")},
        data={k: str(v) for k, v in form.items()},
    )


def _count(client: TestClient) -> int:
    return client.get("/api/transactions", params={"hide_sweeps": "false"}).json()["total"]


def _col(preview: dict[str, Any], header: str) -> dict[str, Any]:
    return next(c for c in preview["layout"]["columns"] if c["header"] == header)


def test_brokers_list_includes_generic(api_client: TestClient) -> None:
    resp = api_client.get("/api/imports/brokers")
    assert resp.status_code == 200
    by_id = {b["id"]: b for b in resp.json()}
    assert by_id["generic"]["label"] == "Other / any file"
    assert {"fidelity", "vanguard"} <= set(by_id)


def test_generic_upload_uses_flexible_parser_and_returns_layout(
    api_client: TestClient, account_id: int
) -> None:
    resp = _upload(api_client, _GENERIC, broker="generic", account_id=account_id)
    assert resp.status_code == 201, resp.text
    preview = resp.json()
    assert preview["broker"] == "generic"
    assert preview["parser"] == "flexible"
    assert preview["can_confirm"] is True
    assert preview["counts"]["rows"] == 2
    layout = preview["layout"]
    assert layout is not None
    assert layout["questions"] == []
    assert layout["decimal"] == "."
    assert {f["id"] for f in layout["fields"]} >= {"date", "action", "amount", "price"}
    assert _col(preview, "Date")["field"] == "date"
    assert _col(preview, "Amount")["field"] == "amount"
    assert _count(api_client) == 0

    done = api_client.post(f"/api/imports/{preview['import_id']}/confirm")
    assert done.status_code == 200, done.text
    assert done.json()["inserted"] == 2
    assert _count(api_client) == 2


def test_account_with_unknown_broker_defaults_to_generic(
    api_client: TestClient, bank_account_id: int
) -> None:
    resp = _upload(api_client, _GENERIC, account_id=bank_account_id)
    assert resp.status_code == 201, resp.text
    assert resp.json()["broker"] == "generic"
    assert resp.json()["parser"] == "flexible"


def test_standard_broker_file_reports_standard_parser(
    api_client: TestClient, account_id: int
) -> None:
    data = (FIXTURES / "fidelity_sample.csv").read_bytes()
    resp = api_client.post(
        "/api/imports",
        files={"file": ("fidelity_sample.csv", data, "text/csv")},
        data={"account_id": str(account_id)},
    )
    assert resp.status_code == 201
    assert resp.json()["parser"] == "standard"
    assert resp.json()["can_confirm"] is True


def test_missing_price_blocks_confirm(api_client: TestClient, account_id: int) -> None:
    resp = _upload(api_client, _NO_PRICE, broker="generic", account_id=account_id)
    assert resp.status_code == 201, resp.text
    preview = resp.json()
    assert preview["can_confirm"] is False
    questions = {q["field"]: q for q in preview["layout"]["questions"]}
    assert questions["price"]["can_derive"] is True

    done = api_client.post(f"/api/imports/{preview['import_id']}/confirm")
    assert done.status_code == 422, done.text
    assert _count(api_client) == 0
    # The staged import survives the refusal, so the user can still answer it.
    again = api_client.post(f"/api/imports/{preview['import_id']}/layout", json={"derive": []})
    assert again.status_code == 200


def test_layout_derive_price_unblocks_confirm(api_client: TestClient, account_id: int) -> None:
    first = _upload(api_client, _NO_PRICE, broker="generic", account_id=account_id).json()
    resp = api_client.post(f"/api/imports/{first['import_id']}/layout", json={"derive": ["price"]})
    assert resp.status_code == 200, resp.text
    second = resp.json()
    assert second["import_id"] != first["import_id"]
    assert second["parser"] == "flexible"
    assert second["can_confirm"] is True
    assert second["layout"]["questions"] == []
    assert second["layout"]["derive"] == ["price"]
    assert [Decimal(r["price_native"]) for r in second["rows"]] == [Decimal(100), Decimal(110)]

    # The old id is gone; the new one confirms.
    assert api_client.post(f"/api/imports/{first['import_id']}/confirm").status_code == 404
    done = api_client.post(f"/api/imports/{second['import_id']}/confirm")
    assert done.status_code == 200, done.text
    assert done.json()["inserted"] == 2
    assert _count(api_client) == 2


def test_layout_can_remap_columns(api_client: TestClient, account_id: int) -> None:
    content = (
        "When,What,Sym,Qty,Cash\n01/15/2024,Buy,VWRL,10,-1000.00\n02/15/2024,Sell,VWRL,-4,440.00\n"
    )
    first = _upload(api_client, content, broker="generic", account_id=account_id).json()
    resp = api_client.post(
        f"/api/imports/{first['import_id']}/layout",
        json={
            "header_row": 0,
            "columns": {"date": 0, "action": 1, "symbol": 2, "quantity": 3, "amount": 4},
            "derive": ["price"],
        },
    )
    assert resp.status_code == 200, resp.text
    second = resp.json()
    assert second["can_confirm"] is True
    assert second["counts"]["rows"] == 2
    assert _col(second, "Cash")["by"] == "user"


def test_layout_unknown_import_is_404(api_client: TestClient) -> None:
    resp = api_client.post("/api/imports/doesnotexist/layout", json={"derive": ["price"]})
    assert resp.status_code == 404


def test_layout_rejects_bad_derive_value(api_client: TestClient, account_id: int) -> None:
    first = _upload(api_client, _NO_PRICE, broker="generic", account_id=account_id).json()
    resp = api_client.post(f"/api/imports/{first['import_id']}/layout", json={"derive": ["bogus"]})
    assert resp.status_code == 422


def test_layout_remember_saves_and_applies_to_next_upload(
    api_client: TestClient, account_id: int
) -> None:
    first = _upload(api_client, _NO_PRICE, broker="generic", account_id=account_id).json()
    signature = first["layout"]["signature"]
    assert signature
    resp = api_client.post(
        f"/api/imports/{first['import_id']}/layout",
        json={"derive": ["price"], "columns": {"amount": 4}, "remember": True},
    )
    assert resp.status_code == 200, resp.text

    profiles = settings_service.get_or(importer_service.COLUMN_PROFILES_KEY, {})
    assert signature in profiles
    saved = importer_service.choice_from_json(profiles[signature])
    assert saved is not None
    assert saved.derive == frozenset({"price"})
    assert saved.columns == {"amount": "Amount"}  # stored by header name, not position

    # A different file with the same headers (columns in another order) is read with it.
    fresh = _upload(api_client, _NO_PRICE_REORDERED, broker="generic", account_id=account_id)
    assert fresh.status_code == 201, fresh.text
    preview = fresh.json()
    assert preview["can_confirm"] is True
    assert preview["layout"]["questions"] == []
    assert preview["layout"]["derive"] == ["price"]
    assert _col(preview, "Amount")["by"] in {"saved", "user"}
    assert [Decimal(r["price_native"]) for r in preview["rows"]] == [Decimal(100), Decimal(100)]


def test_layout_without_remember_stores_nothing(api_client: TestClient, account_id: int) -> None:
    first = _upload(api_client, _NO_PRICE, broker="generic", account_id=account_id).json()
    api_client.post(f"/api/imports/{first['import_id']}/layout", json={"derive": ["price"]})
    assert settings_service.get_or(importer_service.COLUMN_PROFILES_KEY, {}) == {}
    fresh = _upload(api_client, _NO_PRICE_REORDERED, broker="generic", account_id=account_id).json()
    assert fresh["can_confirm"] is False


def test_ambiguous_dates_block_until_order_is_given(
    api_client: TestClient, account_id: int
) -> None:
    content = (
        "Date,Action,Symbol,Quantity,Price,Amount\n"
        "01/05/2024,Buy,VWRL,10,100.00,-1000.00\n"
        "02/03/2024,Buy,VWRL,1,100.00,-100.00\n"
    )
    first = _upload(api_client, content, broker="generic", account_id=account_id).json()
    assert first["can_confirm"] is False
    assert [q["field"] for q in first["layout"]["questions"]] == ["date_order"]
    second = api_client.post(
        f"/api/imports/{first['import_id']}/layout", json={"date_order": "DMY"}
    ).json()
    assert second["can_confirm"] is True
    assert second["layout"]["date_order"] == "DMY"
    assert second["rows"][0]["date"] == "2024-05-01"


def test_unreadable_file_is_422(api_client: TestClient, account_id: int) -> None:
    resp = api_client.post(
        "/api/imports",
        files={
            "file": ("old.xls", b"\xd0\xcf\x11\xe0" + b"\x00" * 100, "application/vnd.ms-excel")
        },
        data={"broker": "generic", "account_id": str(account_id)},
    )
    assert resp.status_code == 422
    assert ".xls" in resp.text
