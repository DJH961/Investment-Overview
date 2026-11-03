# ruff: noqa: RUF001 - deliberate unicode minus, dashes and space characters
"""Locale-tolerant number and date parsing with format inference.

Unlike :mod:`..locale_parsing` (strict US-locale, rejects anything else), this
module *infers* the file's conventions from its own values and then parses
with them:

* **Decimal separator** — ``"."`` (``1,234.56``) or ``","`` (``1.234,56``),
  voted over every numeric-looking cell in the file
  (:func:`infer_decimal`).
* **Date order** — ``MDY``, ``DMY`` or ``YMD``, voted over the date column
  (:func:`infer_date_order`). Ambiguous files (every day ≤ 12) fall back to a
  hint (``DMY`` for comma-decimal files, else ``MDY``).

Cells may be strings or native spreadsheet values (numbers, ``date`` /
``datetime``); Excel date serials are accepted for dates.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Literal

Cell = str | int | float | Decimal | date | datetime | None
DecimalSep = Literal[".", ","]
DateOrder = Literal["MDY", "DMY", "YMD"]

DECIMAL_SEPARATORS: tuple[DecimalSep, ...] = (".", ",")
DATE_ORDERS: tuple[DateOrder, ...] = ("MDY", "DMY", "YMD")

_BLANKS = frozenset({"", "-", "--", "—", "–", "n/a", "na", "none", "null", "free", "nan"})
# Currency symbols / ISO codes that may prefix or suffix an amount.
_CURRENCY_RE = re.compile(
    r"(?i)(?:US\$|C\$|A\$|[$€£¥₹₣]|\b(?:USD|EUR|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK)\b)"
)
# Spaces, NBSP, narrow NBSP, thin space and apostrophes are thousands marks.
_GROUPING_RE = re.compile(r"[\s   '’]")
_NUMERIC_RE = re.compile(r"^\d+(?:[.,]\d+)*(?:[.,]\d*)?$")
_EXCEL_EPOCH = date(1899, 12, 30)

_MONTHS: dict[str, int] = {}
for _num, _names in enumerate(
    (
        ("jan", "january", "januar", "janvier", "enero", "jänner", "janv"),
        ("feb", "february", "februar", "février", "fevrier", "febrero", "févr", "fev"),
        ("mar", "march", "märz", "maerz", "mars", "marzo", "mrz"),
        ("apr", "april", "avril", "abril", "avr"),
        ("may", "mai", "mayo"),
        ("jun", "june", "juni", "juin", "junio"),
        ("jul", "july", "juli", "juillet", "julio", "juil"),
        ("aug", "august", "août", "aout", "agosto"),
        ("sep", "sept", "september", "septembre", "septiembre"),
        ("oct", "october", "oktober", "okt", "octobre", "octubre"),
        ("nov", "november", "novembre", "noviembre"),
        ("dec", "december", "dezember", "dez", "décembre", "decembre", "diciembre", "déc"),
    ),
    start=1,
):
    for _name in _names:
        _MONTHS[_name] = _num


def _text(cell: Cell) -> str:
    return "" if cell is None else str(cell).strip()


def is_blank(cell: Cell) -> bool:
    return cell is None or (isinstance(cell, str) and cell.strip().lower() in _BLANKS)


def _strip_number(raw: str) -> tuple[str, bool]:
    """Remove currency markers, grouping spaces and sign decorations.

    Returns ``(digits_and_separators, negative)``.
    """
    s = _CURRENCY_RE.sub("", raw).strip()
    negative = False
    if s.startswith("(") and s.endswith(")"):
        negative, s = True, s[1:-1].strip()
    s = s.replace("−", "-")  # unicode minus
    if s.endswith("-"):
        negative, s = not negative, s[:-1].strip()
    if s.startswith("-"):
        negative, s = not negative, s[1:].strip()
    elif s.startswith("+"):
        s = s[1:].strip()
    s = _CURRENCY_RE.sub("", s).strip()
    return _GROUPING_RE.sub("", s), negative


def looks_numeric(cell: Cell) -> bool:
    if isinstance(cell, bool):
        return False
    if isinstance(cell, int | float | Decimal):
        return True
    if not isinstance(cell, str) or is_blank(cell):
        return False
    if _NUMERIC_DATE_RE.match(cell.strip()):
        return False  # "15.01.2024" is a date, not 15.012024
    body, _ = _strip_number(cell)
    return bool(body) and bool(_NUMERIC_RE.match(body))


def _decimal_vote(body: str) -> DecimalSep | None:
    """Which separator ``body`` (sign/currency stripped) implies, if any."""
    has_dot, has_comma = "." in body, "," in body
    if has_dot and has_comma:
        return "." if body.rfind(".") > body.rfind(",") else ","
    sep: DecimalSep | None = "." if has_dot else "," if has_comma else None
    if sep is None:
        return None
    parts = body.split(sep)
    if len(parts) > 2:
        # Repeated separator can only be grouping: "1.234.567" -> comma decimal.
        return "," if sep == "." else "."
    tail = parts[-1]
    if len(tail) != 3:
        return sep  # "1.5", "12,50": a decimal separator
    if parts[0] in ("", "0"):
        return sep  # "0.125" / ",125" — no one groups a leading zero
    return None  # "1,234" / "1.234" is ambiguous


def infer_decimal(cells: Iterable[Cell], default: DecimalSep = ".") -> DecimalSep:
    """Vote the file's decimal separator over its numeric-looking cells."""
    votes = {".": 0, ",": 0}
    for cell in cells:
        if not isinstance(cell, str) or not looks_numeric(cell):
            continue
        vote = _decimal_vote(_strip_number(cell)[0])
        if vote is not None:
            votes[vote] += 1
    if votes["."] == votes[","]:
        return default
    return "." if votes["."] > votes[","] else ","


