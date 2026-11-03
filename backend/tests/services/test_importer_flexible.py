"""``importer_service``: flexible-reader fallback, generic broker, saved layouts, content dedupe."""

from __future__ import annotations

import csv
import io
from collections.abc import Iterator
from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.adapters.fidelity.parser import parse_fidelity_csv
from investment_dashboard.adapters.frankfurter_client import FrankfurterError
from investment_dashboard.adapters.generic.parser import (
    GenericParseReport,
    LayoutChoice,
    parse_generic,
)
from investment_dashboard.adapters.vanguard.parser import parse_vanguard_csv
from investment_dashboard.config import get_settings
from investment_dashboard.db import dispose_engines, get_ledger_engine
from investment_dashboard.models import ALL_METADATAS, Transaction
from investment_dashboard.repositories import accounts_repo
from investment_dashboard.services import (
    fx_service,
    importer_service,
    instrument_enrichment_service,
    settings_service,
)
from investment_dashboard.services.importer_service import (
    BROKER_LABELS,
    COLUMN_PROFILES_KEY,
    Broker,
    choice_from_json,
    choice_to_json,
    content_key,
    import_csv,
    mark_duplicates,
    saved_layout,
)

FIXTURES = Path(__file__).parents[1] / "adapters" / "fixtures"
D = Decimal


@pytest.fixture(autouse=True)
def _offline() -> Iterator[None]:
    with (
        patch.object(fx_service, "fetch_rates", side_effect=FrankfurterError("offline")),
        patch.object(instrument_enrichment_service, "fetch_instrument_info", return_value=None),
    ):
        yield


@pytest.fixture(autouse=True)
def _settings_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """A real settings store so saved layouts can be written and read."""
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(tmp_path / "app.sqlite"))
    for tier in ("LEDGER", "CONFIG", "CACHE"):
        monkeypatch.delenv(f"INV_DASHBOARD_{tier}_PATH", raising=False)
    get_settings.cache_clear()
    dispose_engines()
    engine = get_ledger_engine()
    for metadata in ALL_METADATAS:
        metadata.create_all(engine)
    settings_service.invalidate()
    try:
        yield
    finally:
        settings_service.invalidate()
        dispose_engines()
        get_settings.cache_clear()


def _account(session: Session, broker: str) -> int:
    return accounts_repo.create_account(
        session,
        broker=broker,
        account_label=broker.title(),
        native_currency="USD",
        account_type="brokerage",
    ).id


@pytest.fixture
def fidelity_account(session: Session) -> int:
    return _account(session, "fidelity")


@pytest.fixture
def vanguard_account(session: Session) -> int:
    return _account(session, "vanguard")


@pytest.fixture
def generic_account(session: Session) -> int:
    return _account(session, "savings_bank")


def _ledger(session: Session, account_id: int) -> list[Transaction]:
    return list(
        session.scalars(
            select(Transaction)
            .where(Transaction.account_id == account_id)
            .order_by(Transaction.date, Transaction.id)
        )
    )


def _fidelity_renamed() -> str:
    """The Fidelity sample with 'Run Date' -> 'Date' and the columns reordered."""
    text = (FIXTURES / "fidelity_sample.csv").read_text()
    body = text[text.index("Run Date") :]
    rows = [r for r in csv.reader(io.StringIO(body)) if any(c.strip() for c in r)]
    header = ["Date" if h == "Run Date" else h for h in rows[0]]
    order = list(reversed(range(len(header))))
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    for r in [header, *rows[1:]]:
        w.writerow([r[i] for i in order])
    return out.getvalue()


_GENERIC = (
    "Date,Action,Symbol,Quantity,Price,Amount\n"
    "01/15/2024,Buy,VWRL,10,100.00,-1000.00\n"
    "01/20/2024,Buy,VWRL,5,102.00,-510.00\n"
    "02/15/2024,Sell,VWRL,-4,110.00,440.00\n"
    "03/01/2024,Deposit,,,,2000.00\n"
)


