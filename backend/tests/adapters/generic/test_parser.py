"""``parse_generic``: the flexible transaction-file parser."""

from __future__ import annotations

import io
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import openpyxl
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from investment_dashboard.adapters.generic.parser import (
    GenericParseReport,
    LayoutChoice,
    parse_generic,
)
from investment_dashboard.adapters.importer_types import ParsedTransactionRow
from investment_dashboard.adapters.tabular.reader import UnreadableFileError
from investment_dashboard.adapters.vanguard.action_map import map_transaction_type
from investment_dashboard.adapters.vanguard.parser import parse_vanguard_csv

FIXTURES = Path(__file__).parents[1] / "fixtures"
D = Decimal

US_HEADER = "Date,Action,Symbol,Quantity,Price,Amount\n"


def _questions(report: GenericParseReport) -> dict[str, bool]:
    assert report.layout is not None
    return {q.field: q.can_derive for q in report.layout.questions}


# -- locale: EU numbers and dates ------------------------------------------------------


def test_eu_numbers_and_dmy_dates() -> None:
    text = (
        "Buchungstag;Transaktionsart;Symbol;Anzahl;Kurs;Betrag\n"
        "15.01.2024;Kauf;VWRL;10;1.080,50;-10.805,00\n"
        "25.02.2024;Verkauf;VWRL;4;1.100,25;4.401,00\n"
    )
    report = parse_generic(text)
    assert not report.errors
    assert report.layout is not None
    assert report.layout.decimal == ","
    assert report.layout.date_order == "DMY"
    buy, sell = report.rows
    assert (buy.date, buy.kind, buy.symbol) == (date(2024, 1, 15), "buy", "VWRL")
    assert (buy.quantity, buy.price_native, buy.net_native) == (D(10), D("1080.50"), D("-10805.00"))
    assert (sell.date, sell.kind) == (date(2024, 2, 25), "sell")
    assert (sell.quantity, sell.net_native) == (D(-4), D("4401.00"))


def test_eu_defaults_to_dmy_when_dates_ambiguous() -> None:
    text = "Datum;Art;Symbol;Anzahl;Kurs;Betrag\n02.03.2024;Kauf;VWRL;1;10,00;-10,00\n"
    report = parse_generic(text, date_order_default="DMY")
    assert report.rows[0].date == date(2024, 3, 2)


# -- signs ---------------------------------------------------------------------------


def test_unsigned_amounts_get_signs_from_kind() -> None:
    text = US_HEADER + (
        "01/15/2024,Buy,VTI,10,220.00,2200.00\n"
        "01/16/2024,Sell,VTI,5,225.00,1125.00\n"
        "01/17/2024,Dividend,VTI,,,15.00\n"
        "01/18/2024,Deposit,,,,1000.00\n"
        "01/19/2024,Withdrawal,,,,500.00\n"
        "01/20/2024,Fee,,,,5.00\n"
        "01/21/2024,Interest,,,,2.50\n"
    )
    report = parse_generic(text)
    assert not report.errors
    got = {r.kind: r.net_native for r in report.rows}
    assert got == {
        "buy": D("-2200.00"),
        "sell": D("1125.00"),
        "dividend_cash": D("15.00"),
        "deposit": D("1000.00"),
        "withdrawal": D("-500.00"),
        "fee": D("-5.00"),
        "interest": D("2.50"),
    }


def test_signed_amounts_are_kept() -> None:
    text = US_HEADER + (
        "01/15/2024,Buy,VTI,10,220.00,-2200.00\n01/16/2024,Sell,VTI,-5,225.00,1125.00\n"
    )
    buy, sell = parse_generic(text).rows
    assert buy.net_native == D("-2200.00")
    assert sell.net_native == D("1125.00")


def test_sell_quantities_are_negative_whatever_the_file_says() -> None:
    positive = US_HEADER + "01/16/2024,Sell,VTI,5,225.00,1125.00\n"
    negative = US_HEADER + "01/16/2024,Sell,VTI,-5,225.00,1125.00\n"
    assert parse_generic(positive).rows[0].quantity == D(-5)
    assert parse_generic(negative).rows[0].quantity == D(-5)


