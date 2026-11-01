"""US-locale numeric/date parsing for broker exports (audit D5).

Both supported brokers (Fidelity, Vanguard) export **US-locale** files:

* the decimal separator is a dot (``.``),
* the thousands separator is a comma (``,``), and
* dates are ``MM/DD/YYYY``.

The naive ``s.replace(",", "")`` the parsers used to do is fine for a US
export but **silently mis-parses** an EU-locale one — ``"1,50"`` (one euro
fifty) would become ``150`` and ``"1.234,56"`` would become ``1.23456``.
Dates are worse: ``13/06/2024`` (6 June, EU) parses cleanly as *no* US month
but ``05/06/2024`` is genuinely ambiguous (5 June vs 6 May).

Per the audit, the assumption is documented here and the ambiguous EU shapes
are rejected loudly with :class:`LocaleError` rather than mis-parsed. ISO
``YYYY-MM-DD`` dates are always accepted (unambiguous).
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation

#: Accepted date formats, US-locale first. ISO is unambiguous and always safe.
US_DATE_FORMATS = ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y")

_BLANKS = {"", "-", "--"}


class LocaleError(ValueError):
    """Raised when a value looks EU-locale and would be mis-parsed as US.

    Distinct from a generic ``ValueError`` so the importer can give the user
    an actionable "this file isn't a US-locale export" message instead of an
    opaque "bad decimal".
    """


def parse_us_decimal(s: str | None) -> Decimal | None:
    """Parse a US-locale decimal cell. ``None``/blank/dash → ``None``.

    Tolerates currency symbols, surrounding whitespace and US thousands
    separators (``"$1,234.56"`` → ``1234.56``). Raises :class:`LocaleError`
    for the unambiguous EU shapes (``"1.234,56"``, ``"1,50"``) and
    :class:`ValueError` for genuinely un-parseable text.
    """
    if s is None:
        return None
    raw = s.strip()
    cleaned = raw.replace("$", "").replace(" ", "").strip()
    if cleaned.lower() in _BLANKS or cleaned.lower() == "free":
        return None

    body = cleaned.lstrip("+-")
    has_dot = "." in body
    has_comma = "," in body
    if has_comma:
        if has_dot:
            # Both separators present. US writes "1,234.56" (comma before the
            # last dot); EU writes "1.234,56" (comma after the last dot).
            if body.rfind(",") > body.rfind("."):
                raise LocaleError(
                    f"{s!r} looks EU-locale (comma decimal separator); "
                    "this importer expects US-locale numbers (1,234.56)."
                )
        else:
            # Lone comma. A trailing group of exactly three digits is a US
            # thousands separator ("1,234"); 1–2 trailing digits is an EU
            # decimal ("1,50", "12,5") that US never writes that way.
            last = body.rsplit(",", 1)[-1]
            if len(last) != 3 or not last.isdigit():
                raise LocaleError(
                    f"{s!r} looks EU-locale (comma decimal separator); "
                    "this importer expects US-locale numbers (1,234.56)."
                )

    normalised = cleaned.replace(",", "")
    try:
        return Decimal(normalised)
    except InvalidOperation as exc:
        raise ValueError(f"Bad decimal: {s!r}") from exc


def parse_us_date(s: str) -> date:
    """Parse a US-locale (``MM/DD/YYYY``) or ISO date string.

    Raises :class:`LocaleError` when a slash date is unambiguously
    ``DD/MM`` (first field > 12, so it cannot be a US month) and
    :class:`ValueError` for any other unrecognised format.
    """
    text = s.strip()
    parts = text.split("/")
    if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
        first, second = int(parts[0]), int(parts[1])
        if first > 12 and second <= 12:
            raise LocaleError(
                f"{s!r} looks EU-locale (DD/MM/YYYY); this importer expects "
                "US-locale dates (MM/DD/YYYY)."
            )
    for fmt in US_DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unrecognised date format: {s!r}")
