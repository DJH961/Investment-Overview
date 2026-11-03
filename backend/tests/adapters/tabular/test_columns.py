"""Header-row detection and column -> field assignment."""

from __future__ import annotations

import pytest

from investment_dashboard.adapters.tabular.columns import (
    Field,
    detect,
    find_header_row,
    header_score,
    header_signature,
    normalise_header,
)
from investment_dashboard.adapters.tabular.reader import read_sheets


def _grid(text: str) -> list[list[object]]:
    return read_sheets(text)[0].rows  # type: ignore[return-value]


def test_normalise_header_strips_decorations() -> None:
    assert normalise_header("Price ($)") == "price"
    assert normalise_header(" Amount (EUR) ") == "amount"
    assert normalise_header("Net_Amount**") == "net amount"
    assert normalise_header(None) == ""


def test_header_score_exact_beats_contains() -> None:
    assert header_score("Action", Field.ACTION) > header_score("Action Taken", Field.ACTION)
    assert header_score("Banana", Field.ACTION) == 0.0


def test_account_type_is_never_the_action() -> None:
    assert header_score("Account Type", Field.ACTION) == 0.0


def test_cash_balance_is_never_the_amount() -> None:
    assert header_score("Cash Balance ($)", Field.AMOUNT) == 0.0


def test_header_signature_is_order_insensitive() -> None:
    assert header_signature(["B", "a", "C"]) == header_signature(["c", "A", "b"])


def test_preamble_before_header_is_skipped() -> None:
    text = (
        "Report generated 2024-05-01\n"
        "Some disclaimer text,,,\n"
        "\n"
        "Date,Action,Symbol,Quantity,Price,Amount\n"
        "01/05/2024,Buy,VTI,10,220.50,-2205.00\n"
        "02/05/2024,Sell,VTI,-5,225.00,1125.00\n"
    )
    rows = _grid(text)
    assert find_header_row(rows) == 3
    det = detect(rows, ".")
    assert det.header_row == 3
    assert det.data_start == 4
    assert det.column(Field.DATE) == 0
    assert det.column(Field.ACTION) == 1
    assert det.column(Field.AMOUNT) == 5


_FIDELITY = (
    "Run Date,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),"
    "Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date\n"
    "01/05/2024,YOU BOUGHT VTI,VTI,VANGUARD TOTAL,Cash,10.00,220.50,0.00,0.00,0.00,-2205.00,"
    "1234.56,01/07/2024\n"
    "04/01/2024,YOU SOLD VTI,VTI,VANGUARD TOTAL,Cash,-1.00,225.00,0.00,0.50,0.00,224.50,"
    "2464.31,04/03/2024\n"
    "03/15/2024,INTEREST EARNED,,Interest Earned,Cash,,,,,,5.25,2239.81,03/15/2024\n"
)


def test_fidelity_header_action_wins_over_type() -> None:
    det = detect(_grid(_FIDELITY), ".")
    assert det.column(Field.ACTION) == 1
    assert det.assignments[Field.ACTION].by == "header"
    # "Type" holds Cash/Shares and is not used as action.
    assert 4 not in {a.index for a in det.assignments.values() if a.field == Field.ACTION}


def test_fidelity_amount_is_not_cash_balance() -> None:
    det = detect(_grid(_FIDELITY), ".")
    assert det.column(Field.AMOUNT) == 10  # "Amount ($)", not "Cash Balance ($)" at 11
    assert det.column(Field.PRICE) == 6
    assert det.column(Field.QUANTITY) == 5
    assert det.column(Field.DATE) == 0
    assert det.column(Field.SETTLEMENT_DATE) == 12
    assert det.column(Field.FEES) == 8
    assert det.column(Field.COMMISSION) == 7


def test_account_type_column_not_used_as_action() -> None:
    text = (
        "Date,Account Type,Symbol,Quantity,Price,Amount\n"
        "01/05/2024,Brokerage,VTI,10,220.50,-2205.00\n"
        "02/05/2024,Brokerage,VTI,5,225.00,-1125.00\n"
    )
    det = detect(_grid(text), ".")
    assert Field.ACTION not in det.assignments or det.column(Field.ACTION) != 1


_GERMAN = (
    "Buchungstag;Wertpapier;ISIN;Transaktionsart;Stück;Kurs;Betrag (EUR);Gebühren\n"
    "05.01.2024;iShares Core MSCI World;IE00B4L5Y983;Kauf;10;80,50;-806,00;1,00\n"
    "15.02.2024;iShares Core MSCI World;IE00B4L5Y983;Verkauf;-5;85,00;424,00;1,00\n"
)


