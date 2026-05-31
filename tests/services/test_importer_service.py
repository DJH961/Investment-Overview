"""End-to-end test of ``importer_service.import_csv``."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.adapters.frankfurter_client import FrankfurterError
from investment_dashboard.models import Transaction
from investment_dashboard.repositories import accounts_repo, fx_repo
from investment_dashboard.services import fx_service
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

    def test_net_usd_frozen_as_native_for_usd_account(
        self, session: Session, usd_account: int, fx_seeded: None
    ) -> None:
        # USD is the booked currency, so net_usd must equal net_native
        # *exactly* (no FX round-trip), per the v2.9 USD-native perspective.
        content = (FIXTURE_DIR / "fidelity_sample.csv").read_text()
        import_csv(session, broker=Broker.FIDELITY, account_id=usd_account, content=content)
        for txn in session.scalars(select(Transaction)).all():
            if txn.net_native is not None:
                assert txn.net_usd == txn.net_native

    def test_fx_missing_dates_reported_without_history(
        self, session: Session, usd_account: int
    ) -> None:
        # No FX history seeded and the network is unavailable, so the EUR leg
        # can't be derived: the importer must surface the gap (rather than
        # silently freezing a wrong number) while still inserting rows. The
        # offline condition is simulated by making the Frankfurter fetch fail,
        # so the result is deterministic in CI (which has network) too.
        content = (FIXTURE_DIR / "fidelity_sample.csv").read_text()
        with patch.object(fx_service, "fetch_rates", side_effect=FrankfurterError("offline")):
            result = import_csv(
                session, broker=Broker.FIDELITY, account_id=usd_account, content=content
            )
        assert result.inserted == 6
        assert result.fx_missing_dates  # non-empty
        # USD leg is still exact even when EUR can't be derived.
        buy = session.scalars(select(Transaction).where(Transaction.kind == "buy")).one()
        assert buy.net_usd == buy.net_native
        assert buy.net_eur is None

    def test_eur_account_freezes_usd_leg(self, session: Session, fx_seeded: None) -> None:
        # For an EUR-native account, net_eur == net_native and net_usd is
        # derived at the trade-date rate.
        eur_account = accounts_repo.create_account(
            session,
            broker="fidelity",
            account_label="Fidelity EUR",
            native_currency="EUR",
            account_type="brokerage",
        ).id
        content = (FIXTURE_DIR / "fidelity_sample.csv").read_text()
        import_csv(session, broker=Broker.FIDELITY, account_id=eur_account, content=content)
        buy = session.scalars(select(Transaction).where(Transaction.kind == "buy")).one()
        assert buy.net_eur == buy.net_native
        assert buy.net_usd is not None
        # net_usd = net_native × EUR→USD on the trade date (2024-01-05 ⇒ 1.08).
        assert buy.net_usd == buy.net_native * Decimal("1.08")
        # fx_rate_to_eur is the EUR→native rate, which for an EUR account is 1.
        assert buy.fx_rate_to_eur == Decimal(1)


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


class TestImportVanguardXlsx:
    """v1.4: Vanguard Full-History XLSX import (the >18-month workaround)."""

    @staticmethod
    def _xlsx_bytes() -> bytes:
        # Build a tiny in-memory workbook in the Full-History layout.
        from io import BytesIO

        import openpyxl

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(("Custom report created on: 05/27/2026.",))
        ws.append(("Settled from 01/01/2024 to 05/27/2026.",))
        ws.append(())
        ws.append(
            (
                "Settlement date",
                "Trade date",
                "Symbol",
                "Name",
                "Transaction type",
                "Account type",
                "Quantity",
                "Price",
                "Commission & fees**",
                "Amount",
            )
        )
        ws.append(
            (
                "01/05/2024",
                "01/05/2024",
                "VMFXX",
                "Vanguard Federal Money Market Fund (Settlement Fund)",
                "Sweep in",
                "CASH",
                "",
                "",
                "",
                "-$1,100.0000",
            )
        )
        ws.append(
            (
                "01/05/2024",
                "01/05/2024",
                "",
                "To: SAMPLE BANK, NA",
                "Funds Received",
                "CASH",
                "",
                "",
                "",
                "$1,100.0000",
            )
        )
        ws.append(
            (
                "01/05/2024",
                "01/03/2024",
                "VTI",
                "VANGUARD TOTAL STOCK MARKET ETF",
                "Buy",
                "CASH",
                "5.0000",
                "$220.0000",
                "Free",
                "-$1,100.0000",
            )
        )
        buf = BytesIO()
        wb.save(buf)
        return buf.getvalue()

    def test_import_dispatches_on_zip_magic(
        self, session: Session, usd_account: int, fx_seeded: None
    ) -> None:
        result = import_csv(
            session,
            broker=Broker.VANGUARD,
            account_id=usd_account,
            content=self._xlsx_bytes(),
        )
        assert result.inserted == 2  # Buy + Funds Received
        assert result.sweeps_dropped == 1
        assert result.unknown_actions == []

    def test_reimport_dedupes(self, session: Session, usd_account: int, fx_seeded: None) -> None:
        data = self._xlsx_bytes()
        import_csv(session, broker=Broker.VANGUARD, account_id=usd_account, content=data)
        result = import_csv(session, broker=Broker.VANGUARD, account_id=usd_account, content=data)
        assert result.inserted == 0
        assert result.duplicates == 2
