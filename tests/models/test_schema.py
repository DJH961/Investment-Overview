"""Schema round-trip tests: tables exist, FKs enforced, decimals preserved."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from investment_dashboard.models import (
    ALL_METADATAS,
    Account,
    Base,
    FxHistory,
    Instrument,
    PriceHistory,
    TargetAllocation,
    TargetAllocationItem,
    Transaction,
    TransactionKind,
)
from investment_dashboard.models.transaction import TransactionSource

EXPECTED_TABLES = {
    "accounts",
    "instruments",
    "instrument_overrides",
    "transactions",
    "price_history",
    "fx_history",
    "target_allocations",
    "target_allocation_items",
    "app_config",
    "position_snapshots",
    "price_cache_metadata",
}


def test_all_tables_registered() -> None:
    # Schema is partitioned across the ledger/config/cache tier metadatas
    # (see :mod:`investment_dashboard.models.base`); union them.
    registered: set[str] = set()
    for md in ALL_METADATAS:
        registered.update(md.tables.keys())
    assert registered == EXPECTED_TABLES
    # ``Base`` is the ledger-tier alias; sanity-check it carries the
    # ledger tables only so partition stays honest.
    assert {"accounts", "instruments", "transactions"} <= set(Base.metadata.tables.keys())


def test_account_transaction_roundtrip(session: Session) -> None:
    account = Account(
        broker="fidelity",
        account_label="Fidelity Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    instrument = Instrument(
        symbol="VTI",
        name="Vanguard Total Stock Market ETF",
        asset_class="etf",
        native_currency="USD",
    )
    session.add_all([account, instrument])
    session.flush()

    tx = Transaction(
        account_id=account.id,
        date=date(2024, 1, 15),
        kind=TransactionKind.BUY.value,
        instrument_id=instrument.id,
        quantity=Decimal("1.23456789"),
        price_native=Decimal("250.123456"),
        gross_native=Decimal("-308.799912"),
        fees_native=Decimal("0.000000"),
        net_native=Decimal("-308.799912"),
        fx_rate_to_eur=Decimal("0.92345678"),
        net_eur=Decimal("-285.150000"),
        external_id="abc123",
        source=TransactionSource.IMPORT_FIDELITY_CSV.value,
    )
    session.add(tx)
    session.commit()

    loaded = session.query(Transaction).one()
    assert loaded.quantity == Decimal("1.23456789")
    assert loaded.price_native == Decimal("250.123456")
    assert loaded.fx_rate_to_eur == Decimal("0.92345678")
    assert loaded.account.broker == "fidelity"
    assert loaded.instrument is not None
    assert loaded.instrument.symbol == "VTI"


def test_unique_external_id_per_account(session: Session) -> None:
    account = Account(broker="fidelity", account_label="F", native_currency="USD")
    session.add(account)
    session.flush()

    def _tx(ext_id: str) -> Transaction:
        return Transaction(
            account_id=account.id,
            date=date(2024, 1, 1),
            kind=TransactionKind.DEPOSIT.value,
            net_native=Decimal("100.000000"),
            external_id=ext_id,
            source=TransactionSource.IMPORT_FIDELITY_CSV.value,
        )

    session.add(_tx("dup"))
    session.commit()
    session.add(_tx("dup"))
    with pytest.raises(IntegrityError):
        session.commit()
    session.rollback()


def test_foreign_key_enforced(session: Session) -> None:
    """Inserting a transaction with a bogus account_id must fail."""
    tx = Transaction(
        account_id=9999,
        date=date(2024, 1, 1),
        kind=TransactionKind.DEPOSIT.value,
        net_native=Decimal("1.0"),
        source=TransactionSource.MANUAL.value,
    )
    session.add(tx)
    with pytest.raises(IntegrityError):
        session.commit()
    session.rollback()


def test_price_history_composite_pk(session: Session) -> None:
    inst = Instrument(symbol="VOO", asset_class="etf", native_currency="USD")
    session.add(inst)
    session.flush()
    session.add_all(
        [
            PriceHistory(
                instrument_id=inst.id, date=date(2024, 1, 2), close_native=Decimal("100.50")
            ),
            PriceHistory(
                instrument_id=inst.id, date=date(2024, 1, 3), close_native=Decimal("101.25")
            ),
        ]
    )
    session.commit()
    assert session.query(PriceHistory).count() == 2


def test_fx_history_roundtrip(session: Session) -> None:
    session.add(
        FxHistory(date=date(2024, 6, 1), base="EUR", quote="USD", rate=Decimal("1.08765432"))
    )
    session.commit()
    row = session.query(FxHistory).one()
    assert row.rate == Decimal("1.08765432")


def test_target_allocation_items(session: Session) -> None:
    inst = Instrument(symbol="VT", asset_class="etf", native_currency="USD")
    session.add(inst)
    session.flush()
    alloc = TargetAllocation(name="Default", active=True)
    alloc.items.append(TargetAllocationItem(instrument_id=inst.id, weight_pct=Decimal("100.00")))
    session.add(alloc)
    session.commit()

    loaded = session.query(TargetAllocation).one()
    assert len(loaded.items) == 1
    assert loaded.items[0].weight_pct == Decimal("100.00")
