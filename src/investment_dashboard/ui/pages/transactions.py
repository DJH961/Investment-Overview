"""Transactions page (spec §8.3) — filterable ledger + manual entry + CSV import."""

from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from nicegui import events, ui
from sqlalchemy import select

from investment_dashboard.db import session_scope
from investment_dashboard.models import Account, Transaction
from investment_dashboard.models.transaction import TransactionKind, TransactionSource
from investment_dashboard.repositories import (
    instrument_overrides_repo,
    instruments_repo,
    transactions_repo,
)
from investment_dashboard.services import display_currency_service
from investment_dashboard.services.importer_service import Broker, import_csv
from investment_dashboard.services.instrument_enrichment_service import (
    QUOTE_TYPE_MAP,
    effective_instrument,
)
from investment_dashboard.ui.components import page_header, section
from investment_dashboard.ui.components.kpi_card import dual_kpi_card, kpi_card
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import fmt_money
from investment_dashboard.ui.pages._ledger_query import (
    LedgerFilters,
    list_ledger_rows,
    summarize_ledger,
)

PATH = "/transactions"

log = logging.getLogger(__name__)


def _kinds() -> list[str]:
    return [k.value for k in TransactionKind]


def _decimal_or_none(text: str) -> Decimal | None:
    if not text.strip():
        return None
    try:
        return Decimal(text.strip())
    except InvalidOperation:
        return None


def _all_accounts() -> list[Account]:
    with session_scope() as session:
        return list(session.scalars(select(Account).order_by(Account.account_label)).all())


def register() -> None:
    @ui.page(PATH)
    def _transactions() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Transactions", current=PATH):
            page_header("Transactions", subtitle="Master ledger")

            filters: dict[str, Any] = {
                "account_id": None,
                "kind": None,
                "symbol": None,
            }
            accounts = _all_accounts()
            account_options = {a.id: a.account_label for a in accounts}

            with session_scope() as session:
                display_ccy = display_currency_service.get_display_currency(session)
                fx_rate = display_currency_service.current_rate(session, quote="USD")
                summary = summarize_ledger(session, fx_rate=fx_rate)
            with ui.row().classes("gap-md flex-wrap w-full"):
                kpi_card("Transactions", f"{summary.count:,}")
                kpi_card("Buys", f"{summary.buy_count:,}")
                kpi_card("Sells", f"{summary.sell_count:,}")
                dual_kpi_card(
                    "Avg trade size",
                    fmt_money(summary.avg_trade_size_eur, "EUR"),
                    fmt_money(summary.avg_trade_size_usd, "USD"),
                    primary=display_ccy,
                )

            with ui.row().classes("items-end gap-md flex-wrap w-full"):
                ui.select(
                    {None: "All accounts", **account_options},
                    value=None,
                    label="Account",
                    on_change=lambda e: _on_filter("account_id", e.value),
                ).classes("min-w-[12rem]").props("outlined dense")
                ui.select(
                    {None: "All kinds", **{k: k for k in _kinds()}},
                    value=None,
                    label="Kind",
                    on_change=lambda e: _on_filter("kind", e.value),
                ).classes("min-w-[10rem]").props("outlined dense")
                ui.input(
                    label="Symbol",
                    on_change=lambda e: _on_filter("symbol", (e.value or "").upper() or None),
                ).classes("min-w-[8rem]").props("outlined dense")
                ui.space()
                ui.button(
                    "New transaction",
                    icon="add",
                    on_click=lambda: _open_new_modal(accounts),
                ).props("unelevated color=primary no-caps")
                ui.button(
                    "Edit instrument",
                    icon="edit",
                    on_click=_open_instrument_override_modal,
                ).props("flat color=primary no-caps")
                ui.button(
                    "Import",
                    icon="upload_file",
                    on_click=lambda: _open_import_modal(accounts),
                ).props("flat color=primary no-caps")

            with section():
                grid = ui.aggrid(
                    {
                        "columnDefs": [
                            {
                                "headerName": "Date",
                                "field": "date",
                                "sortable": True,
                                "filter": True,
                            },
                            {"headerName": "Account", "field": "account", "filter": True},
                            {"headerName": "Kind", "field": "kind", "filter": True},
                            {"headerName": "Symbol", "field": "symbol", "filter": True},
                            {"headerName": "Qty", "field": "qty", "type": "rightAligned"},
                            {"headerName": "Price", "field": "price", "type": "rightAligned"},
                            {"headerName": "Fees", "field": "fees", "type": "rightAligned"},
                            {"headerName": "Net EUR", "field": "net_eur", "type": "rightAligned"},
                            {"headerName": "Net USD", "field": "net_usd", "type": "rightAligned"},
                            {"headerName": "Source", "field": "source"},
                        ],
                        "rowData": [],
                        "defaultColDef": {"resizable": True, "sortable": True},
                        "pagination": True,
                        "paginationAutoPageSize": True,
                    }
                ).classes("ag-theme-alpine w-full h-[60vh]")

            def _refresh() -> None:
                with session_scope() as session:
                    fx_rate = display_currency_service.current_rate(session, quote="USD")
                    rows = list_ledger_rows(
                        session,
                        LedgerFilters(
                            account_id=filters["account_id"],
                            kind=filters["kind"],
                            instrument_symbol=filters["symbol"],
                        ),
                        fx_rate=fx_rate,
                    )
                grid.options["rowData"] = rows
                grid.update()

            def _on_filter(key: str, value: Any) -> None:
                filters[key] = value
                _refresh()

            _refresh()


