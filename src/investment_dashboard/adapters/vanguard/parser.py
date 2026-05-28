"""Vanguard CSV parser (spec §5.2).

Brokerage CSV columns::

    Account Number, Trade Date, Settlement Date, Transaction Type,
    Transaction Description, Investment Name, Symbol, Shares, Share Price,
    Principal Amount, Commission Fees, Net Amount, Accrued Interest, Account Type

Tolerant of missing trailing columns and of slightly different header
casing. Sweep rows are silently dropped — the count of skipped sweeps is
reported alongside the parsed rows.
"""

from __future__ import annotations

import csv
import hashlib
import io
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from investment_dashboard.adapters.importer_types import (
    ParsedTransactionRow,
    UnknownActionError,
)
from investment_dashboard.adapters.vanguard.action_map import map_transaction_type

_DATE_FORMATS = ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y")


@dataclass(frozen=True)
class VanguardParseResult:
    """Output of :func:`parse_vanguard_csv`."""

    rows: list[ParsedTransactionRow]
    sweeps_dropped: int


def _normalise_header(h: str) -> str:
    return h.strip().lower()


def _parse_date(s: str) -> date:
    s = s.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unrecognised date format: {s!r}")


def _parse_decimal(s: str | None) -> Decimal | None:
    if s is None:
        return None
    cleaned = s.replace(",", "").replace("$", "").strip()
    if not cleaned or cleaned in {"-", "--"}:
        return None
    try:
        return Decimal(cleaned)
    except InvalidOperation as exc:
        raise ValueError(f"Bad decimal: {s!r}") from exc


def _hash_external_id(*parts: object) -> str:
    payload = "|".join(str(p) for p in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def _iter_dict_rows(content: str) -> Iterator[dict[str, str]]:
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
        yield row


def parse_vanguard_csv(content: str) -> VanguardParseResult:
    """Parse a Vanguard brokerage CSV. Returns parsed rows + sweep count."""
    rows: list[ParsedTransactionRow] = []
    sweeps_dropped = 0

    for raw in _iter_dict_rows(content):
        txn_type = raw["transaction type"]
        try:
            kind = map_transaction_type(txn_type)
        except UnknownActionError:
            raise
        if kind is None:
            sweeps_dropped += 1
            continue

        trade_date = _parse_date(raw["trade date"])
        settlement_raw = raw.get("settlement date") or ""
        settlement = _parse_date(settlement_raw) if settlement_raw.strip() else None
        symbol = (raw.get("symbol") or "").strip() or None
        quantity = _parse_decimal(raw.get("shares"))
        price = _parse_decimal(raw.get("share price"))
        commission = _parse_decimal(raw.get("commission fees")) or Decimal(0)
        net = _parse_decimal(raw.get("net amount"))
        principal = _parse_decimal(raw.get("principal amount"))

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

        rows.append(
            ParsedTransactionRow(
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
        )

    return VanguardParseResult(rows=rows, sweeps_dropped=sweeps_dropped)
