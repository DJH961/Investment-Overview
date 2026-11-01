"""Staging store behaviour: TTL, entry cap, discard, idempotent confirm."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.adapters.frankfurter_client import FrankfurterError
from investment_dashboard.repositories import accounts_repo
from investment_dashboard.services import (
    fx_service,
    import_staging,
    instrument_enrichment_service,
)

FIXTURE = Path(__file__).parents[1] / "adapters" / "fixtures" / "fidelity_sample.csv"


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


def _stage(session: Session, account_id: int, **kw: object) -> import_staging.StagedImport:
    return import_staging.stage(
        session,
        filename="fidelity_sample.csv",
        content=FIXTURE.read_bytes(),
        account_id=account_id,
        **kw,  # type: ignore[arg-type]
    )


def test_stage_does_not_write_and_confirm_is_idempotent(session: Session, account_id: int) -> None:
    staged = _stage(session, account_id)
    assert len(staged.rows) == 6
    assert staged.new_count == 6
    from investment_dashboard.repositories import transactions_repo

    assert list(transactions_repo.list_transactions(session)) == []
    result = import_staging.confirm(session, staged.id)
    assert result.inserted == 6
    again = _stage(session, account_id)
    assert again.duplicate_count == 6
    assert import_staging.confirm(session, again.id).inserted == 0


def test_ttl_expiry(session: Session, account_id: int) -> None:
    t0 = datetime(2025, 1, 1, tzinfo=UTC)
    staged = _stage(session, account_id, now=t0)
    assert import_staging.get(staged.id, now=t0 + timedelta(minutes=29)).id == staged.id
    with pytest.raises(import_staging.StagedImportNotFoundError):
        import_staging.get(staged.id, now=t0 + timedelta(minutes=31))


def test_entry_cap_evicts_oldest(
    session: Session, account_id: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(import_staging, "MAX_STAGED", 2)
    t0 = datetime(2025, 1, 1, tzinfo=UTC)
    a = _stage(session, account_id, now=t0)
    b = _stage(session, account_id, now=t0 + timedelta(seconds=1))
    c = _stage(session, account_id, now=t0 + timedelta(seconds=2))
    with pytest.raises(import_staging.StagedImportNotFoundError):
        import_staging.get(a.id, now=t0 + timedelta(seconds=3))
    assert import_staging.get(b.id, now=t0 + timedelta(seconds=3))
    assert import_staging.get(c.id, now=t0 + timedelta(seconds=3))


def test_rejects_bad_input(session: Session, account_id: int) -> None:
    with pytest.raises(import_staging.ImportStagingError):
        import_staging.stage(session, filename="a.pdf", content=b"x", account_id=account_id)
    with pytest.raises(import_staging.ImportStagingError):
        import_staging.stage(session, filename="a.csv", content=b"", account_id=account_id)
    with pytest.raises(import_staging.ImportStagingError):
        import_staging.stage(session, filename="a.csv", content=b"x")
    with pytest.raises(import_staging.ImportStagingError):
        import_staging.stage(
            session, filename="a.csv", content=b"x", account_id=account_id, broker="nobroker"
        )
