"""Editing/deleting a cash move keeps its paired settlement leg in sync.

These cover the divergence guard added in v3.2: the (often hidden) money-market
settlement leg must track its parent so the settlement balance never drifts.
Both the post-v3.2 ``:vmfxx`` link and the legacy unlinked manual leg are
exercised so editing *existing* entries keeps working.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import accounts_repo, instruments_repo, transactions_repo
from investment_dashboard.ui.pages import transactions as page


def _account(session: Session) -> int:
    return accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="Brokerage",
        native_currency="USD",
        account_type="brokerage",
    ).id


def _seed_parent_with_linked_leg(session: Session, account_id: int) -> tuple[int, int]:
    """A deposit of +1000 with a linked VMFXX leg of -1000 (cash swept in)."""
    parent = transactions_repo.insert_transaction(
        session,
        Transaction(
            account_id=account_id,
            date=date(2024, 1, 5),
            kind="deposit",
            net_native=Decimal("1000"),
            net_usd=Decimal("1000"),
            external_id="DEP-1",
            source=TransactionSource.IMPORT_VANGUARD_XLSX,
        ),
    )
    assert parent is not None
    leg = transactions_repo.insert_transaction(
        session,
        Transaction(
            account_id=account_id,
            date=date(2024, 1, 5),
            kind="buy",
            net_native=Decimal("-1000"),
            net_usd=Decimal("-1000"),
            quantity=Decimal("-1000"),
            price_native=Decimal("1"),
            external_id="DEP-1:vmfxx",
            source=TransactionSource.IMPORT_VANGUARD_XLSX,
        ),
    )
    assert leg is not None
    return parent.id, leg.id


def test_edit_resyncs_linked_settlement_leg(session: Session) -> None:
    account_id = _account(session)
    parent_id, leg_id = _seed_parent_with_linked_leg(session, account_id)

    # User edits the deposit up to 1500.
    parent = transactions_repo.update_transaction(session, parent_id, net_native=Decimal("1500"))
    assert parent is not None
    page._resync_settlement_leg(
        session,
        parent=parent,
        old_account_id=account_id,
        old_external_id="DEP-1",
        old_date="2024-01-05",
        old_net_native=Decimal("1000"),
        native_ccy="USD",
    )

    leg = transactions_repo.get_transaction(session, leg_id)
    assert leg is not None
    assert leg.net_native == Decimal("-1500")  # mirrors the new cash exactly
    assert leg.quantity == Decimal("1500")
    assert leg.kind == "buy"


def test_edit_to_zero_flow_drops_the_leg(session: Session) -> None:
    account_id = _account(session)
    parent_id, leg_id = _seed_parent_with_linked_leg(session, account_id)

    parent = transactions_repo.update_transaction(session, parent_id, net_native=None)
    assert parent is not None
    page._resync_settlement_leg(
        session,
        parent=parent,
        old_account_id=account_id,
        old_external_id="DEP-1",
        old_date="2024-01-05",
        old_net_native=Decimal("1000"),
        native_ccy="USD",
    )
    assert transactions_repo.get_transaction(session, leg_id) is None


def test_edit_resyncs_legacy_unlinked_leg(session: Session) -> None:
    account_id = _account(session)
    # Legacy manual auto-leg: no external_id link, only the description marker.
    parent = transactions_repo.insert_transaction(
        session,
        Transaction(
            account_id=account_id,
            date=date(2024, 1, 5),
            kind="deposit",
            net_native=Decimal("1000"),
            source=TransactionSource.MANUAL,
        ),
    )
    assert parent is not None
    leg = transactions_repo.insert_transaction(
        session,
        Transaction(
            account_id=account_id,
            date=date(2024, 1, 5),
            kind="buy",
            net_native=Decimal("-1000"),
            quantity=Decimal("-1000"),
            price_native=Decimal("1"),
            description="Money-market settlement (auto) · VMFXX",
            source=TransactionSource.MANUAL,
        ),
    )
    assert leg is not None

    updated = transactions_repo.update_transaction(session, parent.id, net_native=Decimal("250"))
    assert updated is not None
    page._resync_settlement_leg(
        session,
        parent=updated,
        old_account_id=account_id,
        old_external_id=None,
        old_date="2024-01-05",
        old_net_native=Decimal("1000"),
        native_ccy="USD",
    )
    refreshed = transactions_repo.get_transaction(session, leg.id)
    assert refreshed is not None
    assert refreshed.net_native == Decimal("-250")
    assert refreshed.quantity == Decimal("250")


def test_resync_noop_when_no_leg(session: Session) -> None:
    account_id = _account(session)
    parent = transactions_repo.insert_transaction(
        session,
        Transaction(
            account_id=account_id,
            date=date(2024, 1, 5),
            kind="deposit",
            net_native=Decimal("500"),
            source=TransactionSource.MANUAL,
        ),
    )
    assert parent is not None
    # No paired leg exists; resync must not invent one or raise.
    page._resync_settlement_leg(
        session,
        parent=parent,
        old_account_id=account_id,
        old_external_id=None,
        old_date="2024-01-05",
        old_net_native=Decimal("500"),
        native_ccy="USD",
    )
    legs = [
        t
        for t in transactions_repo.list_transactions(session, account_id=account_id)
        if t.id != parent.id
    ]
    assert legs == []


def test_maybe_money_market_leg_links_parent(session: Session) -> None:
    account_id = _account(session)
    # Seed the account's VMFXX settlement fund so the leg can be created.
    vmfxx = instruments_repo.get_or_create(session, symbol="VMFXX")
    transactions_repo.insert_transaction(
        session,
        Transaction(
            account_id=account_id,
            date=date(2023, 1, 1),
            kind="buy",
            instrument_id=vmfxx.id,
            net_native=Decimal("-1"),
            source=TransactionSource.MANUAL,
        ),
    )
    parent = transactions_repo.insert_transaction(
        session,
        Transaction(
            account_id=account_id,
            date=date(2024, 1, 5),
            kind="deposit",
            net_native=Decimal("1000"),
            source=TransactionSource.MANUAL,
        ),
    )
    assert parent is not None
    page._maybe_money_market_leg(
        session,
        enabled=True,
        parent=parent,
        kind="deposit",
        net_native=Decimal("1000"),
        native_ccy="USD",
        txn_date=date(2024, 1, 5),
    )
    # The parent gained a stable external_id and the leg is linked + findable.
    assert parent.external_id == f"manual:{parent.id}"
    leg = transactions_repo.find_settlement_leg(
        session, account_id=account_id, parent_external_id=parent.external_id
    )
    assert leg is not None
    assert leg.net_native == Decimal("-1000")
    assert leg.instrument_id == vmfxx.id
