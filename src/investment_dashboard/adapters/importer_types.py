"""Parsed-row dataclass shared by both broker importers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal


@dataclass(frozen=True)
class ParsedTransactionRow:
    """One CSV row mapped to ledger fields, broker-agnostic.

    The importer service is responsible for resolving ``symbol`` to an
    instrument id (via :func:`instruments_repo.get_or_create`) and for
    attaching the FX rate.
    """

    date: date
    settlement_date: date | None
    kind: str  # one of TransactionKind values
    symbol: str | None
    quantity: Decimal | None
    price_native: Decimal | None
    gross_native: Decimal | None
    fees_native: Decimal | None
    net_native: Decimal | None
    description: str | None
    external_id: str
    source: str  # one of TransactionSource values


class UnknownActionError(ValueError):
    """Raised when a broker action string isn't in the action map."""