class TestBrokerEnum:
    def test_generic_broker_is_listed_with_label(self) -> None:
        assert Broker.GENERIC.value == "generic"
        assert BROKER_LABELS[Broker.GENERIC] == "Other / any file"


class TestFallbackToFlexible:
    def test_renamed_fidelity_columns_use_flexible_reader(
        self, session: Session, fidelity_account: int
    ) -> None:
        content = _fidelity_renamed()
        strict_ok = True
        try:
            parse_fidelity_csv(content)
        except ValueError:
            strict_ok = False
        assert not strict_ok, "fixture should defeat the strict parser"

        report = importer_service._parse(Broker.FIDELITY, content)
        assert isinstance(report, GenericParseReport)
        assert any("flexible importer" in w.message for w in report.warnings)
        assert len(report.rows) == 6
        assert not report.errors

        result = import_csv(
            session, broker=Broker.FIDELITY, account_id=fidelity_account, content=content
        )
        assert result.inserted == 6
        assert any("flexible importer" in w.message for w in result.warnings)
        kinds = sorted(t.kind for t in _ledger(session, fidelity_account))
        assert kinds == sorted(
            ["buy", "dividend_cash", "dividend_reinvest", "deposit", "interest", "sell"]
        )

    def test_normal_fidelity_file_still_uses_strict_parser(self) -> None:
        text = (FIXTURES / "fidelity_sample.csv").read_text()
        report = importer_service._parse(Broker.FIDELITY, text)
        assert not isinstance(report, GenericParseReport)
        assert not any("flexible" in w.message for w in report.warnings)
        assert [r.external_id for r in report.rows] == [
            r.external_id for r in parse_fidelity_csv(text).rows
        ]
        assert all(r.source == "import_fidelity_csv" for r in report.rows)

    def test_normal_vanguard_file_still_uses_strict_parser(self) -> None:
        text = (FIXTURES / "vanguard_sample.csv").read_text()
        report = importer_service._parse(Broker.VANGUARD, text)
        assert not isinstance(report, GenericParseReport)
        assert not any("flexible" in w.message for w in report.warnings)
        assert [r.external_id for r in report.rows] == [
            r.external_id for r in parse_vanguard_csv(text).rows
        ]

    def test_bytes_input_with_bom_still_strict(self) -> None:
        raw = b"\xef\xbb\xbf" + (FIXTURES / "vanguard_sample.csv").read_bytes()
        report = importer_service._parse(Broker.VANGUARD, raw)
        assert not isinstance(report, GenericParseReport)

    def test_unreadable_file_raises_value_error(self) -> None:
        with pytest.raises(ValueError, match="empty"):
            importer_service._parse(Broker.FIDELITY, b"")


class TestGenericBroker:
    def test_import_inserts_with_generic_source(
        self, session: Session, generic_account: int
    ) -> None:
        result = import_csv(
            session, broker=Broker.GENERIC, account_id=generic_account, content=_GENERIC
        )
        assert result.inserted == 4
        assert result.duplicates == 0
        rows = _ledger(session, generic_account)
        assert {t.source for t in rows} == {"import_generic"}
        assert [t.kind for t in rows] == ["buy", "buy", "sell", "deposit"]
        assert rows[0].net_native == D("-1000.00")

    def test_reimport_inserts_nothing(self, session: Session, generic_account: int) -> None:
        import_csv(session, broker=Broker.GENERIC, account_id=generic_account, content=_GENERIC)
        again = import_csv(
            session, broker=Broker.GENERIC, account_id=generic_account, content=_GENERIC
        )
        assert again.inserted == 0
        assert again.duplicates == 4
        assert len(_ledger(session, generic_account)) == 4

    def test_reformatted_file_is_still_duplicate(
        self, session: Session, generic_account: int
    ) -> None:
        import_csv(session, broker=Broker.GENERIC, account_id=generic_account, content=_GENERIC)
        eu = (
            "Datum;Transaktionsart;Symbol;Anzahl;Kurs;Betrag\n"
            "15.01.2024;Kauf;VWRL;10;100,00;-1.000,00\n"
            "20.01.2024;Kauf;VWRL;5;102,00;-510,00\n"
            "15.02.2024;Verkauf;VWRL;4;110,00;440,00\n"
            "01.03.2024;Einzahlung;;;;2.000,00\n"
        )
        again = import_csv(session, broker=Broker.GENERIC, account_id=generic_account, content=eu)
        assert again.inserted == 0
        assert again.duplicates == 4

    def test_explicit_layout_choice_is_used(self, session: Session, generic_account: int) -> None:
        content = (
            "When,Kind,Sym,N,Cash\n01/15/2024,Buy,VWRL,10,-1000.00\n01/16/2024,Buy,VWRL,5,-510.00\n"
        )
        choice = LayoutChoice(
            header_row=0,
            columns={
                "date": "When",
                "action": "Kind",
                "symbol": "Sym",
                "quantity": "N",
                "amount": "Cash",
            },
        )
        result = import_csv(
            session,
            broker=Broker.GENERIC,
            account_id=generic_account,
            content=content,
            layout=choice,
        )
        assert result.inserted == 2


