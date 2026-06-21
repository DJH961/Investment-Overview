"""Pure form-validation helpers shared by the UI's inline validators.

These are deliberately free of any NiceGUI / database dependency so they can be
unit-tested in isolation and reused by every form that needs the same checks.
Each validator returns ``None`` when the value is acceptable, or a short,
user-facing error message when it isn't — the exact shape NiceGUI's
``validation=`` callable expects, so a form can wire one straight onto an input
for *inline* (as-you-type) feedback instead of only checking at save time
(audit **E4**).
"""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal, InvalidOperation

from investment_dashboard.models.transaction import TransactionKind

#: Transaction kinds that price an instrument and therefore require a symbol.
SYMBOL_REQUIRED_KINDS: frozenset[str] = frozenset(
    {
        TransactionKind.BUY.value,
        TransactionKind.SELL.value,
        TransactionKind.DIVIDEND_CASH.value,
        TransactionKind.DIVIDEND_REINVEST.value,
        TransactionKind.SPLIT.value,
    }
)

#: Cash-only kinds that must *not* carry a symbol.
CASH_KINDS: frozenset[str] = frozenset(
    {
        TransactionKind.DEPOSIT.value,
        TransactionKind.WITHDRAWAL.value,
        TransactionKind.INTEREST.value,
        TransactionKind.FEE.value,
        TransactionKind.TRANSFER_IN.value,
        TransactionKind.TRANSFER_OUT.value,
    }
)

#: Acceptable ticker shape: letters/digits with optional ``.``/``-``/``^``
#: (e.g. ``VTI``, ``EXS1.DE``, ``^IRX``, ``BRK-B``).
_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.^-]{1,15}$")

#: The dashboard's data starts well after this; a date before it is a typo.
_EARLIEST_REASONABLE = date(1970, 1, 1)


def validate_date(text: str | None, *, today: date | None = None) -> str | None:
    """Validate an ISO ``YYYY-MM-DD`` date string with sane bounds."""
    raw = (text or "").strip()
    if not raw:
        return "Date is required"
    try:
        parsed = date.fromisoformat(raw)
    except ValueError:
        return "Use YYYY-MM-DD"
    if parsed < _EARLIEST_REASONABLE:
        return f"Date looks too old (before {_EARLIEST_REASONABLE.isoformat()})"
    if parsed > (today or date.today()):
        return "Date can't be in the future"
    return None


def validate_decimal(
    text: str | None,
    *,
    field: str = "Value",
    required: bool = False,
    allow_negative: bool = True,
    allow_zero: bool = True,
) -> str | None:
    """Validate an optional numeric field, with sign/zero bounds."""
    raw = (text or "").strip()
    if not raw:
        return f"{field} is required" if required else None
    try:
        value = Decimal(raw)
    except (InvalidOperation, ValueError):
        return f"{field} must be a number"
    if not allow_negative and value < 0:
        return f"{field} can't be negative"
    if not allow_zero and value == 0:
        return f"{field} can't be zero"
    return None


def validate_symbol(text: str | None, *, kind: str) -> str | None:
    """Validate the symbol field's presence and shape against the kind."""
    raw = (text or "").strip()
    if kind in CASH_KINDS:
        if raw:
            return "Cash transactions don't take a symbol"
        return None
    if kind in SYMBOL_REQUIRED_KINDS and not raw:
        return "Symbol is required for this kind"
    if raw and not _SYMBOL_RE.match(raw):
        return "Symbol contains invalid characters"
    return None
