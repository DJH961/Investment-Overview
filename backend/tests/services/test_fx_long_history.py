"""Long EUR/USD history backfill (v7.2): one-year chunks, skip stored years, idempotent.

Mocked HTTP (respx) and a synthetic in-memory database only.
"""

from __future__ import annotations

import sqlite3
from datetime import date
from decimal import Decimal
from pathlib import Path

import httpx
import respx
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from investment_dashboard.adapters.frankfurter_client import (
    BASE_URL,
    FrankfurterError,
    FxRateRecord,
)
from investment_dashboard.models.base import ALL_METADATAS
from investment_dashboard.repositories import fx_repo
from investment_dashboard.services import fx_service


def _resp(rates: dict[str, float]) -> httpx.Response:
    return httpx.Response(
        200, json={"base": "EUR", "rates": {d: {"USD": r} for d, r in rates.items()}}
    )


def test_history_start_is_the_euro_launch() -> None:
    assert date(1999, 1, 4) == fx_service.HISTORY_START


def test_backfill_fetches_missing_years_once(session: Session) -> None:
    # 2002 is already stored end to end: it must not be fetched.
    fx_repo.upsert_rates(
        session, {date(2002, 1, 2): Decimal("0.9"), date(2002, 12, 31): Decimal("1.04")}
    )
    session.flush()
    with respx.mock(assert_all_mocked=True, assert_all_called=True) as mock:
        y2001 = mock.get(f"{BASE_URL}/2001-03-01..2001-12-31").mock(
            return_value=_resp({"2001-03-01": 0.93, "2001-12-31": 0.88})
        )
        y2003 = mock.get(f"{BASE_URL}/2003-01-01..2003-06-10").mock(
            return_value=_resp({"2003-01-02": 1.04, "2003-06-10": 1.17})
        )
        written = fx_service.backfill_long_history(
            session, start=date(2001, 3, 1), today=date(2003, 6, 10)
        )
        session.flush()
    assert (y2001.call_count, y2003.call_count) == (1, 1)
    assert written == 4
    rates = fx_repo.get_rates(session)
    assert rates[date(2001, 3, 1)] == Decimal("0.93")
    assert rates[date(2003, 6, 10)] == Decimal("1.17")

    # Second run: every year present -> no request at all (assert_all_mocked fails on one).
    with respx.mock(assert_all_mocked=True, assert_all_called=False):
        again = fx_service.backfill_long_history(
            session, start=date(2001, 3, 1), today=date(2003, 6, 10)
        )
    assert again == 0


def test_backfill_partial_year_is_refetched_and_manual_rows_kept(session: Session) -> None:
    # 2001 only holds a mid-year manual rate: the year is refetched, the manual row kept.
    fx_repo.upsert_rates(session, {date(2001, 6, 1): Decimal("0.5")}, source=fx_repo.MANUAL_SOURCE)
    session.flush()
    with respx.mock(assert_all_mocked=True) as mock:
        mock.get(f"{BASE_URL}/2001-01-01..2001-12-31").mock(
            return_value=_resp({"2001-01-02": 0.94, "2001-06-01": 0.85, "2001-12-31": 0.88})
        )
        fx_service.backfill_long_history(session, start=date(2001, 1, 1), today=date(2001, 12, 31))
        session.flush()
    rates = fx_repo.get_rates(session)
    assert rates[date(2001, 6, 1)] == Decimal("0.5")
    assert rates[date(2001, 1, 2)] == Decimal("0.94")


def test_backfill_failing_year_is_skipped(session: Session) -> None:
    def fetch(first: date, last: date, **_kw: object) -> list[object]:
        if first.year == 2001:
            raise FrankfurterError("down")
        return []

    assert (
        fx_service.backfill_long_history(
            session,
            start=date(2001, 1, 1),
            today=date(2002, 3, 1),
            fetch=fetch,  # type: ignore[arg-type]
        )
        == 0
    )


def test_settled_rates_ignore_the_live_overlay(session: Session) -> None:
    fx_repo.upsert_rates(session, {date(2024, 1, 2): Decimal("1.09")})
    session.flush()
    fx_service.set_live_spot("USD", Decimal("1.5"), observed_on=date.today())
    try:
        assert fx_service.get_settled_rates(session) == {date(2024, 1, 2): Decimal("1.09")}
    finally:
        fx_service.clear_live_spot()


def test_backfill_releases_the_write_lock_between_years(tmp_path: Path) -> None:
    """Regression (7.2 CI image job): each year is committed before the next fetch.

    The tiers often share one database file; a backfill that held its write lock across
    the network fetches blocked every other writer (login, set-password, the scheduler)
    until it ended. While the second year is being fetched, a separate connection with a
    short busy timeout must be able to write at once.
    """
    db = tmp_path / "shared.sqlite"
    engine = create_engine(f"sqlite:///{db}", future=True)
    for md in ALL_METADATAS:
        md.create_all(engine)
    other_writes: list[bool] = []

    def fetch(first: date, last: date, *, base: str, quote: str) -> list[FxRateRecord]:
        if first.year == 2002:
            other = sqlite3.connect(db, timeout=0.2)
            try:
                other.execute("CREATE TABLE IF NOT EXISTS probe (x INTEGER)")
                other.execute("INSERT INTO probe VALUES (1)")
                other.commit()
                other_writes.append(True)
            except sqlite3.OperationalError:
                other_writes.append(False)
            finally:
                other.close()
        return [FxRateRecord(date=first, base=base, quote=quote, rate=Decimal("1.1"))]

    session = sessionmaker(bind=engine, future=True)()
    try:
        fx_service.backfill_long_history(
            session, start=date(2001, 1, 1), today=date(2002, 12, 31), fetch=fetch
        )
        session.commit()
    finally:
        session.close()
        engine.dispose()
    assert other_writes == [True]
