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
from dataclasses import dataclass, field
from datetime import date
from enum import StrEnum

from sqlalchemy.orm import Session

from investment_dashboard.adapters.fidelity.parser import parse_fidelity_csv
from investment_dashboard.adapters.importer_types import (
    ParsedTransactionRow,
    ParseReport,
    RowIssue,
)
from investment_dashboard.adapters.vanguard.parser import parse_vanguard_csv
from investment_dashboard.adapters.vanguard.settlement import inject_settlement_legs
from investment_dashboard.adapters.vanguard.xlsx_parser import parse_vanguard_xlsx
from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    transactions_repo,
)
from investment_dashboard.services import (
    instrument_enrichment_service,
    snapshots_service,
    transaction_fx_service,
)

log = logging.getLogger(__name__)


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
    #: Trade dates whose EUR→USD rate could not be resolved even after
    #: retrying the FX refresh, so the row's frozen legs are incomplete.
    #: Empty on a healthy import. The boot/Settings recalculation will keep
    #: retrying these until accurate data lands.
    fx_missing_dates: list[date] = field(default_factory=list)
    #: Rows that were **skipped** because the parser couldn't read them
    #: (unknown action, un-parseable / EU-locale cell). Collected rather
    #: than aborting the whole import (audit D3/D5).
    errors: list[RowIssue] = field(default_factory=list)
    #: Rows that were **imported** but failed a light consistency check
    #: (negative price, amount not reconciling with quantity×price) — worth
    #: the user's attention (audit D4).
    warnings: list[RowIssue] = field(default_factory=list)
    #: Symbols the data provider couldn't resolve (delisted, a typo, or the
    #: provider was offline), so the instrument stays an ``unknown`` stub
    #: until a later refresh (audit D2).
    unresolved_symbols: list[str] = field(default_factory=list)


def _parse(broker: Broker, content: str | bytes) -> ParseReport:
    if broker == Broker.FIDELITY:
        text = (
            content.decode("utf-8-sig", errors="replace") if isinstance(content, bytes) else content
        )
        return parse_fidelity_csv(text)
    # Vanguard supports two formats: the brokerage CSV (last 18
    # months) and the Excel-formatted Full History report (no
    # 18-month cap). We detect the workbook by the standard ZIP
    # magic bytes (``PK\x03\x04``) so the UI can hand us either.
    if isinstance(content, bytes) and content[:4] == b"PK\x03\x04":
        return parse_vanguard_xlsx(content)
    text = content.decode("utf-8-sig", errors="replace") if isinstance(content, bytes) else content
    return parse_vanguard_csv(text)


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
    report = _parse(broker, content)
    parsed_rows: Sequence[ParsedTransactionRow] = report.rows

    # Vanguard routes every cash movement through its VMFXX settlement fund,
    # but the export drops those internal sweeps. Reconstruct the VMFXX legs
    # so deposits land in the settlement fund and security buys draw it down
    # (spec §5.2; v2.9.6). Fidelity exports SPAXX explicitly, so this is
    # Vanguard-only.
    if broker == Broker.VANGUARD and parsed_rows:
        parsed_rows = inject_settlement_legs(parsed_rows)

    # Safe-FX procedure (spec §5.6): before freezing any trade-date leg,
    # make sure FX history actually covers the earliest trade in this batch,
    # retrying the refresh so a transient network/server glitch doesn't bake
    # in a wrong (or missing) rate. Any row left without a rate is still
    # written — with a NULL leg — so the boot/Settings backfill can repair it
    # once accurate data lands, rather than silently storing a bad number.
    if parsed_rows:
        earliest = min(prow.date for prow in parsed_rows)
        transaction_fx_service.ensure_fx_coverage(session, earliest_needed=earliest)

    inserted = 0
    duplicates = 0
    fx_missing: set[date] = set()
    inserted_dates: set[date] = set()
    # Symbols the data provider couldn't resolve during enrichment (audit D2).
    unresolved: set[str] = set()
    for prow in parsed_rows:
        # Resolve symbol → instrument, enriching as needed (yfinance
        # call is best-effort and cached per-process).
        instrument_id: int | None = None
        if prow.symbol:
            instr = instrument_enrichment_service.ensure_instrument(
                session,
                symbol=prow.symbol,
                fallback_native_currency=account.native_currency,
                parsed_name=prow.name,
                parsed_asset_class=prow.asset_class,
                parsed_native_currency=prow.native_currency,
                parsed_expense_ratio=prow.expense_ratio,
                on_unresolved=unresolved.add,
            )
            instrument_id = instr.id

        # Freeze both currency legs (EUR + USD) at the trade-date rate. For
        # USD-native accounts ``net_usd`` is the booked amount verbatim and
        # EUR is derived; for EUR-native it's the mirror; other currencies
        # derive both. A NULL leg flags an FX-history gap to revisit.
        legs = transaction_fx_service.compute_legs(
            session,
            native_currency=account.native_currency,
            net_native=prow.net_native,
            on=prow.date,
        )
        if not legs.complete:
            fx_missing.add(prow.date)

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
            fx_rate_to_eur=legs.fx_rate_to_eur,
            net_eur=legs.net_eur,
            net_usd=legs.net_usd,
            description=prow.description,
            external_id=prow.external_id,
            source=prow.source,
        )
        result = transactions_repo.insert_transaction(session, txn)
        if result is None:
            duplicates += 1
        else:
            inserted += 1
            inserted_dates.add(prow.date)

    # Any newly-inserted past-dated row invalidates every cached daily close on
    # or after the earliest one, so the affected window of /monthly, /yearly and
    # the equity curve recomputes lazily against the imported history.
    if inserted_dates:
        snapshots_service.invalidate_for_trade_dates(session, inserted_dates)

    return ImportResult(
        inserted=inserted,
        duplicates=duplicates,
        sweeps_dropped=report.sweeps_dropped,
        unknown_actions=report.unknown_actions,
        fx_missing_dates=sorted(fx_missing),
        errors=report.errors,
        warnings=report.warnings,
        unresolved_symbols=sorted(unresolved),
    )
