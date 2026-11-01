"""Regression tests for the v2.9.6 valuation fixes.

Covers:

* average-cost basis reduction on partial sales (growth was deflated because
  a sale dropped shares/value but left the full original cost basis);
* money-market / settlement funds priced at the constant $1.00 NAV;
* reinvested dividends not double-counted as both cash income and new shares;
* stock splits adding shares without disturbing the cost basis, and a later
  partial sale releasing the correct post-split average cost.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import accounts_repo, instruments_repo
from investment_dashboard.services import positions_service


def _usd_brokerage(session: Session) -> int:
    return accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="USD Brokerage",
        native_currency="USD",
        account_type="brokerage",
    ).id


def _instr(session: Session, symbol: str) -> int:
    return instruments_repo.get_or_create(session, symbol=symbol, native_currency="USD").id


def _position(
    positions: list[positions_service.Position], symbol: str
) -> positions_service.Position:
    return next(p for p in positions if p.instrument.symbol == symbol)


class TestPartialSaleCostBasis:
    def test_partial_sale_releases_proportional_cost_basis(self, session: Session) -> None:
        acct = _usd_brokerage(session)
        iid = _instr(session, "ACME")
        session.add_all(
            [
                Transaction(
                    account_id=acct,
                    instrument_id=iid,
                    date=date(2024, 1, 10),
                    kind="buy",
                    quantity=Decimal("10"),
                    price_native=Decimal("100"),
                    net_native=Decimal("-1000"),
                    source="manual",
                ),
                Transaction(
                    account_id=acct,
                    instrument_id=iid,
                    date=date(2024, 6, 10),
                    kind="sell",
                    quantity=Decimal("-5"),
                    price_native=Decimal("150"),
                    net_native=Decimal("750"),
                    source="manual",
                ),
            ]
        )
        session.flush()
        pos = _position(positions_service.compute_positions(session), "ACME")
        assert pos.shares == Decimal("5")
        # Half the shares sold ⇒ half the cost basis released (avg-cost).
        assert pos.cost_basis_native == Decimal("500")

    def test_full_sale_zeroes_cost_basis(self, session: Session) -> None:
        acct = _usd_brokerage(session)
        iid = _instr(session, "ACME")
        session.add_all(
            [
                Transaction(
                    account_id=acct,
                    instrument_id=iid,
                    date=date(2024, 1, 10),
                    kind="buy",
                    quantity=Decimal("10"),
                    price_native=Decimal("100"),
                    net_native=Decimal("-1000"),
                    source="manual",
                ),
                Transaction(
                    account_id=acct,
                    instrument_id=iid,
                    date=date(2024, 6, 10),
                    kind="sell",
                    quantity=Decimal("-10"),
                    price_native=Decimal("150"),
                    net_native=Decimal("1500"),
                    source="manual",
                ),
            ]
        )
        session.flush()
        # Sold out entirely ⇒ no residual position.
        assert not any(
            p.instrument.symbol == "ACME" for p in positions_service.compute_positions(session)
        )


class TestMoneyMarketPricing:
    def test_settlement_fund_priced_at_par(self, session: Session) -> None:
        acct = _usd_brokerage(session)
        iid = _instr(session, "VMFXX")
        session.add(
            Transaction(
                account_id=acct,
                instrument_id=iid,
                date=date(2024, 1, 10),
                kind="buy",
                quantity=Decimal("1000"),
                price_native=Decimal("1"),
                net_native=Decimal("-1000"),
                source="manual",
            )
        )
        session.flush()
        pos = _position(positions_service.compute_positions(session), "VMFXX")
        # No price feed exists, yet the holding values at $1.00/share.
        assert pos.current_price_native == Decimal("1")
        assert pos.current_value_native == Decimal("1000")


class TestReinvestedDividend:
    def test_reinvested_dividend_not_counted_as_cash(self, session: Session) -> None:
        acct = _usd_brokerage(session)
        iid = _instr(session, "ACME")
        d = date(2024, 3, 31)
        session.add_all(
            [
                Transaction(
                    account_id=acct,
                    instrument_id=iid,
                    date=date(2024, 1, 10),
                    kind="buy",
                    quantity=Decimal("10"),
                    price_native=Decimal("100"),
                    net_native=Decimal("-1000"),
                    source="manual",
                ),
                Transaction(
                    account_id=acct,
                    instrument_id=iid,
                    date=d,
                    kind="dividend_cash",
                    quantity=Decimal("0"),
                    net_native=Decimal("5"),
                    source="manual",
                ),
                Transaction(
                    account_id=acct,
                    instrument_id=iid,
                    date=d,
                    kind="dividend_reinvest",
                    quantity=Decimal("0.05"),
                    price_native=Decimal("100"),
                    net_native=Decimal("0"),
                    source="manual",
                ),
            ]
        )
        session.flush()
        pos = _position(positions_service.compute_positions(session), "ACME")
        # The reinvested dividend adds shares + cost basis; its cash leg must
        # NOT also count as income (that double-counts it in the gain).
        assert pos.cumulative_dividends_cash_native == Decimal("0")
        assert pos.shares == Decimal("10.05")
        assert pos.cost_basis_native == Decimal("1005")

    def test_plain_cash_dividend_still_counts(self, session: Session) -> None:
        acct = _usd_brokerage(session)
        iid = _instr(session, "ACME")
        session.add_all(
            [
                Transaction(
                    account_id=acct,
                    instrument_id=iid,
                    date=date(2024, 1, 10),
                    kind="buy",
                    quantity=Decimal("10"),
                    price_native=Decimal("100"),
                    net_native=Decimal("-1000"),
                    source="manual",
                ),
                Transaction(
                    account_id=acct,
                    instrument_id=iid,
                    date=date(2024, 3, 31),
                    kind="dividend_cash",
                    quantity=Decimal("0"),
                    net_native=Decimal("7"),
                    source="manual",
                ),
            ]
        )
        session.flush()
        pos = _position(positions_service.compute_positions(session), "ACME")
        assert pos.cumulative_dividends_cash_native == Decimal("7")


class TestStockSplit:
    def test_split_adds_shares_keeps_cost_then_sale_uses_post_split_cost(
        self, session: Session
    ) -> None:
        acct = _usd_brokerage(session)
        iid = _instr(session, "ACME")
        session.add_all(
            [
                Transaction(
                    account_id=acct,
                    instrument_id=iid,
                    date=date(2024, 1, 10),
                    kind="buy",
                    quantity=Decimal("10"),
                    price_native=Decimal("100"),
                    net_native=Decimal("-1000"),
                    source="manual",
                ),
                # 2-for-1 split: +10 shares, no cash, no cost change.
                Transaction(
                    account_id=acct,
                    instrument_id=iid,
                    date=date(2024, 4, 1),
                    kind="split",
                    quantity=Decimal("10"),
                    source="manual",
                ),
                # Sell 5 of the now-20 shares; avg cost is $50/share post-split.
                Transaction(
                    account_id=acct,
                    instrument_id=iid,
                    date=date(2024, 6, 1),
                    kind="sell",
                    quantity=Decimal("-5"),
                    price_native=Decimal("60"),
                    net_native=Decimal("300"),
                    source="manual",
                ),
            ]
        )
        session.flush()
        pos = _position(positions_service.compute_positions(session), "ACME")
        assert pos.shares == Decimal("15")
        # 1000 − (50 × 5) = 750.
        assert pos.cost_basis_native == Decimal("750")
