"""Undo of an import that updated existing transactions, and est. rows settled by import."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.adapters.frankfurter_client import FrankfurterError
from investment_dashboard.domain.money_market import settlement_external_id_for
from investment_dashboard.repositories import accounts_repo, import_batches_repo, transactions_repo
from investment_dashboard.services import (
    fx_service,
    import_staging,
    import_undo_service,
    instrument_enrichment_service,
    recurring_service,
)

FIXTURE = Path(__file__).parents[1] / "adapters" / "fixtures" / "fidelity_sample.csv"
ORIGINAL = FIXTURE.read_bytes()
NEAR = ORIGINAL.replace(b",-2205.00,", b",-2204.99,", 1)
FIELDS = (
    "date",
    "settlement_date",
    "quantity",
    "price_native",
    "gross_native",
    "fees_native",
    "net_native",
    "fx_rate_to_eur",
    "net_eur",
    "net_usd",
    "description",
    "external_id",
    "source",
    "import_batch_id",
    "is_estimate",
)


@pytest.fixture(autouse=True)
def _clean() -> Iterator[None]:
    import_staging.clear()
    with (
        patch.object(fx_service, "fetch_rates", side_effect=FrankfurterError("offline")),
        patch.object(instrument_enrichment_service, "fetch_instrument_info", return_value=None),
        patch.object(import_undo_service, "_backup_first", return_value=None),
    ):
        yield
    import_staging.clear()


@pytest.fixture
def account_id(session: Session) -> int:
    return accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    ).id


def _import(session: Session, account_id: int, content: bytes) -> Any:
    staged = import_staging.stage(session, filename="f.csv", content=content, account_id=account_id)
    return import_staging.confirm(session, staged.id)


def _buy(session: Session, account_id: int) -> Any:
    (buy,) = [
        t
        for t in transactions_repo.list_transactions(session, account_id=account_id)
        if t.kind == "buy"
    ]
    return buy


def _figures(txn: Any) -> dict[str, object]:
    return {f: getattr(txn, f) for f in FIELDS}


def _undo(session: Session, batch_id: int) -> import_undo_service.UndoResult:
    return import_undo_service.undo(
        session, batch_id, confirm="UNDO", actor="test", now=datetime.now(UTC)
    )


def test_undo_after_update_restores_exact_old_figures(session: Session, account_id: int) -> None:
    first = _import(session, account_id, ORIGINAL)
    before = _figures(_buy(session, account_id))
    result = _import(session, account_id, NEAR)
    assert (result.inserted, result.updated) == (0, 1)
    batch = import_batches_repo.get(session, result.import_batch_id)
    assert batch is not None
    assert batch.updated_count == 1
    assert _buy(session, account_id).net_native == Decimal("-2204.99")

    preview = import_undo_service.preview(session, batch.id)
    assert (preview.restored, preview.total) == (1, 0)
    undone = _undo(session, batch.id)
    assert (undone.restored, undone.deleted) == (1, 0)
    assert _figures(_buy(session, account_id)) == before
    assert before["import_batch_id"] == first.import_batch_id
    assert len(transactions_repo.list_transactions(session, account_id=account_id)) == 6


def test_undo_removes_inserted_rows_and_restores_updated_ones(
    session: Session, account_id: int
) -> None:
    _import(session, account_id, ORIGINAL)
    before = _figures(_buy(session, account_id))
    extra = NEAR + b"03/20/2024,INTEREST EARNED,,Interest Earned,Cash,,,,,,7.77,1.00,03/20/2024\n"
    result = _import(session, account_id, extra)
    assert (result.inserted, result.updated) == (1, 1)
    undone = _undo(session, result.import_batch_id)
    assert (undone.restored, undone.deleted) == (1, 1)
    assert _figures(_buy(session, account_id)) == before
    assert len(transactions_repo.list_transactions(session, account_id=account_id)) == 6


def test_hand_edited_updated_row_is_left_alone_by_undo(session: Session, account_id: int) -> None:
    _import(session, account_id, ORIGINAL)
    result = _import(session, account_id, NEAR)
    buy = _buy(session, account_id)
    import_batches_repo.detach(session, [buy.id])  # what a manual edit does
    undone = _undo(session, result.import_batch_id)
    assert undone.restored == 0
    assert _buy(session, account_id).net_native == Decimal("-2204.99")


def test_undo_restores_est_on_the_buy_and_its_core_fund_leg(
    session: Session, account_id: int
) -> None:
    _import(session, account_id, ORIGINAL)
    buy = _buy(session, account_id)
    leg = transactions_repo.insert_transaction(
        session,
        transactions_repo.new_transaction(
            account_id=account_id,
            date=buy.date,
            kind="sell",
            net_native=-buy.net_native,
            external_id=settlement_external_id_for(buy.external_id),
            source="manual",
            is_estimate=True,
        ),
    )
    assert leg is not None
    buy.is_estimate = True
    session.flush()

    result = _import(session, account_id, NEAR)
    assert result.updated == 1
    assert _buy(session, account_id).is_estimate is False
    assert leg.is_estimate is False  # confirmed with its buy

    _undo(session, result.import_batch_id)
    assert _buy(session, account_id).is_estimate is True
    assert leg.is_estimate is True
    assert _buy(session, account_id).net_native == Decimal("-2205.00")


def test_settled_by_hand_then_imported_exact_is_duplicate_one_cent_off_is_update(
    session: Session, account_id: int
) -> None:
    _import(session, account_id, ORIGINAL)
    buy = _buy(session, account_id)
    buy.is_estimate = True
    session.flush()
    assert recurring_service.confirm_estimate(session, buy) is True  # settled by hand

    exact = import_staging.stage(session, filename="f.csv", content=ORIGINAL, account_id=account_id)
    assert (exact.new_count, exact.update_count, exact.duplicate_count) == (0, 0, 6)
    off = import_staging.stage(session, filename="f.csv", content=NEAR, account_id=account_id)
    assert (off.new_count, off.update_count, off.duplicate_count) == (0, 1, 5)
    (row,) = [r for r in off.rows if r.status == "update"]
    assert row.existing is not None
    assert row.existing.estimated is False  # normal profile
