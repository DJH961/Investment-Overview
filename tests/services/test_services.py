"""Tests for the services layer (positions, metrics)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instruments_repo,
    prices_repo,
)
from investment_dashboard.services import metrics_service, positions_service


def _seed_eur_account(session: Session, label: str = "Savings") -> int:
    a = accounts_repo.create_account(
        session,
        broker="savings_bank",
        account_label=label,
        native_currency="EUR",
        account_type="savings",
    )
    return a.id


def _seed_usd_brokerage(session: Session) -> int:
    a = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    return a.id


class TestPositions:
    def test_empty_portfolio_has_no_positions(self, session: Session) -> None:
        assert positions_service.compute_positions(session) == []
        assert positions_service.total_portfolio_value(session) == Decimal(0)

    def test_buy_then_value(self, session: Session) -> None:
        acct_id = _seed_usd_brokerage(session)
        instr = instruments_repo.get_or_create(session, symbol="VTI", native_currency="USD")
        session.add(
            Transaction(
                account_id=acct_id,
                instrument_id=instr.id,
                date=date(2024, 1, 5),
                kind="buy",
                quantity=Decimal("10"),
                price_native=Decimal("220.00"),
                net_native=Decimal("-2200.00"),
                net_eur=Decimal("-2000.00"),
                source="manual",
            )
        )
        prices_repo.upsert_closes(session, instr.id, {date(2024, 2, 1): Decimal("250.00")})
        fx_repo.upsert_rates(session, {date(2024, 2, 1): Decimal("1.10")})
        session.flush()

        positions = positions_service.compute_positions(session, as_of=date(2024, 2, 1))
        assert len(positions) == 1
        p = positions[0]
        assert p.shares == Decimal("10")
        assert p.current_price_native == Decimal("250.000000")
        assert p.current_value_native == Decimal("2500.000000")
        # 2500 USD at 1.10 EUR/USD ⇒ 2272.727… EUR
        assert abs(p.current_value_eur - Decimal("2272.72")) < Decimal("0.5")

    def test_savings_cash_balance(self, session: Session) -> None:
        acct_id = _seed_eur_account(session)
        for kind, amt in [("deposit", "1000"), ("interest", "5"), ("withdrawal", "-100")]:
            session.add(
                Transaction(
                    account_id=acct_id,
                    date=date(2024, 1, 1),
                    kind=kind,
                    net_native=Decimal(amt),
                    net_eur=Decimal(amt),
                    source="manual",
                )
            )
        session.flush()
        # 1000 + 5 - 100 = 905
        assert positions_service.compute_cash_balance(session, acct_id) == Decimal("905")
        # Aggregated into total portfolio EUR.
        assert positions_service.total_portfolio_value(session) == Decimal("905")


class TestMetrics:
    def test_metrics_on_empty_portfolio(self, session: Session) -> None:
        m = metrics_service.compute_portfolio_metrics(session)
        assert m.total_value_eur == Decimal(0)
        assert m.xirr is None  # no cashflows
        assert m.total_growth_pct is None

    def test_metrics_with_deposit_and_growth(self, session: Session) -> None:
        # Simple EUR account: deposit 1000 a year ago, current value 1100.
        acct_id = _seed_eur_account(session, "Direct Savings")
        session.add(
            Transaction(
                account_id=acct_id,
                date=date(2023, 1, 1),
                kind="deposit",
                net_native=Decimal("1000"),
                net_eur=Decimal("1000"),
                source="manual",
            )
        )
        # Use an interest credit to simulate the growth so positions reflect 1100.
        session.add(
            Transaction(
                account_id=acct_id,
                date=date(2023, 12, 31),
                kind="interest",
                net_native=Decimal("100"),
                net_eur=Decimal("100"),
                source="manual",
            )
        )
        session.flush()
        m = metrics_service.compute_portfolio_metrics(session, as_of=date(2024, 1, 1))
        assert m.total_value_eur == Decimal("1100")
        # Net contributions = 1000 (deposit). XIRR ≈ 10%.
        assert m.xirr is not None
        assert abs(m.xirr - Decimal("0.10")) < Decimal("0.001")

    def test_cashflows_include_unretained_dividends_and_interest(self, session: Session) -> None:
        acct_id = _seed_usd_brokerage(session)
        txns = [
            Transaction(
                account_id=acct_id,
                date=date(2024, 1, 1),
                kind="deposit",
                net_native=Decimal("1000"),
                net_eur=Decimal("900"),
                source="manual",
            ),
            Transaction(
                account_id=acct_id,
                date=date(2024, 2, 1),
                kind="dividend_cash",
                net_native=Decimal("50"),
                net_eur=Decimal("45"),
                source="manual",
            ),
            Transaction(
                account_id=acct_id,
                date=date(2024, 3, 1),
                kind="interest",
                net_native=Decimal("5"),
                net_eur=Decimal("4.50"),
                source="manual",
            ),
        ]
        session.add_all(txns)
        session.flush()

        cashflows = metrics_service.build_portfolio_cashflows(txns)

        assert [(cf.date, cf.amount) for cf in cashflows] == [
            (date(2024, 1, 1), Decimal("-900")),
            (date(2024, 2, 1), Decimal("45")),
            (date(2024, 3, 1), Decimal("4.50")),
        ]
