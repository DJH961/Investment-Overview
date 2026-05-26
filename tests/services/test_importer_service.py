"""End-to-end test of ``importer_service.import_csv``."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import accounts_repo, fx_repo
from investment_dashboard.services.importer_service import Broker, import_csv

FIXTURE_DIR = Path(__file__).parents[1] / "adapters" / "fixtures"


def _seed_usd_account(session: Session) -> int:
    return accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    ).id


@pytest.fixture
def usd_account(session: Session) -> int:
    return _seed_usd_account(session)


@pytest.fixture
def fx_seeded(session: Session) -> None:
    """Provide a sensible EUR/USD rate so net_eur is populated."""
    fx_repo.upsert_rates(
        session,
        {
            date(2024, 1, 5): Decimal("1.08"),
            date(2024, 2, 15): Decimal("1.07"),
            date(2024, 3, 1): Decimal("1.085"),
            date(2024, 3, 15): Decimal("1.09"),
            date(2024, 4, 1): Decimal("1.08"),
        },
    )


class TestImportFidelity:
    def test_import_inserts_six_rows(
        self, session: Session, usd_account: int, fx_seeded: None
    ) -> None:
        content = (FIXTURE_DIR / "fidelity_sample.csv").read_text()
        result = import_csv(
            session, broker=Broker.FIDELITY, account_id=usd_account, content=content
        )
        assert result.inserted == 6
        assert result.duplicates == 0

    def test_reimport_dedupes(self, session: Session, usd_account: int, fx_seeded: None) -> None:
        content = (FIXTURE_DIR / "fidelity_sample.csv").read_text()
        import_csv(session, broker=Broker.FIDELITY, account_id=usd_account, content=content)
        result = import_csv(
            session, broker=Broker.FIDELITY, account_id=usd_account, content=content
        )
        assert result.inserted == 0
        assert result.duplicates == 6

    def test_net_eur_populated(self, session: Session, usd_account: int, fx_seeded: None) -> None:
        content = (FIXTURE_DIR / "fidelity_sample.csv").read_text()
        import_csv(session, broker=Broker.FIDELITY, account_id=usd_account, content=content)
        buy = session.scalars(select(Transaction).where(Transaction.kind == "buy")).one()
        # -2205 USD at 1.08 ⇒ -2041.67 EUR
        assert buy.net_eur is not None
        assert abs(buy.net_eur - Decimal("-2041.67")) < Decimal("0.05")


class TestImportVanguard:
    def test_import_drops_sweeps(self, session: Session, usd_account: int, fx_seeded: None) -> None:
        content = (FIXTURE_DIR / "vanguard_sample.csv").read_text()
        result = import_csv(
            session, broker=Broker.VANGUARD, account_id=usd_account, content=content
        )
        # 5 ledger rows (Buy, Dividend, Reinvestment, Funds Received, Sell);
        # 2 sweep rows dropped.
        assert result.inserted == 5
        assert result.sweeps_dropped == 2