def _open_new_modal(accounts: list[Account]) -> None:  # pragma: no cover - UI
    with ui.dialog() as dlg, ui.card().classes("min-w-[28rem]"):
        ui.label("New Transaction").classes("text-h6")
        account_sel = ui.select({a.id: a.account_label for a in accounts}, label="Account").classes(
            "w-full"
        )
        kind_sel = ui.select(_kinds(), value="buy", label="Kind").classes("w-full")
        date_in = ui.input("Date (YYYY-MM-DD)", value=date.today().isoformat()).classes("w-full")
        symbol_in = ui.input("Symbol (blank for cash kinds)").classes("w-full")
        qty_in = ui.input("Quantity").classes("w-full")
        price_in = ui.input("Price (native ccy)").classes("w-full")
        fees_in = ui.input("Fees (native ccy)").classes("w-full")
        net_in = ui.input("Net amount (native, signed)").classes("w-full")
        desc_in = ui.input("Description").classes("w-full")

        def _save() -> None:
            if account_sel.value is None:
                ui.notify("Pick an account", type="warning")
                return
            try:
                txn_date = date.fromisoformat((date_in.value or "").strip())
            except ValueError:
                ui.notify("Bad date — use YYYY-MM-DD", type="negative")
                return
            with session_scope() as session:
                instrument_id: int | None = None
                sym = (symbol_in.value or "").strip().upper()
                if sym:
                    instr = instruments_repo.get_or_create(session, symbol=sym)
                    instrument_id = instr.id
                txn = Transaction(
                    account_id=account_sel.value,
                    date=txn_date,
                    kind=kind_sel.value,
                    instrument_id=instrument_id,
                    quantity=_decimal_or_none(qty_in.value or ""),
                    price_native=_decimal_or_none(price_in.value or ""),
                    fees_native=_decimal_or_none(fees_in.value or ""),
                    net_native=_decimal_or_none(net_in.value or ""),
                    description=(desc_in.value or "").strip() or None,
                    source=TransactionSource.MANUAL,
                )
                inserted = transactions_repo.insert_transaction(session, txn)
            if inserted is None:
                ui.notify("Duplicate — not inserted", type="warning")
            else:
                ui.notify("Saved", type="positive")
            dlg.close()
            ui.navigate.to(PATH)  # cheap full refresh

        with ui.row().classes("justify-end w-full gap-sm"):
            ui.button("Cancel", on_click=dlg.close).props("flat")
            ui.button("Save", on_click=_save).props("color=primary")
    dlg.open()


def _open_import_modal(accounts: list[Account]) -> None:  # pragma: no cover - UI
    with ui.dialog() as dlg, ui.card().classes("min-w-[28rem]"):
        ui.label("Import broker CSV / XLSX").classes("text-h6")
        broker_sel = ui.select(
            {b.value: b.value.title() for b in Broker}, value=Broker.FIDELITY.value, label="Broker"
        ).classes("w-full")
        account_sel = ui.select({a.id: a.account_label for a in accounts}, label="Account").classes(
            "w-full"
        )
        status = ui.label("").classes("text-caption")

        def _on_upload(e: events.UploadEventArguments) -> None:
            if account_sel.value is None:
                ui.notify("Pick an account first", type="warning")
                return
            broker = Broker(broker_sel.value)
            raw = e.content.read()
            # Vanguard's Full History export is an .xlsx workbook (ZIP).
            # For everything else we still decode to text so the existing
            # CSV parsers stay on their happy path.
            content: str | bytes
            if broker == Broker.VANGUARD and raw[:4] == b"PK\x03\x04":
                content = raw
            else:
                content = raw.decode("utf-8-sig", errors="replace")
            try:
                with session_scope() as session:
                    result = import_csv(
                        session,
                        broker=broker,
                        account_id=account_sel.value,
                        content=content,
                    )
            except Exception as exc:
                log.exception("CSV import failed")
                ui.notify(f"Import failed: {exc}", type="negative")
                return
            status.text = (
                f"Inserted {result.inserted}, duplicates {result.duplicates}, "
                f"sweeps dropped {result.sweeps_dropped}"
            )
            if result.unknown_actions:
                status.text += f", unknown actions: {sorted(result.unknown_actions)}"
            ui.notify(status.text, type="positive")

        ui.upload(on_upload=_on_upload, auto_upload=True).props("accept=.csv,.xlsx").classes(
            "w-full"
        )
        with ui.row().classes("justify-end w-full"):
            ui.button("Close", on_click=dlg.close).props("flat")
    dlg.open()


