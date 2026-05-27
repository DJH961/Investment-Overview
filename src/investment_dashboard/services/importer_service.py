"""CSV importer service.

Glue between the broker parsers (``adapters/fidelity``, ``adapters/vanguard``)
and the database. Resolves each row's symbol to an :class:`Instrument`,
attaches the date's FX rate (from :mod:`fx_service`, with forward-fill on
weekends), and writes via :func:`transactions_repo.insert_transaction`
so the ``UNIQUE(account_id, external_id)`` constraint deduplicates
re-imports (spec §5.1).
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum

from sqlalchemy.orm import Session

from investment_dashboard.adapters.fidelity.parser import parse_fidelity_csv
from investment_dashboard.adapters.importer_types import (
    ParsedTransactionRow,
    UnknownActionError,
)
from investment_dashboard.adapters.vanguard.parser import parse_vanguard_csv
from investment_dashboard.adapters.vanguard.xlsx_parser import parse_vanguard_xlsx
from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    instruments_repo,
    transactions_repo,
)
from investment_dashboard.services import fx_service

log = logging.getLogger(__name__)

ZERO = Decimal(0)


class Broker(StrEnum):
    FIDELITY = "fidelity"
    VANGUARD = "vanguard"


@dataclass(frozen=True)
class ImportResult:
    """Outcome of one CSV import."""

    inserted: int
    duplicates: int
    sweeps_dropped: int
    unknown_actions: list[str]


def _parse(
    broker: Broker, content: str | bytes
) -> tuple[Sequence[ParsedTransactionRow], int, list[str]]:
    unknowns: list[str] = []
    sweeps = 0
    rows: list[ParsedTransactionRow] = []
    try:
        if broker == Broker.FIDELITY:
            text = (
                content.decode("utf-8-sig", errors="replace")
                if isinstance(content, bytes)
                else content
            )
            rows = list(parse_fidelity_csv(text))
        # Vanguard supports two formats: the brokerage CSV (last 18
        # months) and the Excel-formatted Full History report (no
        # 18-month cap). We detect the workbook by the standard ZIP
        # magic bytes (``PK\x03\x04``) so the UI can hand us either.
        elif isinstance(content, bytes) and content[:4] == b"PK\x03\x04":
            xlsx_result = parse_vanguard_xlsx(content)
            rows = xlsx_result.rows
            sweeps = xlsx_result.sweeps_dropped
        else:
            text = (
                content.decode("utf-8-sig", errors="replace")
                if isinstance(content, bytes)
                else content
            )
            csv_result = parse_vanguard_csv(text)
            rows = csv_result.rows
            sweeps = csv_result.sweeps_dropped
    except UnknownActionError as exc:
        # Surface as one entry; the user can fix the action map.
        unknowns.append(str(exc))
    return rows, sweeps, unknowns


def import_csv(
    session: Session,
    *,
    broker: Broker,
    account_id: int,
    content: str | bytes,
) -> ImportResult:
    """Parse ``content`` and insert rows under ``account_id``.

    ``content`` is the raw broker export. For Fidelity this is always a
    CSV (text or bytes). For Vanguard it may be either the brokerage CSV
    (text/bytes) or the Full History ``.xlsx`` workbook (bytes); the
    importer dispatches on the ZIP magic bytes at the head of the file.

    Idempotent: re-importing the same export writes zero new rows because
    the parser's ``external_id`` is a sha256 of the row's stable fields
    and the table has a ``UNIQUE(account_id, external_id)`` constraint.
    """
    account = accounts_repo.get_account(session, account_id)
    if account is None:
        raise ValueError(f"Unknown account_id={account_id}")
    parsed_rows, sweeps_dropped, unknown_actions = _parse(broker, content)

    inserted = 0
    duplicates = 0
    for prow in parsed_rows:
        # Resolve symbol → instrument.
        instrument_id: int | None = None
        if prow.symbol:
            instr = instruments_repo.get_or_create(
                session,
                symbol=prow.symbol,
                native_currency=account.native_currency,
                asset_class="etf",
            )
            instrument_id = instr.id

        # FX: cache the EUR rate for the trade date.
        fx_rate: Decimal | None
        net_eur: Decimal | None
        if account.native_currency == "EUR":
            fx_rate = Decimal(1)
            net_eur = prow.net_native
        else:
            fx_rate = fx_service.get_rate_eur_to_quote(session, prow.date)
            if fx_rate is not None and prow.net_native is not None and fx_rate != 0:
                net_eur = prow.net_native / fx_rate
            else:
                net_eur = None

        txn = Transaction(
            account_id=account_id,
            instrument_id=instrument_id,
            date=prow.date,
            settlement_date=prow.settlement_date,
            kind=prow.kind,
            quantity=prow.quantity,
            price_native=prow.price_native,
            gross_native=prow.gross_native,
            fees_native=prow.fees_native,
            net_native=prow.net_native,
            fx_rate_to_eur=fx_rate,
            net_eur=net_eur,
            description=prow.description,
            external_id=prow.external_id,
            source=prow.source,
        )
        result = transactions_repo.insert_transaction(session, txn)
        if result is None:
            duplicates += 1
        else:
            inserted += 1

    return ImportResult(
        inserted=inserted,
        duplicates=duplicates,
        sweeps_dropped=sweeps_dropped,
        unknown_actions=unknown_actions,
    )
