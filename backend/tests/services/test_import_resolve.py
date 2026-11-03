"""Resolving import rows that don't add up: keep, recompute the price, or skip."""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.adapters.frankfurter_client import FrankfurterError
from investment_dashboard.adapters.importer_types import ParsedTransactionRow
from investment_dashboard.adapters.row_validation import (
    FIX_KEEP,
    FIX_PRICE,
    FIX_SKIP,
    apply_fix,
    fixes_for,
    price_from_amount,
    validate_row,
)
from investment_dashboard.repositories import accounts_repo, transactions_repo
from investment_dashboard.services import (
    fx_service,
    import_staging,
    instrument_enrichment_service,
)

FIXTURE = Path(__file__).parents[1] / "adapters" / "fixtures" / "vanguard_sample.csv"
#: The fixture's first buy is 5 x 220.00 = 1100.00; book 1300.00 instead.
BAD = FIXTURE.read_bytes().replace(b",-1100.00,", b",-1300.00,", 1)


@pytest.fixture(autouse=True)
def _clean() -> Iterator[None]:
    import_staging.clear()
    with (
        patch.object(fx_service, "fetch_rates", side_effect=FrankfurterError("offline")),
        patch.object(instrument_enrichment_service, "fetch_instrument_info", return_value=None),
    ):
        yield
    import_staging.clear()


@pytest.fixture
def account_id(session: Session) -> int:
    return accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="Vanguard",
        native_currency="USD",
        account_type="brokerage",
    ).id


def _stage(session: Session, account_id: int) -> import_staging.StagedImport:
    return import_staging.stage(
        session, filename="vanguard_sample.csv", content=BAD, account_id=account_id
    )


def _flagged(staged: import_staging.StagedImport) -> import_staging.PreviewRow:
    rows = [r for r in staged.rows if r.warnings]
    assert len(rows) == 1
    return rows[0]


def _row(**kw: object) -> ParsedTransactionRow:
    base: dict[str, object] = {
        "date": __import__("datetime").date(2024, 1, 5),
        "settlement_date": None,
        "kind": "buy",
        "symbol": "VTI",
        "quantity": Decimal(10),
        "price_native": Decimal("220.50"),
        "gross_native": None,
        "fees_native": None,
        "net_native": Decimal("-2500"),
        "description": None,
        "external_id": "x",
        "source": "fidelity_csv",
    }
    base.update(kw)
    return ParsedTransactionRow(**base)  # type: ignore[arg-type]


def test_price_from_amount_handles_fees_by_side() -> None:
    assert price_from_amount(_row(fees_native=Decimal(5))) == Decimal("249.500000")
    sell = _row(
        kind="sell", quantity=Decimal(-10), net_native=Decimal(2500), fees_native=Decimal(5)
    )
    assert price_from_amount(sell) == Decimal("250.500000")
    assert price_from_amount(_row(quantity=Decimal(0))) is None


def test_fix_price_makes_the_row_reconcile() -> None:
    row = _row(gross_native=Decimal("-2205"))
    assert fixes_for(row) == [FIX_KEEP, FIX_PRICE, FIX_SKIP]
    fixed = apply_fix(row, FIX_PRICE)
    assert fixed is not None
    assert fixed.price_native == Decimal(250)
    assert fixed.gross_native == Decimal(-2500)
    assert fixed.external_id == row.external_id
    assert validate_row(fixed) == []
    assert apply_fix(row, FIX_SKIP) is None
    assert apply_fix(row, FIX_KEEP) is row


def test_clean_row_offers_no_fix() -> None:
    assert fixes_for(_row(net_native=Decimal("-2205"))) == []


def test_preview_flags_the_row_with_its_fixes(session: Session, account_id: int) -> None:
    staged = _stage(session, account_id)
    row = _flagged(staged)
    assert "does not reconcile" in row.warnings[0]
    assert row.fixes == (FIX_KEEP, FIX_PRICE, FIX_SKIP)
    assert row.resolution is None
    assert staged.unresolved_count == 1


def test_fix_price_is_previewed_and_written(session: Session, account_id: int) -> None:
    staged = _stage(session, account_id)
    fresh = import_staging.resolve(session, staged.id, {_flagged(staged).index: FIX_PRICE})
    row = _flagged(fresh)
    assert row.resolution == FIX_PRICE
    assert row.row.price_native == Decimal(260)
    assert fresh.unresolved_count == 0
    result = import_staging.confirm(session, fresh.id)
    assert result.inserted == fresh.new_count
    assert result.warnings == []
    prices = {t.price_native for t in transactions_repo.list_transactions(session)}
    assert Decimal(260) in prices


def test_skip_leaves_the_row_out(session: Session, account_id: int) -> None:
    staged = _stage(session, account_id)
    fresh = import_staging.resolve(session, staged.id, {_flagged(staged).index: FIX_SKIP})
    # The row and its settlement-fund leg are both left out.
    assert fresh.skipped_count == 2
    assert fresh.new_count == staged.new_count - 2
    assert import_staging.confirm(session, fresh.id).inserted == fresh.new_count


def test_clearing_a_resolution_and_bad_requests(session: Session, account_id: int) -> None:
    staged = _stage(session, account_id)
    index = _flagged(staged).index
    kept = import_staging.resolve(session, staged.id, {index: FIX_KEEP})
    assert _flagged(kept).resolution == FIX_KEEP
    cleared = import_staging.resolve(session, kept.id, {index: None})
    assert _flagged(cleared).resolution is None
    clean = next(r for r in cleared.rows if not r.warnings)
    with pytest.raises(import_staging.ImportStagingError):
        import_staging.resolve(session, cleared.id, {clean.index: FIX_SKIP})
    with pytest.raises(import_staging.ImportStagingError):
        import_staging.resolve(session, cleared.id, {999: FIX_KEEP})
