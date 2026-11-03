"""``read_sheets``: encodings, delimiters, workbooks and refused formats."""

from __future__ import annotations

import io
from datetime import date

import openpyxl
import pytest

from investment_dashboard.adapters.tabular.reader import (
    UnreadableFileError,
    decode_text,
    read_sheets,
    sniff_delimiter,
)

_CSV = "Date,Symbol,Qty\n2024-01-05,VTI,10\n2024-02-15,VTI,5\n"


def _only(content: bytes | str) -> list[list[object]]:
    sheets = read_sheets(content)
    assert len(sheets) == 1
    return sheets[0].rows  # type: ignore[return-value]


def test_comma_csv() -> None:
    rows = _only(_CSV)
    assert rows[0] == ["Date", "Symbol", "Qty"]
    assert rows[1] == ["2024-01-05", "VTI", "10"]


def test_semicolon_csv_with_decimal_commas() -> None:
    rows = _only("Datum;Kurs;Betrag\n05.01.2024;220,50;-2.205,00\n")
    assert rows[1] == ["05.01.2024", "220,50", "-2.205,00"]


def test_tab_separated() -> None:
    rows = _only(_CSV.replace(",", "\t"))
    assert rows[0] == ["Date", "Symbol", "Qty"]
    assert len(rows[1]) == 3


def test_pipe_separated() -> None:
    rows = _only(_CSV.replace(",", "|"))
    assert rows[0] == ["Date", "Symbol", "Qty"]
    assert len(rows[2]) == 3


def test_sniff_delimiter_empty_defaults_to_comma() -> None:
    assert sniff_delimiter("") == ","


def test_cp1252_bytes_with_umlauts() -> None:
    raw = "Buchungstag;Bezeichnung;Gebühr\n05.01.2024;Müller Fonds;1,50\n".encode("cp1252")
    rows = _only(raw)
    assert rows[0] == ["Buchungstag", "Bezeichnung", "Gebühr"]
    assert rows[1][1] == "Müller Fonds"


def test_utf16_with_bom() -> None:
    rows = _only(_CSV.encode("utf-16"))
    assert rows[0] == ["Date", "Symbol", "Qty"]
    assert rows[1][1] == "VTI"


def test_utf16_without_bom() -> None:
    rows = _only(_CSV.encode("utf-16-le"))
    assert rows[0] == ["Date", "Symbol", "Qty"]


def test_utf8_bom_is_stripped() -> None:
    rows = _only(b"\xef\xbb\xbf" + _CSV.encode("utf-8"))
    assert rows[0][0] == "Date"


def test_utf8_umlauts_kept() -> None:
    assert "Gebühr" in decode_text("Gebühr".encode())


def test_ragged_rows_are_padded() -> None:
    rows = _only("a,b,c\n1,2\n1,2,3,4\n")
    assert {len(r) for r in rows} == {4}


def test_str_input_accepted() -> None:
    assert _only(_CSV)[1][1] == "VTI"


def _workbook(sheets: dict[str, list[tuple[object, ...]]]) -> bytes:
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for r in rows:
            ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_xlsx_two_sheets_native_values() -> None:
    content = _workbook(
        {
            "Info": [("Report",), ("generated today",)],
            "Trades": [("Date", "Qty"), (date(2024, 1, 5), 10), (None, None)],
        }
    )
    sheets = read_sheets(content)
    assert [s.name for s in sheets] == ["Info", "Trades"]
    trades = sheets[1].rows
    assert len(trades) == 2  # trailing blank row dropped
    assert trades[1][1] == 10
    assert str(trades[1][0]).startswith("2024-01-05")


def test_xlsx_skips_empty_sheets() -> None:
    sheets = read_sheets(_workbook({"Empty": [], "Data": [("a", "b"), (1, 2)]}))
    assert [s.name for s in sheets] == ["Data"]


def test_xlsx_all_empty_raises() -> None:
    with pytest.raises(UnreadableFileError):
        read_sheets(_workbook({"Empty": []}))


def test_corrupt_zip_raises_unreadable() -> None:
    with pytest.raises(UnreadableFileError):
        read_sheets(b"PK\x03\x04 this is not a workbook")


def test_xls_ole_magic_refused() -> None:
    with pytest.raises(UnreadableFileError, match=r"\.xls"):
        read_sheets(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 100)


@pytest.mark.parametrize("content", [b"", b"   \n\t ", "", "  \n"])
def test_empty_raises(content: bytes | str) -> None:
    with pytest.raises(UnreadableFileError):
        read_sheets(content)


def test_binary_garbage_raises() -> None:
    with pytest.raises(UnreadableFileError):
        read_sheets(b"ab\x00\x01\x02\x03" * 50)
