"""Tests for ``GET /api/overview``."""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope

from ._seed import RATE_NOW, seed_ledger

USD_VALUE = Decimal("5150")  # VTI 15 x 250 + BND 20 x 70


@pytest.fixture
def seeded(api_db: object) -> Iterator[None]:
    with ledger_session_scope() as session:
        seed_ledger(session)
    return


def D(value: str | None) -> Decimal:
    assert value is not None
    return Decimal(value)


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/overview").status_code == 401


def test_shape_and_eur_numbers(api_client: TestClient, seeded: None) -> None:
    body = api_client.get("/api/overview").json()
    assert body["ccy"] == "EUR"
    assert body["position_count"] == 2  # VTI is held in two accounts: one row
    assert set(body["kpis"]) >= {
        "total_value",
        "total_invested",
        "capital_gain",
        "xirr",
        "total_growth_compounded",
        "ytd_growth",
        "mtd_growth",
        "daily_growth_pct",
        "dividend_yield_ttm_pct",
    }
    # Valuation at the valuation moment's rate: USD value / today's EUR->USD.
    assert D(body["kpis"]["total_value"]) == pytest.approx(
        USD_VALUE / RATE_NOW, rel=Decimal("1e-9")
    )
    assert D(body["fx_eur_usd"]) == RATE_NOW
    assert body["warnings"] == {"zero_value": [], "bad_history": [], "missing_fx": []}
    assert body["movers"]["eligible_count"] >= 0
    assert body["market_verdict"]["benchmark_symbol"]


def test_usd_switch_selects_usd_legs(api_client: TestClient, seeded: None) -> None:
    eur = api_client.get("/api/overview?ccy=EUR").json()
    usd = api_client.get("/api/overview?ccy=USD").json()
    assert usd["ccy"] == "USD"
    assert D(usd["kpis"]["total_value"]) == USD_VALUE
    assert D(usd["kpis"]["total_invested"]) == Decimal("5050")  # frozen net_usd legs
    assert D(usd["kpis"]["capital_gain"]) == Decimal("100")
    # Returns are computed per currency, never converted: they differ.
    assert usd["kpis"]["xirr"] != eur["kpis"]["xirr"]
    assert usd["kpis"]["total_growth_compounded"] != eur["kpis"]["total_growth_compounded"]
    # The verdict is computed in the reporting currency (USD benchmark XIRR).
    assert usd["market_verdict"]["portfolio_return"] is not None
    assert usd["market_verdict"]["portfolio_return"] == usd["kpis"]["total_growth_compounded"]


def test_currency_effect_split(api_client: TestClient, seeded: None) -> None:
    body = api_client.get("/api/overview").json()
    split = body["currency"]["return_split"]
    total_eur = D(split["total_return_eur"])
    investment = D(split["investment_return"])
    effect = D(split["currency_effect_pp"])
    assert effect == total_eur - investment
    # EUR strengthened 1.10 -> 1.20 vs a USD-booked book: a headwind for a EUR investor.
    assert effect < 0
    life = body["currency"]["lifetime"]
    assert D(life["current_rate"]) == pytest.approx(RATE_NOW, rel=Decimal("1e-9"))
    assert D(life["avg_invest_rate"]) < D(life["current_rate"])
    assert set(body["currency"]["today"]["regime"]) >= {"market_open", "forex_frozen"}


def test_bad_ccy_is_422(api_client: TestClient) -> None:
    assert api_client.get("/api/overview?ccy=GBP").status_code == 422


def test_empty_ledger_still_answers(api_client: TestClient, api_db: object) -> None:
    r = api_client.get("/api/overview")
    assert r.status_code == 200
    assert r.json()["position_count"] == 0


def test_rate_move_is_a_fraction(api_client: TestClient, seeded: None) -> None:
    today = api_client.get("/api/overview").json()["currency"]["today"]
    if today["spot"] is None or today["prev"] is None:
        return
    expected = (D(today["spot"]) - D(today["prev"])) / D(today["prev"])
    assert D(today["rate_move_pct"]) == pytest.approx(expected, abs=D("1e-12"))
    assert abs(D(today["rate_move_pct"])) < D("0.2")  # a fraction, not percent
