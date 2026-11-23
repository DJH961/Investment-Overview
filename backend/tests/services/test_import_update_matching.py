"""Smart import matching end to end: preview status, confirm overwrite, choices."""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.adapters.frankfurter_client import FrankfurterError
from investment_dashboard.domain.import_match import ESTIMATED_TOLERANCE, MatchTolerance
from investment_dashboard.repositories import accounts_repo, transactions_repo
from investment_dashboard.services import (
    fx_service,
    import_staging,
    import_update_service,
    instrument_enrichment_service,
)
from investment_dashboard.services import settings_registry as reg

FIXTURE = Path(__file__).parents[1] / "adapters" / "fixtures" / "fidelity_sample.csv"
ORIGINAL = FIXTURE.read_bytes()
#: The first buy: 10 x 220.50 = -2205.00. The re-export books -2204.99 (a cent less).
NEAR = ORIGINAL.replace(b",-2205.00,", b",-2204.99,", 1)
FAR = ORIGINAL.replace(b",-2205.00,", b",-2305.00,", 1)


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
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    ).id


def _stage(session: Session, account_id: int, content: bytes, **kw: object):
    return import_staging.stage(
        session,
        filename="f.csv",
        content=content,
        account_id=account_id,
        **kw,  # type: ignore[arg-type]
    )


def _seed(session: Session, account_id: int) -> None:
    staged = _stage(session, account_id, ORIGINAL)
    assert staged.update_count == 0
    result = import_staging.confirm(session, staged.id)
    assert (result.inserted, result.updated) == (6, 0)


def _buy(session: Session, account_id: int):
    (buy,) = [
        t
        for t in transactions_repo.list_transactions(session, account_id=account_id)
        if t.kind == "buy"
    ]
    return buy


def test_registry_defaults_match_domain_tolerance() -> None:
    tol = MatchTolerance()
    assert reg.BY_KEY["import.match_relative_tolerance"].default == tol.relative
    assert reg.BY_KEY["import.match_absolute_amount"].default == tol.absolute_amount
    assert reg.BY_KEY["import.match_absolute_quantity"].default == tol.absolute_quantity
    assert reg.BY_KEY["import.match_business_days"].default == tol.business_days
    assert reg.BY_KEY["import.match_updates_enabled"].default is True
    est = ESTIMATED_TOLERANCE
    assert reg.BY_KEY["import.match_estimated_relative_tolerance"].default == est.relative
    assert reg.BY_KEY["import.match_estimated_absolute_amount"].default == est.absolute_amount
    assert reg.BY_KEY["import.match_estimated_business_days"].default == est.business_days


def test_exact_reimport_is_still_all_duplicates(session: Session, account_id: int) -> None:
    _seed(session, account_id)
    staged = _stage(session, account_id, ORIGINAL)
    assert (staged.new_count, staged.update_count, staged.duplicate_count) == (0, 0, 6)
    assert {r.status for r in staged.rows} == {"duplicate"}


def test_near_row_previews_as_update_with_old_figures(session: Session, account_id: int) -> None:
    _seed(session, account_id)
    buy_id = _buy(session, account_id).id
    staged = _stage(session, account_id, NEAR)
    assert (staged.new_count, staged.update_count, staged.duplicate_count) == (0, 1, 5)
    (row,) = [r for r in staged.rows if r.status == "update"]
    assert row.existing is not None
    assert row.existing.id == buy_id
    assert row.existing.net_native == Decimal("-2205.00")
    assert row.row.net_native == Decimal("-2204.99")
    assert {"skip", "import_new"} <= set(row.fixes)


def test_estimated_row_matches_loosely_and_is_flagged_estimated(
    session: Session, account_id: int
) -> None:
    _seed(session, account_id)
    # 1.5 % off: a new row for a confirmed row, an update for an estimate.
    loose = ORIGINAL.replace(b",-2205.00,", b",-2238.00,", 1)
    assert _stage(session, account_id, loose).update_count == 0
    with patch.object(import_update_service, "profile_for", return_value="estimated"):
        staged = _stage(session, account_id, loose)
    assert (staged.new_count, staged.update_count) == (0, 1)
    (row,) = [r for r in staged.rows if r.status == "update"]
    assert row.existing is not None
    assert row.existing.estimated is True


def test_far_row_is_new_not_update(session: Session, account_id: int) -> None:
    _seed(session, account_id)
    staged = _stage(session, account_id, FAR)
    assert (staged.new_count, staged.update_count) == (1, 0)


def test_matching_can_be_switched_off(session: Session, account_id: int) -> None:
    _seed(session, account_id)
    with patch.object(import_update_service, "match_tolerances", return_value=None):
        staged = _stage(session, account_id, NEAR)
    assert (staged.new_count, staged.update_count) == (1, 0)


def test_confirm_overwrites_existing_row_and_keeps_its_id(
    session: Session, account_id: int
) -> None:
    _seed(session, account_id)
    before = _buy(session, account_id)
    buy_id, old_ext, old_batch = before.id, before.external_id, before.import_batch_id
    staged = _stage(session, account_id, NEAR)
    new_ext = next(r.row.external_id for r in staged.rows if r.status == "update")
    result = import_staging.confirm(session, staged.id)
    assert (result.inserted, result.updated, result.duplicates) == (0, 1, 5)
    after = _buy(session, account_id)
    assert after.id == buy_id
    assert after.net_native == Decimal("-2204.99")
    assert after.external_id == new_ext != old_ext
    assert after.import_batch_id == result.import_batch_id != old_batch  # joins this batch
    assert len(transactions_repo.list_transactions(session, account_id=account_id)) == 6
    # The same file again is now all exact duplicates.
    again = _stage(session, account_id, NEAR)
    assert (again.new_count, again.update_count, again.duplicate_count) == (0, 0, 6)


def test_skip_leaves_existing_row_alone(session: Session, account_id: int) -> None:
    _seed(session, account_id)
    staged = _stage(session, account_id, NEAR)
    row = next(r for r in staged.rows if r.status == "update")
    staged = import_staging.resolve(session, staged.id, {row.index: "skip"})
    assert staged.update_count == 0
    result = import_staging.confirm(session, staged.id)
    assert (result.inserted, result.updated) == (0, 0)
    assert _buy(session, account_id).net_native == Decimal("-2205.00")


def test_import_as_new_inserts_a_second_row(session: Session, account_id: int) -> None:
    _seed(session, account_id)
    staged = _stage(session, account_id, NEAR)
    row = next(r for r in staged.rows if r.status == "update")
    staged = import_staging.resolve(session, staged.id, {row.index: "import_new"})
    again = next(r for r in staged.rows if r.index == row.index)
    assert again.status == "new"
    assert again.existing is not None
    assert "import_new" in again.fixes  # can be switched back
    result = import_staging.confirm(session, staged.id)
    assert (result.inserted, result.updated) == (1, 0)
    assert len(transactions_repo.list_transactions(session, account_id=account_id)) == 7


def test_updates_refresh_caches_like_a_manual_edit(session: Session, account_id: int) -> None:
    _seed(session, account_id)
    staged = _stage(session, account_id, NEAR)
    with patch.object(import_update_service.transaction_edit_service, "after_write") as hook:
        import_staging.confirm(session, staged.id)
    hook.assert_called_once()
    assert hook.call_args.args[1]  # the affected dates