def test_buy_quantity_is_positive() -> None:
    text = US_HEADER + "01/15/2024,Buy,VTI,-10,220.00,-2200.00\n"
    assert parse_generic(text).rows[0].quantity == D(10)


# -- questions: missing price / quantity / amount -----------------------------------------


def test_missing_price_asks_and_can_derive() -> None:
    text = "Date,Action,Symbol,Quantity,Amount\n01/15/2024,Buy,VTI,10,-2200.00\n"
    report = parse_generic(text)
    assert _questions(report) == {"price": True}
    assert report.rows[0].price_native is None
    assert report.layout is not None
    assert not report.layout.missing


def test_derive_price_for_buy_takes_fees_out_and_sell_adds_them_back() -> None:
    text = (
        "Date,Action,Symbol,Quantity,Fees,Amount\n"
        "01/15/2024,Buy,VTI,10,5.00,-2205.00\n"
        "01/16/2024,Sell,VTI,-5,0.50,1124.50\n"
    )
    report = parse_generic(text, choice=LayoutChoice(derive=frozenset({"price"})))
    assert _questions(report) == {}
    assert report.layout is not None
    assert report.layout.derive == ("price",)
    buy, sell = report.rows
    assert buy.price_native == D("220")
    assert sell.price_native == D("225")


def test_derive_price_for_sell_with_positive_quantity() -> None:
    text = "Date,Action,Symbol,Quantity,Fees,Amount\n01/16/2024,Sell,VTI,5,0.50,1124.50\n"
    row = parse_generic(text, choice=LayoutChoice(derive=frozenset({"price"}))).rows[0]
    assert row.quantity == D(-5)
    assert row.price_native == D("225")


def test_missing_quantity_asks_and_can_derive() -> None:
    text = "Date,Action,Symbol,Price,Amount\n01/15/2024,Buy,VTI,220.00,-2200.00\n"
    report = parse_generic(text)
    assert _questions(report) == {"quantity": True}
    derived = parse_generic(text, choice=LayoutChoice(derive=frozenset({"quantity"})))
    assert _questions(derived) == {}
    assert derived.rows[0].quantity == D(10)


def test_no_amount_no_price_cannot_derive() -> None:
    text = "Date,Action,Symbol,Quantity\n01/15/2024,Buy,VTI,10\n"
    report = parse_generic(text)
    assert report.layout is not None
    assert "amount" in report.layout.missing
    assert _questions(report)["amount"] is False
    assert report.rows == []
    assert report.errors


def test_no_amount_but_quantity_and_price_can_derive_amount() -> None:
    text = "Date,Action,Symbol,Quantity,Price\n01/15/2024,Buy,VTI,10,220.00\n"
    report = parse_generic(text)
    assert _questions(report) == {"amount": True}
    assert report.layout is not None
    assert report.layout.missing == ()
    derived = parse_generic(text, choice=LayoutChoice(derive=frozenset({"amount"})))
    assert _questions(derived) == {}
    assert derived.rows[0].net_native == D("-2200.00")


def test_missing_date_column_asks_and_parses_nothing() -> None:
    text = "Action,Symbol,Quantity,Price,Amount\nBuy,VTI,10,220.00,-2200.00\n"
    report = parse_generic(text)
    assert report.rows == []
    assert "date" in _questions(report)
    assert report.layout is not None
    assert "date" in report.layout.missing


# -- date order -----------------------------------------------------------------------


_AMBIGUOUS = US_HEADER + (
    "01/05/2024,Buy,VTI,10,220.00,-2200.00\n02/03/2024,Buy,VTI,10,220.00,-2200.00\n"
)


def test_ambiguous_dates_ask_for_the_order() -> None:
    assert "date_order" in _questions(parse_generic(_AMBIGUOUS))


def test_date_order_default_silences_question() -> None:
    report = parse_generic(_AMBIGUOUS, date_order_default="MDY")
    assert "date_order" not in _questions(report)
    assert report.rows[0].date == date(2024, 1, 5)


def test_choice_date_order_answers_question() -> None:
    report = parse_generic(_AMBIGUOUS, choice=LayoutChoice(date_order="DMY"))
    assert "date_order" not in _questions(report)
    assert report.rows[0].date == date(2024, 5, 1)
    assert report.rows[1].date == date(2024, 3, 2)


