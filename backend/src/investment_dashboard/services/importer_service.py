"""CSV importer service.

Glue between the parsers (``adapters/fidelity``, ``adapters/vanguard`` and the
flexible ``adapters/generic`` reader for any other file) and the database.

Known brokers are read with their exact parser first. When that parser can't
read the file (renamed or moved columns, another number format, a re-saved
workbook) or rejects rows, the flexible reader runs too -- with the broker's own
action map -- and whichever result reads more rows wins. A layout the user fixed
on the import page (:class:`LayoutChoice`) always goes through the flexible
reader, and layouts saved with "remember" are applied by header signature.

The ledger side Resolves each row's symbol to an :class:`Instrument`,
attaches the date's FX rate (from :mod:`fx_service`, with forward-fill on
weekends), and writes via :func:`transactions_repo.insert_transaction`
so the ``UNIQUE(account_id, external_id)`` constraint deduplicates
re-imports (spec §5.1).
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date
from decimal import Decimal
from enum import StrEnum

from sqlalchemy.orm import Session

from investment_dashboard.adapters.fidelity.action_map import map_action
from investment_dashboard.adapters.fidelity.parser import parse_fidelity_csv
from investment_dashboard.adapters.generic.parser import (
    DERIVABLE,
    ActionMapper,
    GenericParseReport,
    Layout,
    LayoutChoice,
    parse_generic,
)
from investment_dashboard.adapters.importer_types import (
    ParsedTransactionRow,
    ParseReport,
    RowIssue,
)
from investment_dashboard.adapters.tabular.actions import classify_action
from investment_dashboard.adapters.tabular.reader import UnreadableFileError, is_workbook
from investment_dashboard.adapters.tabular.values import (
    DATE_ORDERS,
    DECIMAL_SEPARATORS,
    DateOrder,
)
from investment_dashboard.adapters.vanguard.action_map import map_transaction_type
from investment_dashboard.adapters.vanguard.parser import parse_vanguard_csv
from investment_dashboard.adapters.vanguard.settlement import inject_settlement_legs
from investment_dashboard.adapters.vanguard.xlsx_parser import parse_vanguard_xlsx
from investment_dashboard.repositories import (
    accounts_repo,
    transactions_repo,
)
from investment_dashboard.services import (
    instrument_enrichment_service,
    intraday_snapshots_service,
    snapshots_service,
    transaction_fx_service,
)

log = logging.getLogger(__name__)


class Broker(StrEnum):
    FIDELITY = "fidelity"
    VANGUARD = "vanguard"
    #: Any other file: the flexible reader with the multi-language action rules.
    GENERIC = "generic"


BROKER_LABELS: dict[Broker, str] = {
    Broker.FIDELITY: "Fidelity",
    Broker.VANGUARD: "Vanguard",
    Broker.GENERIC: "Other / any file",
}


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
    #: The batch the inserted rows belong to (``None`` when nothing was inserted
    #: or the caller did not record a batch).
    import_batch_id: int | None = None


def action_overrides(broker: Broker) -> dict[str, str]:
    """The user's action mapping for ``broker`` (``import.action_overrides.<broker>``)."""
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    value = settings_service.get_or(f"import.action_overrides.{broker.value}", {})
    return dict(value) if isinstance(value, dict) else {}


#: Setting holding layouts remembered from the import page.
COLUMN_PROFILES_KEY = "import.column_profiles"


def _mapper(broker: Broker) -> ActionMapper:
    if broker == Broker.FIDELITY:
        return map_action
    if broker == Broker.VANGUARD:
        return map_transaction_type
    return classify_action


def _source(broker: Broker, content: str | bytes) -> str:
    if broker == Broker.FIDELITY:
        return "import_fidelity_csv"
    if broker == Broker.VANGUARD:
        workbook = isinstance(content, bytes) and is_workbook(content)
        return "import_vanguard_xlsx" if workbook else "import_vanguard_csv"
    return "import_generic"


def choice_to_json(choice: LayoutChoice, headers: Sequence[str]) -> str:
    """Serialise ``choice`` for the saved-layouts setting (columns by header name)."""
    columns: dict[str, str | None] = {}
    for fld, target in choice.columns.items():
        if isinstance(target, int):
            columns[fld] = headers[target] if 0 <= target < len(headers) else None
        else:
            columns[fld] = target
    return json.dumps(
        {
            "columns": columns,
            "decimal": choice.decimal,
            "date_order": choice.date_order,
            "derive": sorted(choice.derive),
        },
        sort_keys=True,
    )