class TestContentDedupe:
    def test_vanguard_csv_then_reformatted_generic_file_inserts_nothing(
        self, session: Session, vanguard_account: int
    ) -> None:
        text = (FIXTURES / "vanguard_sample.csv").read_text()
        first = import_csv(
            session, broker=Broker.VANGUARD, account_id=vanguard_account, content=text
        )
        assert first.inserted > 0
        before = len(_ledger(session, vanguard_account))

        names = {
            "buy": "Buy",
            "sell": "Sell",
            "dividend_cash": "Dividend",
            "dividend_reinvest": "Dividend reinvestment",
            "deposit": "Deposit",
            "interest": "Interest",
        }
        parsed = parse_vanguard_csv(text).rows
        lines = ["Datum;Transaktionsart;Symbol;Anzahl;Kurs;Betrag"]
        for r in parsed:
            lines.append(
                ";".join(
                    [
                        f"{r.date:%d.%m.%Y}",
                        names[r.kind],
                        r.symbol or "",
                        "" if r.quantity is None else str(r.quantity).replace(".", ","),
                        "" if r.price_native is None else str(r.price_native).replace(".", ","),
                        str(r.net_native).replace(".", ","),
                    ]
                )
            )
        second = import_csv(
            session,
            broker=Broker.GENERIC,
            account_id=vanguard_account,
            content="\n".join(lines) + "\n",
        )
        assert second.inserted == 0, second.errors
        assert second.duplicates == len(parsed)
        assert len(_ledger(session, vanguard_account)) == before

    def test_only_one_of_two_identical_trades_is_new(
        self, session: Session, generic_account: int
    ) -> None:
        one = "Date,Action,Symbol,Quantity,Price,Amount\n01/15/2024,Buy,VWRL,10,100.00,-1000.00\n"
        import_csv(session, broker=Broker.GENERIC, account_id=generic_account, content=one)
        two = one + "01/15/2024,Buy,VWRL,10,100.00,-1000.00\n"
        result = import_csv(session, broker=Broker.GENERIC, account_id=generic_account, content=two)
        assert result.inserted == 1
        assert result.duplicates == 1
        assert len(_ledger(session, generic_account)) == 2

    def test_identical_trades_match_existing_by_content_not_id(
        self, session: Session, generic_account: int
    ) -> None:
        # The first import carries a description, so its external_id differs.
        first = (
            "Date,Action,Symbol,Quantity,Price,Amount,Description\n"
            "01/15/2024,Buy,VWRL,10,100.00,-1000.00,Order 1\n"
        )
        import_csv(session, broker=Broker.GENERIC, account_id=generic_account, content=first)
        two = (
            "Date,Action,Symbol,Quantity,Price,Amount\n"
            "01/15/2024,Buy,VWRL,10,100.00,-1000.00\n"
            "01/15/2024,Buy,VWRL,10,100.00,-1000.00\n"
        )
        result = import_csv(session, broker=Broker.GENERIC, account_id=generic_account, content=two)
        assert result.inserted == 1
        assert result.duplicates == 1

    def test_mark_duplicates_each_existing_row_absorbs_one(self) -> None:
        rows = parse_generic(
            "Date,Action,Symbol,Quantity,Price,Amount\n01/15/2024,Buy,VWRL,10,100.00,-1000.00\n" * 3
        ).rows
        key = content_key(date(2024, 1, 15), "buy", "VWRL", D(10), D("-1000.00"))
        from collections import Counter

        assert mark_duplicates(rows, set(), Counter({key: 2})) == [True, True, False]

    def test_content_key_rounds_and_uppercases(self) -> None:
        a = content_key(date(2024, 1, 15), "buy", "vwrl", D("10.00001"), D("-1000.004"))
        b = content_key(date(2024, 1, 15), "buy", "VWRL", D("10"), D("-1000.00"))
        assert a == b