def test_german_header() -> None:
    det = detect(_grid(_GERMAN), ",")
    assert det.column(Field.DATE) == 0
    assert det.column(Field.NAME) == 1
    assert det.column(Field.SYMBOL) == 2
    assert det.column(Field.ACTION) == 3
    assert det.column(Field.QUANTITY) == 4
    assert det.column(Field.PRICE) == 5
    assert det.column(Field.AMOUNT) == 6
    assert det.column(Field.FEES) == 7
    assert all(a.by == "header" for a in det.assignments.values())


def test_headerless_file_guessed_by_content() -> None:
    text = (
        "2024-01-05,VTI,10,220.50,2205.00\n"
        "2024-02-15,VOO,3,400.00,1200.00\n"
        "2024-03-01,VTI,2.5,230.00,575.00\n"
        "2024-04-01,QQQ,4,100.00,400.00\n"
    )
    rows = _grid(text)
    det = detect(rows, ".")
    assert det.header_row is None
    assert det.data_start == 0
    assert det.column(Field.DATE) == 0
    assert det.column(Field.SYMBOL) == 1
    assert det.column(Field.QUANTITY) == 2
    assert det.column(Field.PRICE) == 3
    assert det.column(Field.AMOUNT) == 4
    assert all(a.by == "content" for a in det.assignments.values())


def test_headerless_action_column_found_by_content() -> None:
    text = (
        "2024-01-05,Buy,VTI,10,220.50,-2205.00\n"
        "2024-02-15,Sell,VOO,-3,400.00,1200.00\n"
        "2024-03-01,Buy,VTI,2.5,230.00,-575.00\n"
    )
    det = detect(_grid(text), ".")
    assert det.column(Field.ACTION) == 1
    assert det.column(Field.SYMBOL) == 2


def test_headerless_file_with_longer_tickers() -> None:
    text = (
        "2024-01-05,VWRL,10,220.50,2205.00\n"
        "2024-02-15,VUAA,3,400.00,1200.00\n"
        "2024-03-01,VWRL,2.5,230.00,575.00\n"
        "2024-04-01,AAPL,4,100.00,400.00\n"
    )
    det = detect(_grid(text), ".")
    assert det.header_row is None
    assert det.column(Field.DATE) == 0
    assert det.column(Field.SYMBOL) == 1
    assert det.column(Field.QUANTITY) == 2
    assert det.column(Field.PRICE) == 3
    assert det.column(Field.AMOUNT) == 4


@pytest.mark.parametrize("order", [(0, 1, 2, 3, 4, 5), (5, 3, 1, 0, 4, 2), (2, 4, 0, 5, 1, 3)])
def test_header_matching_is_order_independent(order: tuple[int, ...]) -> None:
    base = [
        ["Date", "Action", "Symbol", "Quantity", "Price", "Amount"],
        ["01/05/2024", "Buy", "VTI", "10", "220.50", "-2205.00"],
        ["02/05/2024", "Sell", "VTI", "-5", "225.00", "1125.00"],
    ]
    rows = [[r[i] for i in order] for r in base]
    det = detect(rows, ".")
    for fld, name in (
        (Field.DATE, "Date"),
        (Field.ACTION, "Action"),
        (Field.SYMBOL, "Symbol"),
        (Field.QUANTITY, "Quantity"),
        (Field.PRICE, "Price"),
        (Field.AMOUNT, "Amount"),
    ):
        assert det.headers[det.column(fld)] == name  # type: ignore[index]


def test_explicit_header_row_none_means_no_header() -> None:
    rows = _grid("Date,Amount\n2024-01-05,10\n2024-01-06,20\n")
    det = detect(rows, ".", header_row=None)
    assert det.header_row is None
    assert det.headers[0] == "Column 1"


def test_content_triple_resolves_quantity_price_amount() -> None:
    # No usable headers: only the quantity x price ~ amount relation identifies them.
    text = (
        "x1,x2,x3,x4\n"
        "2024-01-05,10,220.50,2205.00\n"
        "2024-02-15,3,400.00,1200.00\n"
        "2024-03-01,2.5,230.00,575.00\n"
        "2024-03-05,4,100.00,400.00\n"
        "2024-03-06,8,10.00,80.00\n"
        "2024-03-07,1,50.00,50.00\n"
        "2024-03-08,6,20.00,120.00\n"
        "2024-03-09,7,30.00,210.00\n"
        "2024-03-10,9,40.00,360.00\n"
        "2024-03-11,5,60.00,300.00\n"
    )
    det = detect(_grid(text), ".")
    assert det.column(Field.QUANTITY) == 1
    assert det.column(Field.PRICE) == 2
    assert det.column(Field.AMOUNT) == 3