def test_unambiguous_dates_no_question() -> None:
    report = parse_generic(US_HEADER + "01/15/2024,Buy,VTI,10,220.00,-2200.00\n")
    assert "date_order" not in _questions(report)
    assert report.layout is not None
    assert report.layout.date_order == "MDY"


def test_iso_dates() -> None:
    report = parse_generic(US_HEADER + "2024-01-05,Buy,VTI,10,220.00,-2200.00\n")
    assert report.rows[0].date == date(2024, 1, 5)
    assert report.layout is not None
    assert report.layout.date_order == "YMD"


# -- no action column ------------------------------------------------------------------


def test_no_action_column_guesses_kinds_and_warns() -> None:
    text = (
        "Date,Symbol,Quantity,Price,Amount\n"
        "01/15/2024,VTI,10,220.00,-2200.00\n"
        "01/16/2024,VTI,-5,225.00,1125.00\n"
        "01/17/2024,,,,1000.00\n"
        "01/18/2024,,,,-50.00\n"
    )
    report = parse_generic(text)
    assert [r.kind for r in report.rows] == ["buy", "sell", "deposit", "withdrawal"]
    assert report.warnings
    assert "no action" in report.warnings[0].message


# -- idempotency / duplicates ------------------------------------------------------------


def test_identical_rows_get_distinct_stable_external_ids() -> None:
    text = US_HEADER + (
        "01/15/2024,Buy,VTI,10,220.00,-2200.00\n"
        "01/15/2024,Buy,VTI,10,220.00,-2200.00\n"
        "01/15/2024,Buy,VTI,10,220.00,-2200.00\n"
        "01/16/2024,Buy,VTI,1,220.00,-220.00\n"
    )
    ids = [r.external_id for r in parse_generic(text).rows]
    assert len(ids) == 4
    assert len(set(ids)) == 4
    assert [r.external_id for r in parse_generic(text).rows] == ids


def test_external_id_independent_of_column_order() -> None:
    a = US_HEADER + "01/15/2024,Buy,VTI,10,220.00,-2200.00\n"
    b = "Amount,Price,Quantity,Symbol,Action,Date\n-2200.00,220.00,10,VTI,Buy,01/15/2024\n"
    assert parse_generic(a).rows[0].external_id == parse_generic(b).rows[0].external_id


def test_source_label() -> None:
    text = US_HEADER + "01/15/2024,Buy,VTI,10,220.00,-2200.00\n"
    assert parse_generic(text).rows[0].source == "import_generic"
    assert parse_generic(text, source="custom").rows[0].source == "custom"


# -- noise rows ----------------------------------------------------------------------


def test_footers_blank_lines_and_repeated_headers_are_skipped_short_file() -> None:
    text = (
        "Account report for John\n"
        "\n"
        + US_HEADER
        + "01/15/2024,Buy,VTI,10,220.00,-2200.00\n"
        + "\n"
        + US_HEADER  # header repeated on page 2
        + "01/16/2024,Sell,VTI,-5,225.00,1125.00\n"
        + ",,,,,3.00\n"  # subtotal without a date
        + "Disclaimer: past performance is no guarantee,,,,,\n"
        + "Generated by BrokerX,,,,,\n"
    )
    report = parse_generic(text)
    assert report.errors == []
    assert [r.kind for r in report.rows] == ["buy", "sell"]


def test_footers_and_repeated_headers_are_skipped_in_a_longer_file() -> None:
    nl = chr(10)
    rows = "".join(f"01/{d:02d}/2024,Buy,VTI,1,10.00,-10.00" + nl for d in range(10, 25))
    text = (
        "Account report for John"
        + nl
        + nl
        + US_HEADER
        + rows
        + nl
        + US_HEADER  # header repeated on page 2
        + "01/26/2024,Sell,VTI,-5,225.00,1125.00"
        + nl
        + ",,,,,3.00"
        + nl  # subtotal without a date
        + "Disclaimer: past performance is no guarantee,,,,,"
        + nl
        + "Generated by BrokerX,,,,,"
        + nl
    )
    report = parse_generic(text)
    assert report.errors == []
    assert len(report.rows) == 16
    assert report.rows[-1].kind == "sell"


