"""Overview and Holdings tell one story: capital gain + income = total return.

Golden ledger (USD account, one ETF): deposit 2000 at 1.10, buy 20 @ 100, sell 5 @ 120
and withdraw the 600 proceeds at 1.15, a 30 cash dividend at 1.15, close 150 at 1.20.

USD: value 15 x 150 = 2250; net invested 2000 - 600 = 1400; total return
2250 + 30 - 1400 = 880; capital gain 850 = unrealised 15 x 50 = 750 + realised
5 x 20 = 100. EUR is built from the EUR legs (each flow at its own date's rate),
never from the USD result.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import holdings
from investment_dashboard.readmodels import overview as overview_rm
from investment_dashboard.repositories import accounts_repo, fx_repo, instruments_repo, prices_repo
from investment_dashboard.services.metrics_service import compute_portfolio_metrics

D = Decimal
RATES = {date(2025, 1, 1): D("1.10"), date(2025, 3, 3): D("1.15")}
NOW_RATE = D("1.20")


def _seed(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    abc = instruments_repo.get_or_create(session, symbol="ABC", asset_class="etf")
    today = exchange_today()
    closes = {date(2025, 1, 2): D("100")} | {today - timedelta(days=k): D("150") for k in range(7)}
    prices_repo.upsert_closes(session, abc.id, closes)
    fx_repo.upsert_rates(session, RATES | {today: NOW_RATE})

    def txn(day: date, kind: str, usd: str, rate: str, **extra: object) -> Transaction:
        amount = D(usd)
        return Transaction(
            account_id=acct.id,
            date=day,
            kind=kind,
            source=TransactionSource.MANUAL,
            net_native=amount,
            net_usd=amount,
            net_eur=(amount / D(rate)).quantize(D("0.01")),
            fx_rate_to_eur=D(rate),
            **extra,
        )

    session.add_all(
        [
            txn(date(2025, 1, 2), "deposit", "2000", "1.10"),
            txn(
                date(2025, 1, 5),
                "buy",
                "-2000",
                "1.10",
                instrument_id=abc.id,
                quantity=D("20"),
                price_native=D("100"),
            ),
            txn(
                date(2025, 3, 3),
                "sell",
                "600",
                "1.15",
                instrument_id=abc.id,
                quantity=D("-5"),
                price_native=D("120"),
            ),
            txn(date(2025, 3, 3), "withdrawal", "-600", "1.15"),
            txn(date(2025, 4, 1), "dividend_cash", "30", "1.15", instrument_id=abc.id),
        ]
    )
    session.flush()


def test_usd_golden_values_and_identity(session: Session) -> None:
    _seed(session)
    kpis = overview_rm._kpis(compute_portfolio_metrics(session), "USD", fx_rate=NOW_RATE)
    page = holdings.build(session, ccy="USD")

    assert D(kpis["total_return"]) == D("880")
    assert D(kpis["capital_gain"]) == D("850")
    assert D(kpis["dividend_income"]) == D("30")
    # Same names, same numbers on both pages.
    assert D(page["total_return"]) == D(kpis["total_return"])
    assert D(page["total_capital_gain"]) == D(kpis["capital_gain"])
    # The listed holding: unrealised only, plus its own dividends.
    row = page["holdings"][0]
    assert D(row["capital_gain"]) == D("750")
    assert D(row["dividends"]) == D("30")
    assert D(row["total_return"]) == D("780")
    assert D(page["total_unrealised_gain"]) == D("750")
    assert D(page["total_realised_other"]) == D("100")
    # The identities.
    assert D(page["total_capital_gain"]) + D(kpis["dividend_income"]) == D(page["total_return"])
    assert D(page["total_unrealised_gain"]) + D(page["total_realised_other"]) == D(
        page["total_capital_gain"]
    )


def test_eur_is_built_from_eur_legs_and_identity_holds(session: Session) -> None:
    _seed(session)
    kpis = overview_rm._kpis(compute_portfolio_metrics(session), "EUR", fx_rate=NOW_RATE)
    page = holdings.build(session, ccy="EUR")

    invested = D(2000) / D("1.10") - D(600) / D("1.15")
    income = D(30) / D("1.15")
    total_return = D(2250) / NOW_RATE + income - invested
    tol = pytest.approx
    assert D(kpis["total_return"]) == tol(total_return, abs=D("0.02"))
    assert D(kpis["capital_gain"]) == tol(total_return - income, abs=D("0.02"))
    # Not the USD result converted at today's rate.
    assert D(kpis["capital_gain"]) != tol(D(850) / NOW_RATE, abs=D("1"))

    unrealised = D(2250) / NOW_RATE - D(2000) / D("1.10") * D("0.75")
    assert D(page["total_unrealised_gain"]) == tol(unrealised, abs=D("0.02"))
    assert D(page["total_return"]) == D(kpis["total_return"])
    assert D(page["total_capital_gain"]) == D(kpis["capital_gain"])
    assert D(page["total_capital_gain"]) + D(kpis["dividend_income"]) == tol(
        D(page["total_return"]), abs=D("0.02")
    )
    assert D(page["total_unrealised_gain"]) + D(page["total_realised_other"]) == tol(
        D(page["total_capital_gain"]), abs=D("0.02")
    )
