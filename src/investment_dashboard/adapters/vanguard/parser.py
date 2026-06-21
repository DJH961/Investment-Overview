"""Vanguard CSV parser (spec §5.2).

Brokerage CSV columns::

    Account Number, Trade Date, Settlement Date, Transaction Type,
    Transaction Description, Investment Name, Symbol, Shares, Share Price,
    Principal Amount, Commission Fees, Net Amount, Accrued Interest, Account Type

Tolerant of missing trailing columns and of slightly different header
casing. Sweep rows are silently dropped — the count of skipped sweeps is
reported alongside the parsed rows.

Numbers and dates are assumed **US-locale** (dot decimal, ``MM/DD/YYYY``);
see :mod:`investment_dashboard.adapters.locale_parsing`. Per-row problems
(unknown action, un-parseable / EU-locale cell) are *collected* into the
returned :class:`ParseReport` rather than aborting the whole import (audit
D3); rows that parse but fail a light consistency check are kept and
surfaced as warnings (audit D4).
"""

from __future__ import annotations

import csv
import hashlib
import io
from collections.abc import Iterator
from dataclasses import dataclass
from decimal import Decimal

from investment_dashboard.adapters.importer_types import (
    ParsedTransactionRow,
    ParseReport,
    RowIssue,
    UnknownActionError,
)
from investment_dashboard.adapters.locale_parsing import (
    LocaleError,
    parse_us_date,
    parse_us_decimal,
)
from investment_dashboard.adapters.row_validation import validate_row
from investment_dashboard.adapters.vanguard.action_map import map_transaction_type


@dataclass(frozen=True)
class VanguardParseResult(ParseReport):
    """Backwards-compatible name for :class:`ParseReport`.

    Retained so existing call sites/tests that import ``VanguardParseResult``
    keep working; carries the new ``unknown_actions`` / ``errors`` /
    ``warnings`` fields from :class:`ParseReport`.
    """


def _normalise_header(h: str) -> str:
    return h.strip().lower()


def _hash_external_id(*parts: object) -> str:
    payload = "|".join(str(p) for p in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def _iter_dict_rows(content: str) -> Iterator[tuple[int, dict[str, str]]]:
    lines = content.splitlines()
    header_idx = -1
    for i, line in enumerate(lines):
        lowered = line.lower()
        if "trade date" in lowered and "transaction type" in lowered:
            header_idx = i
            break
    if header_idx == -1:
        raise ValueError("Vanguard CSV: no header containing 'Trade Date' and 'Transaction Type'")
    body = "\n".join(lines[header_idx:])
    reader = csv.DictReader(io.StringIO(body))
    if reader.fieldnames is None:
        return
    reader.fieldnames = [_normalise_header(h) for h in reader.fieldnames]
    for row in reader:
        if not row.get("transaction type"):
            continue
        yield header_idx + reader.line_num, row


def _parse_row(raw: dict[str, str]) -> ParsedTransactionRow | None:
    """Parse one dict row. Returns ``None`` for a sweep; raises on a bad cell."""
    txn_type = raw["transaction type"]
    kind = map_transaction_type(txn_type)
    if kind is None:
        return None  # sweep — caller counts it

    trade_date = parse_us_date(raw["trade date"])
    settlement_raw = raw.get("settlement date") or ""
    settlement = parse_us_date(settlement_raw) if settlement_raw.strip() else None
    symbol = (raw.get("symbol") or "").strip() or None
    quantity = parse_us_decimal(raw.get("shares"))
    price = parse_us_decimal(raw.get("share price"))
    commission = parse_us_decimal(raw.get("commission fees")) or Decimal(0)
    net = parse_us_decimal(raw.get("net amount"))
    principal = parse_us_decimal(raw.get("principal amount"))

    # Sign conventions: Vanguard signs ``Net Amount`` so buys are
    # negative, sells/dividends positive. Quantities are positive for
    # buys, but the ledger expects negative for sells.
    if kind == "sell" and quantity is not None and quantity > 0:
        quantity = -quantity

    gross = (
        principal
        if principal is not None
        else (quantity * price if (quantity is not None and price is not None) else None)
    )

    external_id = _hash_external_id(
        trade_date.isoformat(),
        txn_type,
        symbol or "",
        quantity or "",
        price or "",
        net or "",
    )

    return ParsedTransactionRow(
        date=trade_date,
        settlement_date=settlement,
        kind=kind,
        symbol=symbol,
        quantity=quantity,
        price_native=price,
        gross_native=gross,
        fees_native=commission if commission != 0 else None,
        net_native=net,
        description=raw.get("transaction description") or raw.get("investment name"),
        external_id=external_id,
        source="import_vanguard_csv",
        name=(raw.get("investment name") or "").strip() or None,
    )


def parse_vanguard_csv(content: str) -> VanguardParseResult:
    """Parse a Vanguard brokerage CSV into a :class:`ParseReport`.

    Sweeps are dropped (counted in ``sweeps_dropped``); unknown transaction
    types and bad/EU-locale cells are collected as per-row errors instead of
    aborting; light consistency-check failures are reported as warnings.
    """
    rows: list[ParsedTransactionRow] = []
    sweeps_dropped = 0
    unknown_actions: list[str] = []
    errors: list[RowIssue] = []
    warnings: list[RowIssue] = []

    for line, raw in _iter_dict_rows(content):
        txn_type = raw.get("transaction type", "")
        try:
            parsed = _parse_row(raw)
        except UnknownActionError as exc:
            unknown_actions.append(txn_type)
            errors.append(RowIssue(message=str(exc), line=line, raw=txn_type))
            continue
        except (LocaleError, ValueError) as exc:
            errors.append(RowIssue(message=str(exc), line=line, raw=txn_type))
            continue
        if parsed is None:
            sweeps_dropped += 1
            continue
        rows.append(parsed)
        for warn in validate_row(parsed):
            warnings.append(RowIssue(message=warn, line=line, raw=txn_type))

    return VanguardParseResult(
        rows=rows,
        sweeps_dropped=sweeps_dropped,
        unknown_actions=unknown_actions,
        errors=errors,
        warnings=warnings,
    )