def choice_from_json(raw: str) -> LayoutChoice | None:
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    cols = data.get("columns") or {}
    decimal = data.get("decimal")
    order = data.get("date_order")
    return LayoutChoice(
        columns={str(k): v for k, v in cols.items() if v is None or isinstance(v, str)},
        decimal=decimal if decimal in DECIMAL_SEPARATORS else None,
        date_order=order if order in DATE_ORDERS else None,
        derive=frozenset(d for d in data.get("derive") or () if d in DERIVABLE),
    )


def saved_layout(signature: str) -> LayoutChoice | None:
    """The layout remembered for files with this header signature, if any."""
    if not signature:
        return None
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    profiles = settings_service.get_or(COLUMN_PROFILES_KEY, {})
    raw = profiles.get(signature) if isinstance(profiles, dict) else None
    return choice_from_json(raw) if isinstance(raw, str) else None


def _generic(
    broker: Broker,
    content: str | bytes,
    overrides: Mapping[str, str],
    choice: LayoutChoice | None,
) -> GenericParseReport:
    mapper, source = _mapper(broker), _source(broker, content)
    # Fidelity and Vanguard always export US dates, whatever else changed.
    order: DateOrder | None = None if broker == Broker.GENERIC else "MDY"
    report = parse_generic(
        content,
        choice=choice,
        action_overrides=overrides,
        action_mapper=mapper,
        source=source,
        date_order_default=order,
    )
    if choice is None and report.layout is not None:
        saved = saved_layout(report.layout.signature)
        if saved is not None:
            report = parse_generic(
                content,
                choice=saved,
                action_overrides=overrides,
                action_mapper=mapper,
                source=source,
                date_order_default=order,
            )
    return report


def detect_layout(broker: Broker, content: str | bytes) -> Layout | None:
    """The flexible reader's view of ``content`` (for the column editor), if readable."""
    try:
        return _generic(broker, content, action_overrides(broker), None).layout
    except Exception:
        log.debug("flexible layout detection failed", exc_info=True)
        return None


def _strict(broker: Broker, content: str | bytes, overrides: Mapping[str, str]) -> ParseReport:
    if broker == Broker.FIDELITY:
        text = (
            content.decode("utf-8-sig", errors="replace") if isinstance(content, bytes) else content
        )
        return parse_fidelity_csv(text, overrides)
    # Vanguard supports two formats: the brokerage CSV (last 18
    # months) and the Excel-formatted Full History report (no
    # 18-month cap). We detect the workbook by the standard ZIP
    # magic bytes so the UI can hand us either.
    if isinstance(content, bytes) and is_workbook(content):
        return parse_vanguard_xlsx(content, overrides)
    text = content.decode("utf-8-sig", errors="replace") if isinstance(content, bytes) else content
    return parse_vanguard_csv(text, overrides)


def _parse(
    broker: Broker,
    content: str | bytes,
    overrides: Mapping[str, str] | None = None,
    choice: LayoutChoice | None = None,
) -> ParseReport:
    """Parse with the broker's parser, falling back to the flexible reader.

    ``overrides`` default to the saved action mapping. ``choice`` (a layout the
    user fixed) forces the flexible reader. Raises ``ValueError`` only when no
    reader can make sense of the file.
    """
    if overrides is None:
        overrides = action_overrides(broker)
    if broker == Broker.GENERIC or choice is not None:
        return _generic(broker, content, overrides, choice)
    strict: ParseReport | None = None
    reason = ""
    try:
        strict = _strict(broker, content, overrides)
    except (ValueError, KeyError) as exc:
        reason = str(exc)
    if strict is not None and not strict.errors:
        return strict
    try:
        flexible = _generic(broker, content, overrides, None)
    except UnreadableFileError:
        if strict is not None:
            return strict
        raise
    if strict is not None and (
        len(flexible.rows) < len(strict.rows)
        or (len(flexible.rows) == len(strict.rows) and len(flexible.errors) >= len(strict.errors))
    ):
        return strict
    if not flexible.rows:
        return flexible  # nothing readable yet: the page shows the layout to fix
    label = BROKER_LABELS[broker]
    why = reason or f"{len(strict.errors) if strict else 0} row(s) didn't fit the usual layout"
    note = RowIssue(
        message=(
            f"This file doesn't match the usual {label} export ({why}); it was read with "
            "the flexible importer. Check the columns before confirming."
        )
    )
    return replace(flexible, warnings=[note, *flexible.warnings])


#: Rounding used when comparing a parsed row with an existing transaction.
_QTY_Q = Decimal("0.0001")
_NET_Q = Decimal("0.01")


