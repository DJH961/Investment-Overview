"""7.1: ``/api/deposits/dividends/both`` per-holding ``by_year``, ``last_12m``, ``yield_ttm``.

Golden, on the shared seed ledger (VTI 15 sh x $250 = $3,750 today; EUR->USD 1.10
until today, 1.20 today). VTI pays $20 in cash on 3 Feb 2025 and $37.50 thirty days
ago, both at 1.10:

* USD: by year 37.50 (this year) and 20 (2025); last 12 months 37.50; yield
  37.50 / 3,750 = 1 %.
* EUR: each payment at its own date's rate: 37.50 / 1.10 = 34.09 and
  20 / 1.10 = 18.18; the value at today's rate is 3,750 / 1.20 = 3,125, so the
  yield is 34.09 / 3,125 = 1.0909 % (the EUR yield differs because the rate moved
  between the payment and today; nothing is converted after the fact).
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.models import Transaction
from investment_dashboard.repositories import accounts_repo

from ._seed import RATE_NOW, RATE_THEN, seed_ledger

D = Decimal
OLD = date(2025, 2, 3)


@pytest.fixture
def recent(api_db: object) -> date:
    day = exchange_today() - timedelta(days=30)
    with ledger_session_scope() as session:
        ids = seed_ledger(session)
        main = next(
            a for a in accounts_repo.list_accounts(session) if a.account_label == "Brokerage"
        )
        for when, amount in ((OLD, "20"), (day, "37.50")):
            session.add(
                Transaction(
                    account_id=main.id,
                    date=when,
                    kind="dividend_cash",
                    instrument_id=ids["VTI"],
                    net_native=D(amount),
                    source="manual",
                )
            )
    return day


def _vti(body: dict) -> dict:  # type: ignore[type-arg]
    return next(h for h in body["by_holding"] if h["symbol"] == "VTI")


def test_usd_by_year_last_12m_and_yield(api_client: TestClient, recent: date) -> None:
    vti = _vti(api_client.get("/api/deposits/dividends/both").json()["USD"])
    years = {y["year"]: D(y["amount"]) for y in vti["by_year"]}
    expected = {OLD.year: D(20)}
    expected[recent.year] = expected.get(recent.year, D(0)) + D("37.50")
    assert years == expected
    assert [y["year"] for y in vti["by_year"]] == sorted(expected, reverse=True)
    assert D(vti["last_12m"]) == D("37.50")
    assert D(vti["yield_ttm"]) == D("0.01")


def test_eur_uses_each_payment_date_rate(api_client: TestClient, recent: date) -> None:
    vti = _vti(api_client.get("/api/deposits/dividends/both").json()["EUR"])
    assert D(vti["last_12m"]) == pytest.approx(D("37.50") / RATE_THEN, abs=D("1e-9"))
    total = sum((D(y["amount"]) for y in vti["by_year"]), D(0))
    assert total == pytest.approx(D("57.50") / RATE_THEN, abs=D("1e-9"))
    value_eur = D(3750) / RATE_NOW
    assert D(vti["yield_ttm"]) == pytest.approx(D("37.50") / RATE_THEN / value_eur, abs=D("1e-9"))