def test_junk_number_on_dated_row_is_an_error_not_a_crash() -> None:
    text = US_HEADER + (
        "01/15/2024,Buy,VTI,abc,220.00,-2200.00\n01/16/2024,Buy,VTI,1,220.00,-220.00\n"
    )
    report = parse_generic(text)
    assert len(report.errors) == 1
    assert len(report.rows) == 1
    assert report.rows[0].date == date(2024, 1, 16)


def test_unknown_action_is_reported() -> None:
    report = parse_generic(US_HEADER + "01/15/2024,Frobnicate,VTI,10,220.00,-2200.00\n")
    assert report.unknown_actions == ["Frobnicate"]
    assert report.rows == []


def test_action_overrides_apply() -> None:
    text = US_HEADER + "01/15/2024,Frobnicate,VTI,10,220.00,-2200.00\n"
    assert parse_generic(text, action_overrides={"Frobnicate": "buy"}).rows[0].kind == "buy"


def test_sweeps_are_dropped_and_counted() -> None:
    text = US_HEADER + "01/15/2024,Sweep in,,,,10.00\n01/15/2024,Buy,VTI,1,10.00,-10.00\n"
    report = parse_generic(text)
    assert report.sweeps_dropped == 1
    assert len(report.rows) == 1


def test_empty_and_binary_raise() -> None:
    with pytest.raises(UnreadableFileError):
        parse_generic(b"")
    with pytest.raises(UnreadableFileError):
        parse_generic(b"\xd0\xcf\x11\xe0" + b"\x00" * 50)


# -- LayoutChoice ------------------------------------------------------------------------

_ODD = (
    "When,What,Sym,N,Px,Cash\n"
    "01/15/2024,Buy,VTI,10,220.00,-2200.00\n"
    "01/16/2024,Sell,VTI,-5,225.00,1125.00\n"
)
_ODD_BY_NAME = {
    "date": "When",
    "action": "what",  # case-insensitive
    "symbol": "Sym",
    "quantity": "N",
    "price": "Px",
    "amount": "Cash",
}


def test_choice_columns_by_header_name() -> None:
    report = parse_generic(_ODD, choice=LayoutChoice(header_row=0, columns=_ODD_BY_NAME))
    assert not report.errors
    buy, sell = report.rows
    assert (buy.symbol, buy.quantity, buy.price_native, buy.net_native) == (
        "VTI",
        D(10),
        D("220.00"),
        D("-2200.00"),
    )
    assert sell.kind == "sell"
    assert report.layout is not None
    assert all(c.by == "user" for c in report.layout.columns if c.field)


def test_choice_columns_by_index() -> None:
    by_index = parse_generic(
        _ODD,
        choice=LayoutChoice(
            header_row=0,
            columns={"date": 0, "action": 1, "symbol": 2, "quantity": 3, "price": 4, "amount": 5},
        ),
    )
    by_name = parse_generic(_ODD, choice=LayoutChoice(header_row=0, columns=_ODD_BY_NAME))
    assert len(by_index.rows) == 2
    assert by_index.rows == by_name.rows


def test_choice_none_removes_a_detected_column() -> None:
    report = parse_generic(
        US_HEADER + "01/15/2024,Buy,VTI,10,220.00,-2200.00\n",
        choice=LayoutChoice(columns={"price": None}),
    )
    assert report.rows[0].price_native is None
    assert _questions(report) == {"price": True}


def test_unknown_choice_field_is_ignored() -> None:
    report = parse_generic(
        US_HEADER + "01/15/2024,Buy,VTI,10,220.00,-2200.00\n",
        choice=LayoutChoice(columns={"nonsense": 0}),
    )
    assert len(report.rows) == 1


# -- workbooks -----------------------------------------------------------------------


def _xlsx(sheets: dict[str, list[tuple[object, ...]]]) -> bytes:
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for r in rows:
            ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_xlsx_two_sheets_picks_the_transaction_sheet() -> None:
    content = _xlsx(
        {
            "Summary": [("Portfolio summary",), ("Total value", "10.000,00"), ("As of", "today")],
            "Trades": [
                ("Date", "Action", "Symbol", "Quantity", "Price", "Amount"),
                (date(2024, 1, 15), "Buy", "VTI", 10, 220.0, -2200.0),
                (date(2024, 1, 16), "Sell", "VTI", -5, 225.0, 1125.0),
            ],
        }
    )
    report = parse_generic(content)
    assert report.layout is not None
    assert report.layout.sheets == ("Summary", "Trades")
    assert report.layout.sheet == 1
    assert [r.kind for r in report.rows] == ["buy", "sell"]
    assert report.rows[0].date == date(2024, 1, 15)
    assert report.rows[0].net_native == D("-2200")


