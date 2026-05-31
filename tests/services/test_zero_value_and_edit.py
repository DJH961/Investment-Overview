"""Regression tests for the zero-value warning, price invalidation on a
ticker change, and preset metadata repair on re-seed."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    instruments_repo,
    prices_repo,
)
from investment_dashboard.services import onboarding_service, positions_service, prices_service


def _usd_brokerage(session: Session) -> int:
    return accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="USD Brokerage",
        native_currency="USD",
        account_type="brokerage",
    ).id


def _buy(session: Session, acct: int, iid: int, qty: str, price: str) -> None:
    session.add(
        Transaction(
            account_id=acct,
            instrument_id=iid,
            date=date(2024, 1, 10),
            kind="buy",
            quantity=Decimal(qty),
            price_native=Decimal(price),
            net_native=-Decimal(qty) * Decimal(price),
            source="manual",
        )
    )
    session.flush()


def _position(
    positions: list[positions_service.Position], symbol: str
) -> positions_service.Position:
    return next(p for p in positions if p.instrument.symbol == symbol)


class TestZeroValueWarning:
    def test_held_position_without_price_is_flagged(self, session: Session) -> None:
        acct = _usd_brokerage(session)
        iid = instruments_repo.get_or_create(session, symbol="DAX", asset_class="etf").id
        _buy(session, acct, iid, "10", "30")
        # No price was ever fetched for DAX.
        pos = _position(positions_service.compute_positions(session), "DAX")
        assert pos.current_value_native == Decimal("0")
        assert pos.value_warning is True

    def test_priced_position_is_not_flagged(self, session: Session) -> None:
        acct = _usd_brokerage(session)
        iid = instruments_repo.get_or_create(session, symbol="DAX", asset_class="etf").id
        _buy(session, acct, iid, "10", "30")
        prices_repo.upsert_closes(session, iid, {date.today(): Decimal("46.00")})
        pos = _position(positions_service.compute_positions(session), "DAX")
        assert pos.current_value_native == Decimal("460")
        assert pos.value_warning is False

    def test_money_market_fund_is_not_flagged(self, session: Session) -> None:
        acct = _usd_brokerage(session)
        iid = instruments_repo.get_or_create(session, symbol="VMFXX").id
        _buy(session, acct, iid, "1000", "1")
        # Money-market funds value at par even without a price feed.
        pos = _position(positions_service.compute_positions(session), "VMFXX")
        assert pos.current_value_native == Decimal("1000")
        assert pos.value_warning is False


class TestPriceInvalidation:
    def test_invalidate_removes_cached_closes(self, session: Session) -> None:
        iid = instruments_repo.get_or_create(session, symbol="DAX", asset_class="etf").id
        prices_repo.upsert_closes(session, iid, {date.today(): Decimal("46.00")})
        assert prices_service.latest_close(session, iid) == Decimal("46.00")
        removed = prices_service.invalidate_instrument_prices(session, iid)
        assert removed == 1
        assert prices_service.latest_close(session, iid) is None


class TestPresetMetadataRepair:
    def test_reseed_repairs_placeholder_metadata(self, session: Session) -> None:
        # Simulate a DAX line created by the importer with stub metadata.
        instruments_repo.get_or_create(session, symbol="DAX", asset_class="unknown")
        onboarding_service.seed_default_setup(session)
        repaired = instruments_repo.get_by_symbol(session, "DAX")
        assert repaired is not None
        assert repaired.asset_class == "etf"
        assert repaired.name == "Global X DAX Germany ETF"
        assert repaired.expense_ratio == Decimal("0.0020")

    def test_reseed_keeps_user_customisations(self, session: Session) -> None:
        instr = instruments_repo.get_or_create(
            session, symbol="DAX", name="My DAX", asset_class="stock"
        )
        onboarding_service.seed_default_setup(session)
        kept = instruments_repo.get_by_symbol(session, "DAX")
        assert kept is not None
        assert kept.id == instr.id
        # Deliberate non-placeholder values are not clobbered.
        assert kept.name == "My DAX"
        assert kept.asset_class == "stock"