class TestSavedLayouts:
    def test_choice_json_round_trip(self) -> None:
        choice = LayoutChoice(
            columns={"date": 0, "amount": "Cash", "price": None},
            decimal=",",
            date_order="DMY",
            derive=frozenset({"price"}),
        )
        raw = choice_to_json(choice, ["When", "Kind", "Cash"])
        back = choice_from_json(raw)
        assert back is not None
        assert back.columns == {"date": "When", "amount": "Cash", "price": None}
        assert back.decimal == ","
        assert back.date_order == "DMY"
        assert back.derive == frozenset({"price"})

    def test_choice_from_json_rejects_garbage(self) -> None:
        assert choice_from_json("not json") is None
        assert choice_from_json("[1, 2]") is None
        back = choice_from_json('{"decimal": "x", "date_order": "ZZZ", "derive": ["nope"]}')
        assert back is not None
        assert back.decimal is None
        assert back.date_order is None
        assert back.derive == frozenset()

    def test_saved_layout_empty_signature_or_unknown(self) -> None:
        assert saved_layout("") is None
        assert saved_layout("nothing|here") is None

    def test_saved_layout_is_applied_automatically(
        self, session: Session, generic_account: int
    ) -> None:
        content = (
            "Date,Action,Symbol,Quantity,Price,Amount\n"
            "01/05/2024,Buy,VWRL,10,100.00,-1000.00\n"
            "02/03/2024,Buy,VWRL,5,100.00,-500.00\n"
        )
        # Without a saved layout the file is ambiguous (asks) and read as US dates.
        plain = importer_service._parse(Broker.GENERIC, content)
        assert isinstance(plain, GenericParseReport)
        assert plain.layout is not None
        assert [q.field for q in plain.layout.questions] == ["date_order"]
        assert plain.rows[0].date == date(2024, 1, 5)

        headers = [c.header for c in plain.layout.columns]
        settings_service.set_many(
            {
                COLUMN_PROFILES_KEY: {
                    plain.layout.signature: choice_to_json(LayoutChoice(date_order="DMY"), headers)
                }
            },
            actor="test",
        )
        assert saved_layout(plain.layout.signature) is not None

        saved = importer_service._parse(Broker.GENERIC, content)
        assert isinstance(saved, GenericParseReport)
        assert saved.layout is not None
        assert saved.layout.questions == ()
        assert saved.rows[0].date == date(2024, 5, 1)
        assert saved.rows[1].date == date(2024, 3, 2)

        result = import_csv(
            session, broker=Broker.GENERIC, account_id=generic_account, content=content
        )
        assert result.inserted == 2
        assert [t.date for t in _ledger(session, generic_account)] == [
            date(2024, 3, 2),
            date(2024, 5, 1),
        ]

    def test_saved_layout_matches_regardless_of_column_order(self) -> None:
        a = "Date,Action,Symbol,Quantity,Price,Amount\n01/05/2024,Buy,VWRL,10,100.00,-1000.00\n"
        b = "Amount,Price,Quantity,Symbol,Action,Date\n-1000.00,100.00,10,VWRL,Buy,01/05/2024\n"
        sig_a = parse_generic(a).layout.signature  # type: ignore[union-attr]
        sig_b = parse_generic(b).layout.signature  # type: ignore[union-attr]
        assert sig_a == sig_b != ""
