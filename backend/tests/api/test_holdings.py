"""Tests for ``GET /api/holdings``."""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope

from ._seed import RATE_NOW, seed_ledger


@pytest.fixture
def seeded(api_db: object) -> Iterator[None]:
    with ledger_session_scope() as session:
        seed_ledger(session)
    return


def _by_symbol(body: dict) -> dict[str, dict]:  # type: ignore[type-arg]
    return {h["symbol"]: h for h in body["holdings"]}


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/holdings").status_code == 401


def test_rows_are_per_instrument_not_per_account(api_client: TestClient, seeded: None) -> None:
    body = api_client.get("/api/holdings?ccy=USD").json()
    rows = _by_symbol(body)
    assert set(rows) == {"VTI", "BND"}  # VTI sits in two accounts: one row
    vti = rows["VTI"]
    assert Decimal(vti["shares"]) == 15
    assert Decimal(vti["value"]) == 3750  # not double counted
    assert Decimal(vti["cost_basis"]) == 3050  # 2000 + 1050
    assert Decimal(vti["capital_gain"]) == 700
    assert Decimal(vti["price_native"]) == 250
    assert vti["native_currency"] == "USD"
    assert vti["category"] == "US Stocks"
    assert Decimal(rows["BND"]["value"]) == 1400
    assert Decimal(body["total_value"]) == 5150
    assert Decimal(vti["weight_pct"]) == pytest.approx(Decimal(3750) / 5150)
    weights = sum(Decimal(r["weight_pct"]) for r in rows.values())
    assert weights == pytest.approx(Decimal(1))


def test_ccy_switch(api_client: TestClient, seeded: None) -> None:
    eur = api_client.get("/api/holdings?ccy=EUR").json()
    usd = api_client.get("/api/holdings?ccy=USD").json()
    assert eur["ccy"] == "EUR"
    assert usd["ccy"] == "USD"
    # A value at one instant converts at that instant's rate...
    assert Decimal(_by_symbol(eur)["VTI"]["value"]) == pytest.approx(
        Decimal(3750) / RATE_NOW, rel=Decimal("1e-9")
    )
    # ...a return is computed independently per currency, never converted.
    assert _by_symbol(eur)["VTI"]["total_growth"] != _by_symbol(usd)["VTI"]["total_growth"]
    # Native price is never converted.
    assert _by_symbol(eur)["VTI"]["price_native"] == _by_symbol(usd)["VTI"]["price_native"]
    # Weight is a same-instant ratio: currency independent.
    assert Decimal(_by_symbol(eur)["VTI"]["weight_pct"]) == pytest.approx(
        Decimal(_by_symbol(usd)["VTI"]["weight_pct"]), rel=Decimal("1e-9")
    )


def test_summary(api_client: TestClient, seeded: None) -> None:
    summary = api_client.get("/api/holdings?ccy=USD").json()["summary"]
    assert summary["most_concentrated_symbol"] == "VTI"
    assert summary["best_symbol"] == "VTI"
    assert summary["worst_symbol"] == "BND"


def test_bad_ccy_is_422(api_client: TestClient) -> None:
    assert api_client.get("/api/holdings?ccy=XXX").status_code == 422


def test_empty_ledger(api_client: TestClient, api_db: object) -> None:
    body = api_client.get("/api/holdings").json()
    assert body["holdings"] == []


@pytest.mark.parametrize("ccy", ["EUR", "USD"])
def test_holdings_and_overview_agree(api_client: TestClient, seeded: None, ccy: str) -> None:
    """Same ledger, same definitions: the two screens reconcile exactly."""
    hold = api_client.get(f"/api/holdings?ccy={ccy}").json()
    over = api_client.get(f"/api/overview?ccy={ccy}").json()["kpis"]
    approx = pytest.approx
    tol = Decimal("0.01")
    assert Decimal(hold["total_value"]) == approx(Decimal(over["total_value"]), abs=tol)
    # capital gain = value - cost basis; total return = capital gain + dividends.
    assert Decimal(hold["total_capital_gain"]) == approx(
        Decimal(hold["total_value"]) - Decimal(hold["total_cost_basis"]), abs=tol
    )
    assert Decimal(hold["total_return"]) == approx(
        Decimal(hold["total_capital_gain"]) + Decimal(hold["total_dividends"]), abs=tol
    )
    assert Decimal(over["total_return"]) == approx(
        Decimal(over["capital_gain"]) + Decimal(over["dividend_income"]), abs=tol
    )
    # Overview measures against all net contributions; holdings against position
    # cost bases. The gap is exactly the contributed cash not held in positions
    # (fixture: 5050 deposited, 4550 invested, no sales or dividends).
    uninvested = Decimal(over["total_invested"]) - Decimal(hold["total_cost_basis"])
    assert Decimal(over["capital_gain"]) == approx(
        Decimal(hold["total_capital_gain"]) - uninvested, abs=tol
    )
    # Per-row consistency and today/total split.
    for row in hold["holdings"]:
        assert Decimal(row["capital_gain"]) == approx(
            Decimal(row["value"]) - Decimal(row["cost_basis"]), abs=tol
        )
    summary = hold["summary"]
    assert summary["in_profit"] + summary["in_loss"] <= len(hold["holdings"])
    best = max(hold["holdings"], key=lambda r: Decimal(r["total_growth"]))
    assert summary["best_symbol"] == best["symbol"]
    assert Decimal(summary["best_growth"]) == Decimal(best["total_growth"])


def test_history_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/holdings/1/history").status_code == 401


def test_history_shape_and_ranges(api_client: TestClient, seeded: None) -> None:
    iid = _by_symbol(api_client.get("/api/holdings?ccy=USD").json())["VTI"]["instrument_id"]
    body = api_client.get(f"/api/holdings/{iid}/history?range=all").json()
    assert body["symbol"] == "VTI"
    assert body["ccy"] == "USD"  # native currency, never converted
    assert body["range"] == "all"
    dates = [p["t"] for p in body["points"]]
    assert dates == sorted(dates)
    assert Decimal(body["points"][0]["v"]) == 200  # the first-day close
    assert Decimal(body["points"][-1]["v"]) == 250
    short = api_client.get(f"/api/holdings/{iid}/history?range=1m").json()
    assert 0 < len(short["points"]) <= len(body["points"])
    assert Decimal(short["points"][-1]["v"]) == 250


def test_history_unknown_instrument_and_bad_range(api_client: TestClient, seeded: None) -> None:
    assert api_client.get("/api/holdings/99999/history").status_code == 404
    iid = _by_symbol(api_client.get("/api/holdings?ccy=USD").json())["VTI"]["instrument_id"]
    assert api_client.get(f"/api/holdings/{iid}/history?range=5y").status_code == 422
