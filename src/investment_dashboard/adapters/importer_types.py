"""Parsed-row dataclass shared by both broker importers."""

from __future__ import annotations

from dataclasses import dataclass, field
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


@dataclass(frozen=True)
class RowIssue:
    """One row-level problem that did not abort the whole import.

    ``line`` is the 1-based source line/row number when the parser can
    attribute it (``None`` for whole-file problems). ``message`` is a
    short human-readable description and ``raw`` carries a truncated copy
    of the offending row for context in the import report.
    """

    message: str
    line: int | None = None
    raw: str = ""


@dataclass(frozen=True)
class ParseReport:
    """Structured outcome of parsing one broker export (audit D3/D4).

    Replaces the old all-or-nothing "raise on the first bad row" contract:
    parsers now collect per-row problems and keep going so a single
    ``MERGER`` row no longer discards a 100-row import.

    * ``rows`` — the rows that parsed cleanly and will be written.
    * ``sweeps_dropped`` — internal settlement-fund sweeps intentionally
      discarded (not an error).
    * ``errors`` — rows that were **skipped** (unknown action, un-parseable
      cell, EU-locale value). Each is also reflected in ``unknown_actions``
      when it is an unmapped action string, for backward compatibility.
    * ``warnings`` — rows that were **kept** but failed a light consistency
      check (audit D4), surfaced so the user can eyeball them.
    """

    rows: list[ParsedTransactionRow]
    sweeps_dropped: int = 0
    unknown_actions: list[str] = field(default_factory=list)
    errors: list[RowIssue] = field(default_factory=list)
    warnings: list[RowIssue] = field(default_factory=list)
