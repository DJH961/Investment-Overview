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

    Optional v2.2 phase (b) fields (``name`` / ``asset_class`` /
    ``native_currency`` / ``expense_ratio``) carry whatever metadata
    the broker export already exposes, so the importer can pre-seed
    the ``Instrument`` row instead of inserting an empty ``'unknown'``
    stub. ``None`` means "I don't know; let the enrichment service
    figure it out".
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
    name: str | None = None
    asset_class: str | None = None
    native_currency: str | None = None
    expense_ratio: Decimal | None = None


class UnknownActionError(ValueError):
    """Raised when a broker action string isn't in the action map."""
