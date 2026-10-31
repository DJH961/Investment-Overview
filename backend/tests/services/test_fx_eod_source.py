"""End-of-day FX source policy: Frankfurter/ECB only (no yfinance overlay).

Historical end-of-day EUR/USD rates come from the ECB/Frankfurter reference
fixings. An earlier build additionally re-marked the same days at yfinance's
``EURUSD=X`` close; that overlay has been reverted, and
``fx_service.purge_legacy_yfinance_fx_history`` retires any rows it left behind
so the ECB backfill owns the historical marks again. (yfinance is still used for
*live* and *intraday* rates — a separate path.)
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.models import FxHistory
from investment_dashboard.repositories import fx_repo
from investment_dashboard.services import fx_service


def _row(session: Session, on: date) -> FxHistory | None:
    stmt = select(FxHistory).where(
        FxHistory.date == on, FxHistory.base == "EUR", FxHistory.quote == "USD"
    )
    return session.scalars(stmt).one_or_none()


def test_purge_removes_legacy_yfinance_rows_only(session: Session) -> None:
    # A mix of ECB and leftover yfinance-sourced rows.
    fx_repo.upsert_rates(session, {date(2024, 1, 2): Decimal("1.08")}, source="frankfurter")
    fx_repo.upsert_rates(session, {date(2024, 1, 3): Decimal("1.0912")}, source="yfinance")
    session.flush()

    removed = fx_service.purge_legacy_yfinance_fx_history(session)
    session.flush()

    assert removed == 1
    # The ECB row survives; the yfinance row is gone so ECB can refill that date.
    assert _row(session, date(2024, 1, 2)) is not None
    assert _row(session, date(2024, 1, 3)) is None


def test_purge_is_idempotent_noop_without_yfinance_rows(session: Session) -> None:
    fx_repo.upsert_rates(session, {date(2024, 1, 2): Decimal("1.08")}, source="frankfurter")
    session.flush()

    assert fx_service.purge_legacy_yfinance_fx_history(session) == 0
    # The ECB baseline is untouched.
    row = _row(session, date(2024, 1, 2))
    assert row is not None
    assert row.source == "frankfurter"


def test_delete_by_source_scopes_to_pair_and_source(session: Session) -> None:
    fx_repo.upsert_rates(session, {date(2024, 1, 2): Decimal("1.08")}, source="yfinance")
    fx_repo.upsert_rates(
        session, {date(2024, 1, 2): Decimal("7.5")}, quote="DKK", source="yfinance"
    )
    session.flush()

    removed = fx_repo.delete_by_source(session, base="EUR", quote="USD", source="yfinance")
    session.flush()

    assert removed == 1  # only the EUR/USD row, not the EUR/DKK one
    stmt = select(FxHistory).where(FxHistory.quote == "DKK")
    assert session.scalars(stmt).one_or_none() is not None
