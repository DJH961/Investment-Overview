"""7.4 lane C: the journey fields on the Transactions, Deposits, Holdings and peek payloads.

Without the cash pool service every field is null (or 0) and nothing breaks; with a
synthetic G1 pool (``tests/readmodels/journey_g1.py``) the fields carry its figures.
Synthetic seeded ledger only.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.readmodels import currency_journey, journey_fields
from investment_dashboard.readmodels.queries import ledger_query
from investment_dashboard.services import diagnostics_service

from .test_currency_dollar import _get, seeded  # noqa: F401

D = Decimal


@pytest.fixture
def g1_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    from readmodels import journey_g1 as g1  # tests/readmodels (rootdir on sys.path)

    monkeypatch.setattr(currency_journey, "load_inputs", lambda *_a, **_k: g1.inputs())


def test_payloads_without_a_pool(
    api_client: TestClient,
    seeded: None,  # noqa: F811
) -> None:
    holdings = _get(api_client, "/api/holdings/both")
    for ccy in ("EUR", "USD"):
        assert holdings[ccy]["fx_your_rate"] is None
        for row in holdings[ccy]["holdings"]:
            assert row["your_rate"] is None
            assert row["fx_effect_pp"] is None
    peeks = _get(api_client, "/api/holdings/peeks")["peeks"]
    assert all(p["your_rate"] is None for p in peeks.values())
    deposits = _get(api_client, "/api/deposits/both")
    assert deposits["EUR"]["cashed_out_eur"] == "0"
    page = _get(api_client, "/api/transactions")
    assert all(r.get("eur_basis") is None for r in page["rows"])
    diag = _get(api_client, "/api/diagnostics")
    ids = {c["id"]: c for c in diag["checks"]}
    for key in (
        "idle_dollars",
        "uncovered_buys",
        "negative_broker_cash",
        "withdrawals_not_converted",
        "conversion_back_uncovered",
    ):
        assert key in ids, key
    assert ids["idle_dollars"]["severity"] == "ok"


def test_payloads_with_the_g1_pool(
    api_client: TestClient,
    seeded: None,  # noqa: F811
    g1_pool: None,
) -> None:
    holdings = _get(api_client, "/api/holdings/both")
    for ccy in ("EUR", "USD"):
        assert holdings[ccy]["fx_your_rate"] == "1.1400"
        rows = holdings[ccy]["holdings"]
        assert rows
        assert all("ecb_buy_avg" in r for r in rows)
    peeks = _get(api_client, "/api/holdings/peeks")["peeks"]
    assert all("your_rate" in p for p in peeks.values())
    deposits = _get(api_client, "/api/deposits/both")
    assert D(deposits["EUR"]["cashed_out_eur"]) == D(198)
    assert D(deposits["USD"]["cashed_out_eur"]) == D(198)
    diag = _get(api_client, "/api/diagnostics")
    ids = {c["id"]: c for c in diag["checks"]}
    assert ids["idle_dollars"]["severity"] == "warning"
    assert ids["idle_dollars"]["actions"][0]["href"] == "/conversions"
    assert ids["withdrawals_not_converted"]["severity"] == "ok"


def test_ledger_record_hook(g1_pool: None) -> None:
    from readmodels import journey_g1 as g1

    inputs = g1.inputs()
    rec = ledger_query.LedgerRecord(
        id=202,
        date=date(2026, 2, 10),
        account_label="A",
        kind="buy",
        symbol="YYY",
        native_currency="USD",
        quantity=D(20),
        price_native=D(50),
        fees_native=None,
        gross_native=None,
        net_native=D(-1000),
        net_eur=None,
        net_usd=None,
        source=None,
        account_id=g1.ACC,
    )
    out = ledger_query._with_journey(rec, inputs)
    assert (out.eur_basis, out.trail_kind) == ("pool", "buy")
    assert ledger_query._with_journey(rec, None) is rec
    assert journey_fields.record_fields(
        None, txn_id=1, on=rec.date, kind="buy", account_id=1, ccy="USD"
    ) == {
        "eur_basis": None,
        "trail_kind": None,
    }


def test_check_health_registers_the_journey_checks() -> None:
    names = {c.__name__ for c in diagnostics_service.JOURNEY_CHECKS}
    assert names == {
        "check_idle_dollars",
        "check_uncovered_buys",
        "check_negative_broker_cash",
        "check_withdrawals_not_converted",
        "check_conversion_back_uncovered",
    }
