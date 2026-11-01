"""``/api/imports``: upload -> preview (no writes) -> confirm / discard."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.adapters.frankfurter_client import FrankfurterError
from investment_dashboard.db import ledger_session_scope
from investment_dashboard.repositories import accounts_repo, fx_repo
from investment_dashboard.services import (
    fx_service,
    import_staging,
    instrument_enrichment_service,
)

FIXTURES = Path(__file__).parents[1] / "adapters" / "fixtures"


@pytest.fixture(autouse=True)
def _offline() -> Iterator[None]:
    import_staging.clear()
    with (
        patch.object(fx_service, "fetch_rates", side_effect=FrankfurterError("offline")),
        patch.object(instrument_enrichment_service, "fetch_instrument_info", return_value=None),
    ):
        yield
    import_staging.clear()


@pytest.fixture
def account_id(api_db: object) -> int:
    with ledger_session_scope() as s:
        acct = accounts_repo.create_account(
            s,
            broker="fidelity",
            account_label="Fidelity",
            native_currency="USD",
            account_type="brokerage",
        )
        fx_repo.upsert_rates(
            s,
            {
                date(2024, 1, 5): Decimal("1.08"),
                date(2024, 2, 15): Decimal("1.07"),
                date(2024, 3, 1): Decimal("1.085"),
                date(2024, 3, 15): Decimal("1.09"),
                date(2024, 4, 1): Decimal("1.08"),
            },
        )
        return acct.id


def _upload(client: TestClient, name: str = "fidelity_sample.csv", **form: object) -> object:
    data = (FIXTURES / name).read_bytes()
    return client.post(
        "/api/imports",
        files={"file": (name, data, "text/csv")},
        data={k: str(v) for k, v in form.items()},
    )


def _count(client: TestClient) -> int:
    return client.get("/api/transactions", params={"hide_sweeps": "false"}).json()["total"]


def test_preview_writes_nothing_then_confirm_inserts(
    api_client: TestClient, account_id: int
) -> None:
    resp = _upload(api_client, account_id=account_id)
    assert resp.status_code == 201, resp.text
    preview = resp.json()
    assert preview["broker"] == "fidelity"  # taken from the account, not special-cased
    assert preview["counts"]["rows"] == 6
    assert preview["counts"]["new"] == 6
    assert preview["counts"]["duplicates"] == 0
    assert len(preview["rows"]) == 6
    assert all(not r["is_duplicate"] for r in preview["rows"])
    assert _count(api_client) == 0  # nothing written by the preview

    done = api_client.post(f"/api/imports/{preview['import_id']}/confirm")
    assert done.status_code == 200, done.text
    assert done.json()["inserted"] == 6
    assert _count(api_client) == 6
    # The staged upload is consumed.
    assert api_client.post(f"/api/imports/{preview['import_id']}/confirm").status_code == 404

    again = _upload(api_client, account_id=account_id).json()
    assert again["counts"]["duplicates"] == 6
    assert again["counts"]["new"] == 0
    assert api_client.post(f"/api/imports/{again['import_id']}/confirm").json()["inserted"] == 0
    assert _count(api_client) == 6


def test_broker_hint_finds_the_only_account(api_client: TestClient, account_id: int) -> None:
    resp = _upload(api_client, broker="fidelity")
    assert resp.status_code == 201
    assert resp.json()["account_id"] == account_id


def test_discard(api_client: TestClient, account_id: int) -> None:
    import_id = _upload(api_client, account_id=account_id).json()["import_id"]
    assert api_client.delete(f"/api/imports/{import_id}").status_code == 200
    assert api_client.delete(f"/api/imports/{import_id}").status_code == 404
    assert api_client.post(f"/api/imports/{import_id}/confirm").status_code == 404
    assert _count(api_client) == 0


def test_bad_uploads_are_rejected(api_client: TestClient, account_id: int) -> None:
    no_account = _upload(api_client)
    assert no_account.status_code == 422
    wrong_ext = api_client.post(
        "/api/imports", files={"file": ("x.txt", b"abc", "text/plain")}, data={"account_id": "1"}
    )
    assert wrong_ext.status_code == 422
    empty = api_client.post(
        "/api/imports", files={"file": ("x.csv", b"", "text/csv")}, data={"account_id": "1"}
    )
    assert empty.status_code == 422
    unknown = _upload(api_client, account_id=999)
    assert unknown.status_code == 422
    junk = api_client.post(
        "/api/imports",
        files={"file": ("x.csv", b"not,a,broker,export\n1,2,3,4\n", "text/csv")},
        data={"account_id": str(account_id)},
    )
    assert junk.status_code in (201, 422)


def test_oversize_upload_is_413(
    api_client: TestClient, account_id: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(import_staging, "MAX_UPLOAD_BYTES", 10)
    resp = api_client.post(
        "/api/imports",
        files={"file": ("x.csv", b"a" * 50, "text/csv")},
        data={"account_id": str(account_id)},
    )
    assert resp.status_code == 413


def test_vanguard_preview_includes_settlement_legs(api_client: TestClient) -> None:
    with ledger_session_scope() as s:
        acct = accounts_repo.create_account(
            s,
            broker="vanguard",
            account_label="Vanguard",
            native_currency="USD",
            account_type="brokerage",
        )
        acct_id = acct.id
    resp = _upload(api_client, "vanguard_sample.csv", account_id=acct_id)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["broker"] == "vanguard"
    assert body["counts"]["sweeps_dropped"] >= 1
    assert any(r["symbol"] == "VMFXX" for r in body["rows"])


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.post("/api/imports").status_code == 401