def _q(value: Decimal | None, quantum: Decimal) -> str:
    return "" if value is None else str(Decimal(value).quantize(quantum))


def content_key(
    on: date, kind: str, symbol: str | None, quantity: Decimal | None, net: Decimal | None
) -> tuple[str, ...]:
    """What makes two transactions "the same" whatever file they came from."""
    return (on.isoformat(), kind, (symbol or "").upper(), _q(quantity, _QTY_Q), _q(net, _NET_Q))


def existing_content_keys(session: Session, account_id: int) -> Counter[tuple[str, ...]]:
    """Multiset of :func:`content_key` over the account's current transactions."""
    keys: Counter[tuple[str, ...]] = Counter()
    for t in transactions_repo.list_transactions(session, account_id=account_id):
        symbol = t.instrument.symbol if t.instrument is not None else None
        keys[content_key(t.date, t.kind, symbol, t.quantity, t.net_native)] += 1
    return keys


def mark_duplicates(
    rows: Sequence[ParsedTransactionRow],
    existing_ids: set[str],
    existing_keys: Counter[tuple[str, ...]],
) -> list[bool]:
    """Per row: already in the ledger, by ``external_id`` or by content.

    The content match catches the same transaction exported in another format
    (CSV vs Excel, renamed columns) whose ``external_id`` hash differs. Each
    existing transaction absorbs at most one incoming row, so two genuine
    identical trades on one day still import when only one is booked.
    """
    remaining = Counter(existing_keys)
    out: list[bool] = []
    for r in rows:
        key = content_key(r.date, r.kind, r.symbol, r.quantity, r.net_native)
        if r.external_id in existing_ids or remaining[key] > 0:
            remaining[key] -= 1
            out.append(True)
        else:
            out.append(False)
    return out


def import_csv(
    session: Session,
    *,
    broker: Broker,
    account_id: int,
    content: str | bytes,
    import_batch_id: int | None = None,
    layout: LayoutChoice | None = None,
) -> ImportResult:
    """Parse ``content`` and insert rows under ``account_id``.

    ``content`` is the raw broker export. For Fidelity this is always a
    CSV (text or bytes). For Vanguard it may be either the brokerage CSV
    (text/bytes) or the Full History ``.xlsx`` workbook (bytes); the
    importer dispatches on the ZIP magic bytes at the head of the file.

    ``import_batch_id`` tags every inserted row with its import batch (see
    ``import_staging.confirm``), so the import can be undone as a whole.

    Idempotent: re-importing the same export writes zero new rows because
    the parser's ``external_id`` is a sha256 of the row's stable fields
    and the table has a ``UNIQUE(account_id, external_id)`` constraint.
    """
    account = accounts_repo.get_account(session, account_id)
    if account is None:
        raise ValueError(f"Unknown account_id={account_id}")
    report = _parse(broker, content, choice=layout)
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

    # Same-content rows already in the ledger (exported in another format) are
    # skipped like exact re-imports; the preview showed them as duplicates.
    existing_ids = {
        t.external_id
        for t in transactions_repo.list_transactions(session, account_id=account_id)
        if t.external_id
    }
    is_dup = mark_duplicates(parsed_rows, existing_ids, existing_content_keys(session, account_id))

    inserted = 0
    duplicates = 0
    fx_missing: set[date] = set()
    fx_missing_rows = 0
    inserted_dates: set[date] = set()
    # Symbols the data provider couldn't resolve during enrichment (audit D2).
    unresolved: set[str] = set()
    for prow, dup in zip(parsed_rows, is_dup, strict=True):
        if dup:
            duplicates += 1
            continue
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
            fx_missing_rows += 1

        txn = transactions_repo.new_transaction(
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
            import_batch_id=import_batch_id,
        )
        result = transactions_repo.insert_transaction(session, txn)
        if result is None:
            duplicates += 1
        else:
            inserted += 1
            inserted_dates.add(prow.date)

    # Any newly-inserted past-dated row invalidates every cached daily close on
    # or after the earliest one, so the affected window of /monthly, /yearly and
    # the equity curve recomputes lazily against the imported history. It also
    # clears the cached intraday 1D/1W curves so stale samples are wiped.
    if inserted_dates:
        snapshots_service.invalidate_for_trade_dates(session, inserted_dates)
        intraday_snapshots_service.clear_week_samples(session)

    if fx_missing:
        log.info(
            "FX-history gap on import: %d transaction(s) on %d date(s) written with NULL legs "
            "for later backfill (%s)",
            fx_missing_rows,
            len(fx_missing),
            ", ".join(d.isoformat() for d in sorted(fx_missing)),
        )

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