# v2.2 phase (b) — instrument display overrides editor. Lives next to
# the manual-transaction modal so the user has one obvious place to fix
# the name / asset class / TER yfinance auto-detected wrong.
_ASSET_CLASS_OPTIONS = sorted({*QUOTE_TYPE_MAP.values(), "cash", "savings", "unknown"})


def _open_instrument_override_modal() -> None:  # pragma: no cover - UI
    with ui.dialog() as dlg, ui.card().classes("min-w-[32rem]"):
        ui.label("Edit instrument").classes("text-h6")
        ui.label(
            "Override the display name, asset class, or expense ratio for one symbol. "
            "Overrides only affect what's shown — the ledger row is untouched."
        ).classes("text-caption opacity-70")

        with session_scope() as session:
            instruments = list(instruments_repo.list_instruments(session))
        if not instruments:
            ui.label("No instruments yet — import a CSV or add a transaction first.").classes(
                "text-caption opacity-70"
            )
            with ui.row().classes("justify-end w-full"):
                ui.button("Close", on_click=dlg.close).props("flat")
            dlg.open()
            return

        symbol_to_id = {i.symbol: i.id for i in instruments}
        symbol_sel = ui.select(
            list(symbol_to_id.keys()),
            value=instruments[0].symbol,
            label="Symbol",
        ).classes("w-full")
        name_in = ui.input("Display name override").classes("w-full")
        class_sel = ui.select(
            ["", *_ASSET_CLASS_OPTIONS],
            value="",
            label="Asset class override",
        ).classes("w-full")
        ter_in = ui.input("Expense ratio override (e.g. 0.0003)").classes("w-full")
        effective_lbl = ui.label("").classes("text-caption opacity-70")

        def _reload(_evt: Any | None = None) -> None:
            sym = symbol_sel.value
            instrument_id = symbol_to_id.get(sym) if sym else None
            if instrument_id is None:
                return
            with session_scope() as session:
                instr = next(i for i in instruments if i.id == instrument_id)
                ov = instrument_overrides_repo.get(session, instrument_id)
                eff = effective_instrument(instr, ov)
            name_in.value = (ov.name_override if ov is not None else "") or ""
            class_sel.value = (ov.asset_class_override if ov is not None else "") or ""
            ter_in.value = (
                ""
                if (ov is None or ov.expense_ratio_override is None)
                else str(ov.expense_ratio_override)
            )
            effective_lbl.text = (
                f"Effective → name: {eff.name or '—'}  ·  asset class: {eff.asset_class}  "
                f"·  TER: {eff.expense_ratio if eff.expense_ratio is not None else '—'}"
            )

        symbol_sel.on("update:model-value", _reload)
        _reload()

        def _save() -> None:
            sym = symbol_sel.value
            instrument_id = symbol_to_id.get(sym) if sym else None
            if instrument_id is None:
                ui.notify("Pick a symbol", type="warning")
                return
            name_val = (name_in.value or "").strip() or None
            class_val = (class_sel.value or "").strip() or None
            ter_val = _decimal_or_none(ter_in.value or "")
            with session_scope() as session:
                instrument_overrides_repo.upsert(
                    session,
                    instrument_id,
                    name_override=name_val,
                    asset_class_override=class_val,
                    expense_ratio_override=ter_val,
                )
            ui.notify("Override saved", type="positive")
            dlg.close()
            ui.navigate.to(PATH)

        with ui.row().classes("justify-end w-full gap-sm"):
            ui.button("Cancel", on_click=dlg.close).props("flat")
            ui.button("Save", on_click=_save).props("color=primary")
    dlg.open()