def test_xlsx_sheet_choice_overrides() -> None:
    content = _xlsx(
        {
            "A": [("Date", "Action", "Amount"), (date(2024, 1, 15), "Deposit", 100)],
            "B": [("Date", "Action", "Amount"), (date(2024, 1, 16), "Deposit", 200)],
        }
    )
    report = parse_generic(content, choice=LayoutChoice(sheet=0))
    assert report.layout is not None
    assert report.layout.sheet == 0
    assert report.rows[0].net_native == D(100)


# -- Vanguard sample through the flexible reader ---------------------------------------


def test_vanguard_sample_with_renamed_type_header_matches_strict_parser() -> None:
    text = (FIXTURES / "vanguard_sample.csv").read_text()
    assert "Transaction Type" in text
    renamed = text.replace("Transaction Type", "Type", 1)
    strict = parse_vanguard_csv(text)
    flexible = parse_generic(renamed, action_mapper=map_transaction_type, date_order_default="MDY")

    def key(r: ParsedTransactionRow) -> tuple[object, ...]:
        return (r.date, r.kind, r.symbol, r.quantity, r.net_native)

    assert not flexible.errors
    assert flexible.sweeps_dropped == strict.sweeps_dropped
    assert [key(r) for r in flexible.rows] == [key(r) for r in strict.rows]


# -- property: US and EU spellings of the same rows parse identically ---------------------

_trade = st.tuples(
    st.integers(0, 300),  # day offset
    st.sampled_from(["VTI", "VWRL", "AAPL"]),
    st.sampled_from(["Buy", "Sell"]),
    st.integers(1, 100),  # quantity
    st.integers(100, 99_999),  # price in cents
)


def _us(n: Decimal) -> str:
    return f"{n:,.2f}"


def _eu(n: Decimal) -> str:
    return f"{n:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


@settings(max_examples=40, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.lists(_trade, min_size=1, max_size=8))
def test_us_and_eu_formats_parse_identically(trades: list[tuple[int, str, str, int, int]]) -> None:
    us_lines = ["Date,Action,Symbol,Quantity,Price,Amount"]
    eu_lines = ["Datum;Transaktionsart;Symbol;Anzahl;Kurs;Betrag"]
    for off, sym, side, qty, cents in trades:
        day = date(2023, 1, 1) + timedelta(days=off)
        price = D(cents) / 100
        gross = price * qty
        net = -gross if side == "Buy" else gross
        us_lines.append(f'{day:%m/%d/%Y},{side},{sym},{qty},"{_us(price)}","{_us(net)}"')
        eu_lines.append(
            f"{day:%d.%m.%Y};{'Kauf' if side == 'Buy' else 'Verkauf'};{sym};{qty};"
            f'"{_eu(price)}";"{_eu(net)}"'
        )
    us = parse_generic("\n".join(us_lines) + "\n", date_order_default="MDY")
    eu = parse_generic("\n".join(eu_lines) + "\n", date_order_default="DMY")
    assert not us.errors
    assert not eu.errors

    def key(r: ParsedTransactionRow) -> tuple[object, ...]:
        return (r.date, r.kind, r.symbol, r.quantity, r.price_native, r.net_native)

    assert len(us.rows) == len(trades)
    assert [key(r) for r in us.rows] == [key(r) for r in eu.rows]


def test_total_row_with_amount_is_skipped_not_an_error() -> None:
    content = (
        "Date,Symbol,Action,Quantity,Price,Amount\n"
        "2024-01-05,VTI,Buy,5,220.00,-1100.00\n"
        "2024-02-05,VTI,Buy,1,230.00,-230.00\n"
        "Total,,,,,-1330.00\n"
    )
    report = parse_generic(content)
    assert len(report.rows) == 2
    assert report.errors == []
