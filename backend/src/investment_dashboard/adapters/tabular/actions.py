"""Classify free-text transaction actions into ledger kinds (any broker).

Keyword rules in English, German, French, Spanish and Dutch, most specific
first (``"Dividend reinvestment"`` before ``"Dividend"``, ``"Verkauf"`` before
``"Kauf"``). The user's overrides (``import.action_overrides.<broker>``) win.
Unknown text raises :class:`UnknownActionError`, so the row shows up in the
import page's "Unknown actions" box for the user to map.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

from investment_dashboard.adapters.importer_types import (
    IGNORE_ACTION,
    UnknownActionError,
    lookup_override,
)

#: ``(pattern, kind)``; ``kind=None`` drops the row (internal sweeps).
_RULES: tuple[tuple[str, str | None], ...] = (
    (r"\bsweep", None),
    (r"reinvest|wiederanlage|réinvest|reinversi|herbelegging", "dividend_reinvest"),
    (r"split|aktiensplit|fraccionamiento", "split"),
    (
        r"withholding|quellensteuer|foreign tax|tax paid|steuer|impôt|impot|impuesto"
        r"|belasting|\btax(es)?\b",
        "fee",
    ),
    (
        r"dividend|dividende|dividendo|ausschüttung|ausschuettung|distribution"
        r"|cap(ital)? gain|ertrag|coupon|kupon",
        "dividend_cash",
    ),
    (r"interest|zins|intérêt|interet|interés|interes|rente\b", "interest"),
    (
        r"\bsell\b|\bsold\b|\bsale\b|verkauf|vente|venta|verkoop|redemption|rücknahme"
        r"|\bsl\b|\bs\b",
        "sell",
    ),
    (
        r"\bbuy\b|bought|purchase|\bkauf|achat|compra|aankoop|subscription|zeichnung"
        r"|sparplan|savings plan|\bbt\b|\bb\b",
        "buy",
    ),
    (
        r"withdraw|auszahlung|abhebung|retrait|retiro|opname|disbursement|funds paid"
        r"|transfer out|outgoing|ausgehend|eft paid|wire out|ach out|payout|debit",
        "withdrawal",
    ),
    (
        r"deposit|einzahlung|einlage|versement|depósito|deposito|storting|contribution"
        r"|funds received|transfer in|incoming|eingehend|eft received|wire in|ach in"
        r"|credit|überweisung|ueberweisung",
        "deposit",
    ),
    (r"fee|gebühr|gebuehr|entgelt|commission|provision|frais|comisión|kosten|charge", "fee"),
)
_COMPILED = tuple((re.compile(p, re.IGNORECASE), k) for p, k in _RULES)


def classify_action(action: str, overrides: Mapping[str, str] | None = None) -> str | None:
    """The ledger kind for ``action``; ``None`` drops the row (sweep / ignored).

    Raises :class:`UnknownActionError` when no rule matches.
    """
    override = lookup_override(action, overrides)
    if override is not None:
        return None if override == IGNORE_ACTION else override
    text = " ".join(action.split())
    for pattern, kind in _COMPILED:
        if pattern.search(text):
            return kind
    raise UnknownActionError(f"Unrecognised action: {action!r}")


def known_action_share(values: list[str]) -> float:
    """Share of non-empty ``values`` that :func:`classify_action` recognises."""
    seen = [v for v in values if v and v.strip()]
    if not seen:
        return 0.0
    hits = 0
    for v in seen:
        try:
            classify_action(v)
        except UnknownActionError:
            continue
        hits += 1
    return hits / len(seen)