def parse_number(cell: Cell, decimal: DecimalSep = ".") -> Decimal | None:
    """Parse an amount/quantity cell. Blank-ish → ``None``; junk → ``ValueError``.

    Accepts native numbers, currency symbols or codes, grouping marks (``,`` /
    ``.`` / spaces / apostrophes), ``(123)`` and trailing-minus negatives.
    """
    if isinstance(cell, bool):
        raise ValueError(f"not a number: {cell!r}")
    if isinstance(cell, Decimal):
        return cell
    if isinstance(cell, int):
        return Decimal(cell)
    if isinstance(cell, float):
        return Decimal(repr(cell))
    if isinstance(cell, date | datetime):
        raise ValueError(f"expected a number, got a date: {cell}")
    if is_blank(cell):
        return None
    raw = _text(cell)
    body, negative = _strip_number(raw)
    if not body or not _NUMERIC_RE.match(body):
        raise ValueError(f"not a number: {raw!r}")
    group = "," if decimal == "." else "."
    body = body.replace(group, "")
    if body.count(decimal) > 1:
        raise ValueError(f"{raw!r} does not fit the {decimal!r} decimal separator")
    body = body.replace(decimal, ".")
    try:
        value = Decimal(body)
    except InvalidOperation as exc:  # pragma: no cover - regex guards this
        raise ValueError(f"not a number: {raw!r}") from exc
    return -value if negative else value


# -- dates ----------------------------------------------------------------------

_ISO_RE = re.compile(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$")
_NUMERIC_DATE_RE = re.compile(r"^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{2,4})(?:[T\s,].*)?$")
_COMPACT_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})$")
_WORD_RE = re.compile(r"[A-Za-zÀ-ÿ]+\.?|\d+")


def _year(y: int) -> int:
    if y < 100:
        return 2000 + y if y < 70 else 1900 + y
    return y


def _excel_serial(value: float) -> date | None:
    # 1990-01-01 .. ~2120: plausible transaction dates written as serials.
    if 32874 <= value <= 80000:
        return _EXCEL_EPOCH + timedelta(days=int(value))
    return None


