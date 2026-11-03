"""Read any CSV / TSV / text / XLSX upload into a grid of cells.

* **Workbooks** (``.xlsx`` / ``.xlsm``, detected by the ZIP magic bytes, not the
  file name): every sheet is read with native cell values (numbers, dates).
* **Text**: the encoding is detected (BOM, UTF-8, UTF-16, else Windows-1252)
  and the delimiter sniffed from ``, ; \\t |``.
* Old binary ``.xls`` files are recognised and refused with a clear message.

The grid keeps raw rows (ragged rows padded to the widest); finding the header
row is :mod:`.columns`' job.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass

from investment_dashboard.adapters.tabular.values import Cell

_ZIP_MAGIC = b"PK\x03\x04"
_OLE_MAGIC = b"\xd0\xcf\x11\xe0"
_DELIMITERS = (",", ";", "\t", "|")
#: Rows read per sheet at most (protects the server from huge sheets).
MAX_ROWS = 100_000


class UnreadableFileError(ValueError):
    """The upload is not a table we can read (binary, empty, legacy .xls)."""


@dataclass(frozen=True)
class Sheet:
    name: str
    rows: list[list[Cell]]


def is_workbook(content: bytes) -> bool:
    return content[:4] == _ZIP_MAGIC


def decode_text(content: bytes) -> str:
    """Decode a text upload: BOM first, then UTF-8, then Windows-1252."""
    if content[:3] == b"\xef\xbb\xbf":
        return content[3:].decode("utf-8", errors="replace")
    if content[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return content.decode("utf-16", errors="replace")
    # UTF-16 without BOM: every other byte is NUL in mostly-ASCII text.
    sample = content[:2000]
    if sample and sample.count(b"\x00") > len(sample) // 4:
        enc = "utf-16-le" if sample[1:2] == b"\x00" else "utf-16-be"
        return content.decode(enc, errors="replace")
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return content.decode("cp1252", errors="replace")


def sniff_delimiter(text: str) -> str:
    """The delimiter that splits the most lines into the same number of fields."""
    lines = [ln for ln in text.splitlines()[:200] if ln.strip()]
    if not lines:
        return ","
    best, best_score = ",", -1.0
    for delim in _DELIMITERS:
        widths = [len(r) for r in csv.reader(lines, delimiter=delim)]
        multi = [w for w in widths if w > 1]
        if not multi:
            continue
        common = max(set(multi), key=multi.count)
        # Lines agreeing on the most common width, weighted by that width.
        score = multi.count(common) * (1 + min(common, 30) / 30)
        if score > best_score:
            best, best_score = delim, score
    return best


def _pad(rows: list[list[Cell]]) -> list[list[Cell]]:
    width = max((len(r) for r in rows), default=0)
    return [r + [None] * (width - len(r)) for r in rows]


def _read_text(content: bytes | str) -> list[Sheet]:
    text = content if isinstance(content, str) else decode_text(content)
    text = text.lstrip("﻿")
    if not text.strip():
        raise UnreadableFileError("The file is empty")
    if "\x00" in text[:2000]:
        raise UnreadableFileError("This looks like a binary file, not a CSV or Excel table")
    delim = sniff_delimiter(text)
    rows: list[list[Cell]] = []
    for row in csv.reader(io.StringIO(text), delimiter=delim):
        rows.append(list(row))
        if len(rows) >= MAX_ROWS:
            break
    return [Sheet(name="", rows=_pad(rows))]


def _read_workbook(content: bytes) -> list[Sheet]:
    from openpyxl import load_workbook  # noqa: PLC0415 - heavy import, only for workbooks

    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception as exc:
        raise UnreadableFileError(f"Could not open the workbook: {exc}") from exc
    sheets: list[Sheet] = []
    try:
        for ws in wb.worksheets:
            rows: list[list[Cell]] = []
            for raw in ws.iter_rows(values_only=True):
                rows.append([c if not isinstance(c, bool) else str(c) for c in raw])
                if len(rows) >= MAX_ROWS:
                    break
            while rows and not any(c not in (None, "") for c in rows[-1]):
                rows.pop()
            if rows:
                sheets.append(Sheet(name=ws.title, rows=_pad(rows)))
    finally:
        wb.close()
    if not sheets:
        raise UnreadableFileError("The workbook has no data")
    return sheets


def read_sheets(content: bytes | str) -> list[Sheet]:
    """Every table in the upload (one for text files, one per non-empty sheet)."""
    if isinstance(content, bytes):
        if not content.strip():
            raise UnreadableFileError("The file is empty")
        if is_workbook(content):
            return _read_workbook(content)
        if content[:4] == _OLE_MAGIC:
            raise UnreadableFileError(
                "Old Excel .xls files can't be read; open it in Excel and save it as .xlsx or .csv"
            )
    return _read_text(content)
