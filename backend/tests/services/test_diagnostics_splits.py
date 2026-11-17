"""Data Health split and share-count hints (v7 P7) on a synthetic ledger."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    instruments_repo,
    splits_repo,
    transactions_repo,
)
from investment_dashboard.services import broker_share_counts_service, diagnostics_service


def _seed(session: Session, *, ledger_split: bool) -> tuple[int, int]:
    account_id = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Main",
        native_currency="USD",
        account_type="brokerage",
    ).id
    instr = instruments_repo.get_or_create(session, symbol="FAKE1", asset_class="etf")
    session.flush()
    rows = [(date(2024, 1, 2), "buy", "10", "-1000")]
    if ledger_split:
        rows.append((date(2024, 6, 11), "split", "30", "0"))
    for d, kind, qty, net in rows:
        transactions_repo.insert_transaction(
            session,
            Transaction(
                account_id=account_id,
                instrument_id=instr.id,
                date=d,
                kind=kind,
                quantity=Decimal(qty),
                net_native=Decimal(net),
                source="manual",
            ),
        )
    splits_repo.upsert_splits(session, instr.id, {date(2024, 6, 10): Decimal("4")})
    session.commit()
    return account_id, instr.id


def _by_key(items: list, key: str):
    return next(i for i in items if i.key == key)


def test_provider_split_without_ledger_row_is_a_hint(session: Session) -> None:
    _seed(session, ledger_split=False)
    items = diagnostics_service._check_splits(session)
    missing = _by_key(items, "missing_splits")
    assert missing.severity == "warning"
    assert missing.count == 1
    assert missing.examples == (
        "possible missing split: FAKE1, 2024-06-10, ratio 4, 10 shares held",
    )
    assert _by_key(items, "unmatched_ledger_splits").severity == "ok"


def test_matching_ledger_split_clears_the_hint(session: Session) -> None:
    _seed(session, ledger_split=True)  # one day after the provider date, same 4-for-1
    items = diagnostics_service._check_splits(session)
    assert all(i.severity == "ok" for i in items)


def test_ledger_split_without_provider_split_is_a_soft_hint(session: Session) -> None:
    _, instrument_id = _seed(session, ledger_split=True)
    splits_repo.delete_split(session, instrument_id, date(2024, 6, 10))
    session.commit()
    items = diagnostics_service._check_splits(session)
    assert _by_key(items, "missing_splits").severity == "ok"
    assert _by_key(items, "unmatched_ledger_splits").count == 1


def test_manual_split_is_not_a_provider_split(session: Session) -> None:
    _, instrument_id = _seed(session, ledger_split=False)
    splits_repo.delete_split(session, instrument_id, date(2024, 6, 10))
    splits_repo.upsert_splits(
        session, instrument_id, {date(2024, 6, 10): Decimal("4")}, source="manual"
    )
    session.commit()
    assert _by_key(diagnostics_service._check_splits(session), "missing_splits").severity == "ok"


def test_share_counts_not_set_up_is_ok(session: Session) -> None:
    _seed(session, ledger_split=False)
    item = diagnostics_service._check_share_counts(session)
    assert item.severity == "ok"
    assert "Not set up" in item.detail


def test_share_count_mismatch_and_match(session: Session) -> None:
    account_id, instrument_id = _seed(session, ledger_split=False)
    broker_share_counts_service.replace(session, [(account_id, instrument_id, Decimal("10"))])
    session.commit()
    assert diagnostics_service._check_share_counts(session).severity == "ok"

    broker_share_counts_service.replace(session, [(account_id, instrument_id, Decimal("40"))])
    session.commit()
    item = diagnostics_service._check_share_counts(session)
    assert item.severity == "warning"
    assert item.examples == ("share count differs: FAKE1 in fidelity Main, ledger 10, broker 40",)
