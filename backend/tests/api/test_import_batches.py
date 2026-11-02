"""Import history, undo and action-map overrides (``/api/imports/...``)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.adapters.fidelity.parser import parse_fidelity_csv
from investment_dashboard.adapters.frankfurter_client import FrankfurterError
from investment_dashboard.adapters.vanguard.action_map import map_transaction_type
from investment_dashboard.api import guards
from investment_dashboard.api.security import Principal
from investment_dashboard.db import ledger_session_scope
from investment_dashboard.repositories import accounts_repo, fx_repo
from investment_dashboard.services import (
    fx_service,
    import_staging,
    instrument_enrichment_service,
    settings_service,
)

FIXTURES = Path(__file__).parents[1] / "adapters" / "fixtures"
CSV = (FIXTURES / "fidelity_sample.csv").read_bytes()
UNKNOWN = b"03/20/2024,SOMETHING BRAND NEW,,ODD,Cash,0,0,0,0,0,12.00,1.00,03/20/2024\n"


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


@pytest.fixture
def account_id(api_db: object) -> int:
    with ledger_session_scope() as s:
        acct = accounts_repo.create_account(
            s, broker="fidelity", account_label="Fid", native_currency="USD"
        )
        fx_repo.upsert_rates(s, {date(2024, 1, 5): Decimal("1.08")})
        return acct.id


def _as(monkeypatch: pytest.MonkeyPatch, kind: str) -> None:
    async def principal(_r: object) -> Principal:
        return Principal(kind=kind, session_id="0123456789abcdef" if kind == "session" else None)

    monkeypatch.setattr(guards, "_principal", principal)


def _import(client: TestClient, account_id: int, content: bytes = CSV) -> dict:
    up = client.post(
        "/api/imports",
        files={"file": ("fid.csv", content, "text/csv")},
        data={"account_id": str(account_id)},
    )
    assert up.status_code == 201, up.text
    done = client.post(f"/api/imports/{up.json()['import_id']}/confirm")
    assert done.status_code == 200, done.text
    return done.json()


def _count(client: TestClient) -> int:
    return client.get("/api/transactions", params={"hide_sweeps": "false"}).json()["total"]


def test_confirm_records_batch_and_undo_restores_counts(
    api_client: TestClient, account_id: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = _count(api_client)
    result = _import(api_client, account_id)
    assert result["inserted"] > 0
    assert result["import_batch_id"]
    batch_id = result["import_batch_id"]
    # Re-importing the same file inserts nothing and leaves no empty batch.
    assert _import(api_client, account_id)["import_batch_id"] is None

    batches = api_client.get("/api/imports/batches").json()["batches"]
    assert [b["id"] for b in batches] == [batch_id]
    assert batches[0]["row_count"] == result["inserted"] == batches[0]["current_rows"]
    assert batches[0]["filename"] == "fid.csv"
    assert batches[0]["can_undo"]

    preview = api_client.get(f"/api/imports/batches/{batch_id}/undo-preview").json()
    assert preview["total"] == result["inserted"]
    assert preview["confirm_word"] == "UNDO"

    _as(monkeypatch, "token")
    assert (
        api_client.post(
            f"/api/imports/batches/{batch_id}/undo", json={"confirm": "UNDO"}
        ).status_code
        == 403
    )
    _as(monkeypatch, "session")
    bad = api_client.post(f"/api/imports/batches/{batch_id}/undo", json={"confirm": "undo"})
    assert bad.status_code == 422
    assert "confirm" in bad.json()["errors"]
    assert _count(api_client) == before + result["inserted"]

    ok = api_client.post(f"/api/imports/batches/{batch_id}/undo", json={"confirm": "UNDO"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["deleted"] == result["inserted"]
    assert ok.json()["batch"]["status"] == "undone"
    assert _count(api_client) == before
    again = api_client.post(f"/api/imports/batches/{batch_id}/undo", json={"confirm": "UNDO"})
    assert again.status_code == 409


def test_hand_edited_rows_survive_undo(
    api_client: TestClient, account_id: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    from investment_dashboard.repositories import import_batches_repo

    batch_id = _import(api_client, account_id)["import_batch_id"]
    with ledger_session_scope() as s:
        first = import_batches_repo.transactions_of(s, batch_id)[0]
        import_batches_repo.detach(s, [first.id])
    preview = api_client.get(f"/api/imports/batches/{batch_id}/undo-preview").json()
    assert preview["detached"] == 1
    _as(monkeypatch, "session")
    api_client.post(f"/api/imports/batches/{batch_id}/undo", json={"confirm": "UNDO"})
    assert _count(api_client) == 1


def test_unknown_action_mapping_and_reparse(api_client: TestClient, account_id: int) -> None:
    up = api_client.post(
        "/api/imports",
        files={"file": ("fid.csv", CSV + UNKNOWN, "text/csv")},
        data={"account_id": str(account_id)},
    ).json()
    unknown = api_client.get("/api/imports/unknown-actions").json()
    assert unknown["import_id"] == up["import_id"]
    assert unknown["actions"] == [{"action": "SOMETHING BRAND NEW", "count": 1}]
    assert "interest" in unknown["targets"]
    assert "ignore" in unknown["targets"]

    bad = api_client.put(
        "/api/imports/action-overrides/fidelity", json={"action": "x", "kind": "nonsense"}
    )
    assert bad.status_code == 422
    put = api_client.put(
        "/api/imports/action-overrides/fidelity",
        json={"action": "something brand new", "kind": "interest"},
    )
    assert put.status_code == 200, put.text
    assert put.json()["overrides"] == {"something brand new": "interest"}

    again = api_client.post(f"/api/imports/{up['import_id']}/reparse").json()
    assert again["unknown_actions"] == []
    assert again["counts"]["rows"] == up["counts"]["rows"] + 1

    removed = api_client.put(
        "/api/imports/action-overrides/fidelity",
        json={"action": "SOMETHING BRAND NEW", "kind": None},
    )
    assert removed.json()["overrides"] == {}


def test_parsers_take_overrides_as_parameters() -> None:
    text = (CSV + UNKNOWN).decode("utf-8-sig")
    assert parse_fidelity_csv(text).unknown_actions == ["SOMETHING BRAND NEW"]
    mapped = parse_fidelity_csv(text, {"Something  brand new": "interest"})
    assert not mapped.unknown_actions
    assert mapped.rows[-1].kind == "interest"
    ignored = parse_fidelity_csv(text, {"SOMETHING BRAND NEW": "ignore"})
    assert not ignored.unknown_actions
    assert len(ignored.rows) == len(mapped.rows) - 1
    assert map_transaction_type("Odd thing", {"odd thing": "fee"}) == "fee"
    assert map_transaction_type("Odd thing", {"ODD THING": "ignore"}) is None