def _date_order_vote(text: str) -> DateOrder | None:
    if _ISO_RE.match(text):
        return "YMD"
    m = _NUMERIC_DATE_RE.match(text)
    if not m:
        return None
    a, b = int(m.group(1)), int(m.group(2))
    if a > 12 >= b:
        return "DMY"
    if b > 12 >= a:
        return "MDY"
    return None


def infer_date_order(cells: Iterable[Cell], default: DateOrder = "MDY") -> DateOrder:
    """Vote ``MDY`` vs ``DMY`` over a date column (``YMD`` if all ISO)."""
    votes: dict[DateOrder, int] = {"MDY": 0, "DMY": 0, "YMD": 0}
    seen_numeric = False
    for cell in cells:
        if not isinstance(cell, str):
            continue
        text = cell.strip()
        if _NUMERIC_DATE_RE.match(text):
            seen_numeric = True
        vote = _date_order_vote(text)
        if vote is not None:
            votes[vote] += 1
    if votes["MDY"] or votes["DMY"]:
        if votes["MDY"] == votes["DMY"]:
            return default
        return "MDY" if votes["MDY"] > votes["DMY"] else "DMY"
    if votes["YMD"] and not seen_numeric:
        return "YMD"
    return default


def date_order_ambiguous(cells: Iterable[Cell]) -> bool:
    """True when the column has ``a/b/yyyy`` dates but none says which is the day."""
    numeric = False
    for cell in cells:
        if not isinstance(cell, str):
            continue
        text = cell.strip()
        if not _NUMERIC_DATE_RE.match(text):
            continue
        numeric = True
        if _date_order_vote(text) is not None:
            return False
    return numeric


def _from_words(text: str) -> date | None:
    """``"15 Jan 2024"``, ``"Jan 15, 2024"``, ``"15. März 2024"``."""
    tokens = [t.rstrip(".").lower() for t in _WORD_RE.findall(text)]
    month = next((_MONTHS[t] for t in tokens if t in _MONTHS), None)
    if month is None:
        return None
    nums = [int(t) for t in tokens if t.isdigit()]
    if len(nums) < 2:
        return None
    year_idx = next((i for i, n in enumerate(nums) if n > 31), len(nums) - 1)
    year = _year(nums[year_idx])
    rest = [n for i, n in enumerate(nums) if i != year_idx]
    day = rest[0]
    try:
        return date(year, month, day)
    except ValueError:
        return None


def parse_date(cell: Cell, order: DateOrder = "MDY") -> date:  # noqa: PLR0911, PLR0912
    """Parse a date cell; raises ``ValueError`` when it is not a date."""
    if isinstance(cell, datetime):
        return cell.date()
    if isinstance(cell, date):
        return cell
    if isinstance(cell, int | float | Decimal) and not isinstance(cell, bool):
        serial = _excel_serial(float(cell))
        if serial is not None:
            return serial
        compact = _COMPACT_RE.match(str(int(cell))) if float(cell).is_integer() else None
        if compact:
            return date(int(compact.group(1)), int(compact.group(2)), int(compact.group(3)))
        raise ValueError(f"not a date: {cell!r}")
    text = _text(cell)
    if not text:
        raise ValueError("empty date")
    try:
        m = _ISO_RE.match(text)
        if m:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        m = _NUMERIC_DATE_RE.match(text)
        if m:
            a, b, y = int(m.group(1)), int(m.group(2)), _year(int(m.group(3)))
            # A field > 12 can only be the day, whatever the file's order says.
            if order == "DMY":
                day, month = (a, b) if b <= 12 else (b, a)
            else:
                month, day = (a, b) if a <= 12 else (b, a)
            return date(y, month, day)
        m = _COMPACT_RE.match(text)
        if m:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError as exc:
        raise ValueError(f"not a valid date: {text!r}") from exc
    worded = _from_words(text)
    if worded is not None:
        return worded
    raise ValueError(f"not a date: {text!r}")


def looks_like_date(cell: Cell) -> bool:
    if isinstance(cell, date | datetime):
        return True
    if not isinstance(cell, str) or is_blank(cell):
        return False
    try:
        parse_date(cell, "MDY")
    except ValueError:
        return False
    return True
