"""Transactions page (spec §8.3) — filterable ledger + manual entry + CSV import."""

from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from nicegui import events, ui
from sqlalchemy import select

from investment_dashboard.db import session_scope
from investment_dashboard.domain.money_market import (
    MANUAL_SETTLEMENT_DESCRIPTION_PREFIX,
    is_settlement_external_id,
    settlement_external_id_for,
)
from investment_dashboard.models import Account, Transaction
from investment_dashboard.models.transaction import TransactionKind, TransactionSource
from investment_dashboard.repositories import (
    instrument_overrides_repo,
    instruments_repo,
    transactions_repo,
)
from investment_dashboard.services import (
    auto_publish,
    display_currency_service,
    manual_entry,
    transaction_fx_service,
)
from investment_dashboard.services.importer_service import Broker, import_csv
from investment_dashboard.services.instrument_enrichment_service import (
    QUOTE_TYPE_MAP,
    effective_instrument,
)
from investment_dashboard.ui.components import confirm_dialog, page_header, section
from investment_dashboard.ui.components.kpi_card import dual_kpi_card, kpi_card
from investment_dashboard.ui.forms import (
    validate_date,
    validate_decimal,
    validate_symbol,
)
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
                "show_sweeps": False,
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

            with ui.row().classes("items-end gap-md flex-nowrap w-full"):
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
                ui.switch(
                    "Show settlement sweeps",
                    value=False,
                    on_change=lambda e: _on_filter("show_sweeps", bool(e.value)),
                ).props("dense").classes("whitespace-nowrap").tooltip(
                    "Auto-generated VMFXX settlement legs are hidden by default; "
                    "they still count towards your VMFXX balance."
                )
                ui.space()
                # Keep the action buttons clustered on a single, never-wrapping
                # line (Import used to drop to a second row when the toolbar got
                # tight).
                with ui.row().classes("items-end gap-sm flex-nowrap"):
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
                                "headerName": "",
                                "field": "edit",
                                "width": 56,
                                "minWidth": 56,
                                "maxWidth": 64,
                                "pinned": "left",
                                "sortable": False,
                                "filter": False,
                                "resizable": False,
                                "cellClass": "inv-edit-cell",
                                "headerTooltip": "Edit transaction",
                            },
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

                def _on_cell_clicked(e: events.GenericEventArguments) -> None:
                    # The pencil column is the only clickable action; ignore
                    # clicks anywhere else so sorting/selection still works.
                    if e.args.get("colId") != "edit":
                        return
                    row = e.args.get("data") or {}
                    txn_id = row.get("id")
                    if txn_id is not None:
                        _open_edit_modal(accounts, int(txn_id))

                grid.on("cellClicked", _on_cell_clicked)

            def _refresh() -> None:
                with session_scope() as session:
                    fx_rate = display_currency_service.current_rate(session, quote="USD")
                    rows = list_ledger_rows(
                        session,
                        LedgerFilters(
                            account_id=filters["account_id"],
                            kind=filters["kind"],
                            instrument_symbol=filters["symbol"],
                            hide_settlement_sweeps=not filters["show_sweeps"],
                        ),
                        fx_rate=fx_rate,
                    )
                # A pencil glyph per row makes "edit" discoverable right in the
                # table instead of a toolbar button (clicking it opens the editor).
                for row in rows:
                    row["edit"] = "✏️"
                grid.options["rowData"] = rows
                grid.update()

            def _on_filter(key: str, value: Any) -> None:
                filters[key] = value
                _refresh()

            _refresh()


def _open_new_modal(accounts: list[Account]) -> None:  # pragma: no cover - UI
    _open_txn_modal(accounts, existing=None)


def _load_txn_snapshot(txn_id: int) -> dict[str, Any] | None:  # pragma: no cover - UI
    with session_scope() as session:
        txn = transactions_repo.get_transaction(session, txn_id)
        if txn is None:
            return None
        symbol = txn.instrument.symbol if txn.instrument is not None else ""
        return {
            "id": txn.id,
            "account_id": txn.account_id,
            "date": txn.date.isoformat(),
            "kind": txn.kind,
            "symbol": symbol,
            "quantity": txn.quantity,
            "price_native": txn.price_native,
            "gross_native": txn.gross_native,
            "fees_native": txn.fees_native,
            "net_native": txn.net_native,
            "description": txn.description or "",
            "source": txn.source,
            "external_id": txn.external_id,
        }


def _open_edit_modal(accounts: list[Account], txn_id: int) -> None:  # pragma: no cover - UI
    snap = _load_txn_snapshot(txn_id)
    if snap is None:
        ui.notify("Transaction not found — it may have been deleted", type="warning")
        return
    if is_settlement_external_id(snap.get("external_id")):
        # This row is an auto-generated settlement leg, not a real cash move.
        # Editing it directly would diverge it from the parent it mirrors, so
        # steer the user to the parent instead of letting them desync it.
        ui.notify(
            "This is an auto-generated settlement (money-market) leg. Edit the "
            "transaction it pairs with — it keeps this leg in sync automatically.",
            type="warning",
        )
        return
    _open_txn_modal(accounts, existing=snap)


def _abs_str(value: Any) -> str:  # pragma: no cover - UI
    return "" if value is None else str(abs(value))


def _open_txn_modal(  # noqa: PLR0915  # pragma: no cover - UI
    accounts: list[Account], *, existing: dict[str, Any] | None
) -> None:
    is_edit = existing is not None
    with ui.dialog() as dlg, ui.card().classes("min-w-[28rem]"):
        ui.label("Edit Transaction" if is_edit else "New Transaction").classes("text-h6")
        account_sel = ui.select(
            {a.id: a.account_label for a in accounts},
            value=existing["account_id"] if is_edit else None,
            label="Account",
        ).classes("w-full")
        kind_sel = ui.select(
            _kinds(), value=existing["kind"] if is_edit else "buy", label="Kind"
        ).classes("w-full")
        date_in = (
            ui.input(
                "Date (YYYY-MM-DD)",
                value=existing["date"] if is_edit else date.today().isoformat(),
            )
            .classes("w-full")
            .props("hide-bottom-space")
        )
        date_in.validation = validate_date
        symbol_in = ui.input(
            "Symbol (blank for cash kinds)", value=existing["symbol"] if is_edit else ""
        ).classes("w-full")
        symbol_in.validation = lambda v: validate_symbol(v, kind=kind_sel.value)
        # Quantity / price / total are entered as positive magnitudes — the
        # kind decides the +/- sign at save time (a sale is cash in, a buy is
        # cash out), so the user can't pick the wrong sign.
        qty_in = ui.input(
            "Quantity", value=_abs_str(existing["quantity"]) if is_edit else ""
        ).classes("w-full")
        qty_in.validation = lambda v: validate_decimal(v, field="Quantity", allow_negative=False)
        price_in = ui.input(
            "Price (native ccy)", value=_abs_str(existing["price_native"]) if is_edit else ""
        ).classes("w-full")
        price_in.validation = lambda v: validate_decimal(v, field="Price", allow_negative=False)
        total_default = ""
        if is_edit:
            total_default = _abs_str(existing["gross_native"] or existing["net_native"])
        total_in = ui.input("Total cost / amount (native)", value=total_default).classes("w-full")
        total_in.validation = lambda v: validate_decimal(v, field="Total", allow_negative=False)
        fees_in = ui.input(
            "Fees (native ccy)", value=_abs_str(existing["fees_native"]) if is_edit else ""
        ).classes("w-full")
        fees_in.validation = lambda v: validate_decimal(v, field="Fees", allow_negative=False)
        desc_in = ui.input("Description", value=existing["description"] if is_edit else "").classes(
            "w-full"
        )
        # The auto money-market leg is only created on insert (editing an
        # existing row never re-derives its paired settlement leg), so the
        # control would be a no-op when editing — only show it for new rows.
        route_mm = None
        if not is_edit:
            route_mm = ui.checkbox("Auto-fill the money-market fund for cash transfers", value=True)
            route_mm.tooltip(
                "Deposits / withdrawals / transfers also buy or sell the account's "
                "settlement (money-market) fund so you don't log it twice."
            )
        hint = ui.label("").classes("text-caption opacity-70")

        def _reconcile_hint() -> None:
            if kind_sel.value not in manual_entry.TRADE_KINDS:
                hint.text = ""
                return
            q = _decimal_or_none(qty_in.value or "")
            p = _decimal_or_none(price_in.value or "")
            t = _decimal_or_none(total_in.value or "")
            figs = manual_entry.reconcile_trade(q, p, t)
            # Fill whichever single field the user left blank.
            if q is None and figs.quantity is not None:
                qty_in.value = str(figs.quantity)
            if p is None and figs.price is not None:
                price_in.value = str(figs.price)
            if t is None and figs.total is not None:
                total_in.value = str(figs.total)
            hint.text = figs.error or "Quantity x price = total OK"

        for field in (qty_in, price_in, total_in):
            field.on("blur", lambda _e: _reconcile_hint())

        def _revalidate() -> None:
            symbol_in.validate()
            _reconcile_hint()

        kind_sel.on_value_change(_revalidate)

        def _save() -> None:  # noqa: PLR0915, PLR0912 - one cohesive save handler
            if account_sel.value is None:
                ui.notify("Pick an account", type="warning")
                return
            inputs = (date_in, symbol_in, qty_in, price_in, total_in, fees_in)
            if not all(f.validate() for f in inputs):
                ui.notify("Fix the highlighted fields first", type="negative")
                return
            try:
                txn_date = date.fromisoformat((date_in.value or "").strip())
            except ValueError:
                ui.notify("Bad date — use YYYY-MM-DD", type="negative")
                return

            kind = kind_sel.value
            q_mag = _decimal_or_none(qty_in.value or "")
            p_mag = _decimal_or_none(price_in.value or "")
            t_mag = _decimal_or_none(total_in.value or "")
            fee_mag = _decimal_or_none(fees_in.value or "")

            quantity: Decimal | None = None
            price_native: Decimal | None = None
            gross_native: Decimal | None = None
            if kind in manual_entry.TRADE_KINDS:
                figs = manual_entry.reconcile_trade(q_mag, p_mag, t_mag)
                if figs.error:
                    hint.text = figs.error
                    ui.notify(figs.error, type="negative")
                    return
                gross = figs.total
                fee = abs(fee_mag) if fee_mag is not None else Decimal(0)
                # A buy/reinvest costs gross + fees; a sale nets gross - fees.
                if kind == TransactionKind.SELL.value:
                    net_mag = (gross or Decimal(0)) - fee
                else:
                    net_mag = (gross or Decimal(0)) + fee
                net_native = manual_entry.signed_net(kind, net_mag)
                quantity = manual_entry.signed_quantity(kind, figs.quantity)
                price_native = abs(figs.price) if figs.price is not None else None
                gross_native = gross
            else:
                # Cash-only kind: the "Total" field is the cash amount.
                net_native = manual_entry.signed_net(kind, t_mag)

            account = next((a for a in accounts if a.id == account_sel.value), None)
            native_ccy = account.native_currency if account else "EUR"
            with session_scope() as session:
                instrument_id: int | None = None
                sym = (symbol_in.value or "").strip().upper()
                if sym:
                    instr = instruments_repo.get_or_create(session, symbol=sym)
                    instrument_id = instr.id
                # Freeze EUR + USD legs at the trade-date rate, like the importer.
                legs = transaction_fx_service.compute_legs(
                    session, native_currency=native_ccy, net_native=net_native, on=txn_date
                )
                fields = {
                    "account_id": account_sel.value,
                    "date": txn_date,
                    "kind": kind,
                    "instrument_id": instrument_id,
                    "quantity": quantity,
                    "price_native": price_native,
                    "gross_native": gross_native,
                    "fees_native": abs(fee_mag) if fee_mag is not None else None,
                    "net_native": net_native,
                    "fx_rate_to_eur": legs.fx_rate_to_eur,
                    "net_eur": legs.net_eur,
                    "net_usd": legs.net_usd,
                    "description": (desc_in.value or "").strip() or None,
                }
                if is_edit:
                    updated = transactions_repo.update_transaction(
                        session, existing["id"], **fields
                    )
                    # Keep the paired (often hidden) settlement leg in lock-step
                    # with the cash it mirrors, so editing a transaction can't
                    # silently diverge the money-market balance. Works for
                    # existing imported rows (linked via ``:vmfxx``) and legacy
                    # manual auto-legs alike (see ``_resync_settlement_leg``).
                    if updated is not None:
                        _resync_settlement_leg(
                            session,
                            parent=updated,
                            old_account_id=existing["account_id"],
                            old_external_id=existing.get("external_id"),
                            old_date=existing["date"],
                            old_net_native=existing["net_native"],
                            native_ccy=native_ccy,
                        )
                    ui.notify("Updated", type="positive")
                else:
                    txn = Transaction(source=TransactionSource.MANUAL, **fields)
                    inserted = transactions_repo.insert_transaction(session, txn)
                    if inserted is not None:
                        _maybe_money_market_leg(
                            session,
                            enabled=bool(route_mm.value) if route_mm is not None else False,
                            parent=inserted,
                            kind=kind,
                            net_native=net_native,
                            native_ccy=native_ccy,
                            txn_date=txn_date,
                        )
                    ui.notify("Saved", type="positive")
            # v3.0 §5.4: a manual ledger edit republishes the live-web blob, but
            # debounced — a burst of edits coalesces into one upload ~2 min after
            # the last change (gated by Settings → Live web companion).
            auto_publish.schedule_publish_after_edit()
            dlg.close()
            ui.navigate.to(PATH)  # cheap full refresh

        with ui.row().classes("justify-end w-full gap-sm"):
            ui.button("Cancel", on_click=dlg.close).props("flat")
            if is_edit:
                ui.button(
                    "Delete",
                    icon="delete",
                    on_click=lambda: _confirm_delete(existing["id"], dlg),
                ).props("flat color=negative no-caps")
            ui.button("Save", on_click=_save).props("color=primary")
    dlg.open()


def _maybe_money_market_leg(  # pragma: no cover - UI
    session: Any,
    *,
    enabled: bool,
    parent: Transaction,
    kind: str,
    net_native: Decimal | None,
    native_ccy: str,
    txn_date: date,
) -> None:
    """Auto-create the paired money-market settlement leg for a cash move.

    The leg is linked to ``parent`` via the ``:vmfxx`` external-id convention so
    a later edit/delete of the parent can find and keep it in sync (and so the
    ledger view hides it by default, like the importer's sweeps).
    """
    if not enabled:
        return
    leg = manual_entry.money_market_leg(kind, net_native)
    if leg is None:
        return
    mm_instrument = transactions_repo.find_account_money_market_instrument(
        session, parent.account_id
    )
    if mm_instrument is None:
        ui.notify(
            "No money-market fund on this account yet — logged the cash move only.",
            type="info",
        )
        return
    # Give the parent a stable external_id (if it has none) so the leg can be
    # linked to it; manual rows otherwise carry no external_id.
    if parent.external_id is None:
        parent.external_id = f"manual:{parent.id}"
        session.flush()
    leg_legs = transaction_fx_service.compute_legs(
        session, native_currency=native_ccy, net_native=leg.net_native, on=txn_date
    )
    mm_txn = Transaction(
        account_id=parent.account_id,
        date=txn_date,
        kind=leg.kind,
        instrument_id=mm_instrument.id,
        quantity=leg.quantity,
        price_native=leg.price,
        net_native=leg.net_native,
        fx_rate_to_eur=leg_legs.fx_rate_to_eur,
        net_eur=leg_legs.net_eur,
        net_usd=leg_legs.net_usd,
        description=(f"{MANUAL_SETTLEMENT_DESCRIPTION_PREFIX} · {mm_instrument.symbol}"),
        external_id=settlement_external_id_for(parent.external_id),
        source=TransactionSource.MANUAL,
    )
    transactions_repo.insert_transaction(session, mm_txn)


def _find_existing_settlement_leg(  # pragma: no cover - UI
    session: Any,
    *,
    account_id: int,
    external_id: str | None,
    on: date,
    net_native: Decimal | None,
) -> Transaction | None:
    """Locate the settlement leg paired to a parent, new or legacy.

    First tries the ``:vmfxx`` external-id link (imported rows and post-v3.2.0
    manual rows); falls back to matching a legacy manual auto-leg by its
    description marker, account, date and opposite ``net_native`` so editing or
    deleting *existing* entries keeps working.
    """
    leg = transactions_repo.find_settlement_leg(
        session, account_id=account_id, parent_external_id=external_id
    )
    if leg is not None:
        return leg
    if net_native is None:
        return None
    return transactions_repo.find_legacy_settlement_leg(
        session, account_id=account_id, on=on, parent_net_native=net_native
    )


def _resync_settlement_leg(  # pragma: no cover - UI
    session: Any,
    *,
    parent: Transaction,
    old_account_id: int,
    old_external_id: str | None,
    old_date: str,
    old_net_native: Decimal | None,
    native_ccy: str,
) -> None:
    """Re-derive the parent's settlement leg after an edit, or drop it.

    Found via the *pre-edit* identity (the leg still carries the old date /
    account / net until we touch it). If the edited parent no longer moves cash
    the leg is deleted; otherwise its date, account, kind, quantity and frozen
    FX legs are recomputed so the settlement balance never drifts.
    """
    leg = _find_existing_settlement_leg(
        session,
        account_id=old_account_id,
        external_id=old_external_id,
        on=date.fromisoformat(old_date),
        net_native=old_net_native,
    )
    if leg is None or leg.id == parent.id:
        return
    values = manual_entry.settlement_leg_values(parent.net_native)
    if values is None:
        # The edit turned a cash move into something with no net flow (or zero):
        # the paired leg no longer has anything to settle, so remove it.
        session.delete(leg)
        session.flush()
        return
    leg_legs = transaction_fx_service.compute_legs(
        session, native_currency=native_ccy, net_native=values.net_native, on=parent.date
    )
    leg.account_id = parent.account_id
    leg.date = parent.date
    leg.kind = values.kind
    leg.quantity = values.quantity
    leg.price_native = values.price
    leg.net_native = values.net_native
    leg.fx_rate_to_eur = leg_legs.fx_rate_to_eur
    leg.net_eur = leg_legs.net_eur
    leg.net_usd = leg_legs.net_usd
    session.flush()


def _confirm_delete(txn_id: int, dlg: Any) -> None:  # pragma: no cover - UI
    def _delete() -> None:
        with session_scope() as session:
            parent = transactions_repo.get_transaction(session, txn_id)
            if parent is not None:
                # Remove the paired settlement leg too, so deleting a cash move
                # doesn't strand a now-orphaned (often hidden) money-market row.
                leg = _find_existing_settlement_leg(
                    session,
                    account_id=parent.account_id,
                    external_id=parent.external_id,
                    on=parent.date,
                    net_native=parent.net_native,
                )
                if leg is not None and leg.id != parent.id:
                    session.delete(leg)
                    session.flush()
            transactions_repo.delete_transaction(session, txn_id)
        ui.notify("Deleted", type="positive")
        # Republish (debounced) after a manual deletion, like add/edit above.
        auto_publish.schedule_publish_after_edit()
        dlg.close()
        ui.navigate.to(PATH)

    confirm_dialog(
        "Delete this transaction?",
        "This permanently removes the ledger row. This can't be undone.",
        on_confirm=_delete,
        confirm_label="Delete",
    )


def _open_import_modal(accounts: list[Account]) -> None:  # noqa: PLR0915  # pragma: no cover - UI
    # Upload-first flow: the file is stashed the moment it's picked, so the
    # account/broker can be chosen in any order and the import fires from an
    # explicit button. (Previously ``auto_upload`` fired the import on file
    # select and silently dropped the file if no account was picked yet.)
    staged: dict[str, Any] = {"raw": None, "name": None}

    with ui.dialog() as dlg, ui.card().classes("min-w-[28rem]"):
        ui.label("Import broker CSV / XLSX").classes("text-h6")
        ui.label(
            "Drop your file first, then pick the broker and account — the import "
            "only runs when you press Import."
        ).classes("text-caption opacity-70")
        broker_sel = ui.select(
            {b.value: b.value.title() for b in Broker}, value=Broker.FIDELITY.value, label="Broker"
        ).classes("w-full")
        account_sel = ui.select({a.id: a.account_label for a in accounts}, label="Account").classes(
            "w-full"
        )
        status = ui.label("").classes("text-caption")

        def _on_upload(e: events.UploadEventArguments) -> None:
            # Just stash the bytes; don't import yet. This lets the user
            # upload before choosing an account and still import correctly.
            staged["raw"] = e.content.read()
            staged["name"] = e.name
            status.text = f"File ready: {e.name} — pick the account, then press Import."
            import_btn.enable()

        def _do_import() -> None:
            raw = staged["raw"]
            if raw is None:
                ui.notify("Upload a file first", type="warning")
                return
            if account_sel.value is None:
                ui.notify("Pick an account first", type="warning")
                return
            broker = Broker(broker_sel.value)
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
            # Rows the parser had to skip (unknown action, un-parseable or
            # EU-locale cell) — surfaced so a single bad row no longer
            # silently shrinks the import (audit D3/D5).
            if result.errors:
                preview = "; ".join(
                    f"line {e.line}: {e.message}" if e.line else e.message
                    for e in result.errors[:5]
                )
                more = "" if len(result.errors) <= 5 else f" (+{len(result.errors) - 5} more)"
                status.text += f", skipped {len(result.errors)} row(s): {preview}{more}"
            # Rows imported but worth eyeballing (audit D4).
            if result.warnings:
                wpreview = "; ".join(
                    f"line {w.line}: {w.message}" if w.line else w.message
                    for w in result.warnings[:5]
                )
                wmore = "" if len(result.warnings) <= 5 else f" (+{len(result.warnings) - 5} more)"
                status.text += f", {len(result.warnings)} warning(s): {wpreview}{wmore}"
            # Symbols the data provider couldn't resolve (audit D2).
            if result.unresolved_symbols:
                status.text += (
                    f", unresolved symbol(s): {result.unresolved_symbols} "
                    "(delisted, a typo, or the data provider was offline)"
                )
            if result.fx_missing_dates:
                status.text += (
                    f", FX missing for {len(result.fx_missing_dates)} date(s) — "
                    "refresh FX rates then Settings → Recalculate FX-derived values"
                )
                ui.notify(status.text, type="warning")
            elif result.errors or result.warnings or result.unresolved_symbols:
                ui.notify(status.text, type="warning")
            else:
                ui.notify(status.text, type="positive")

            # v3.0 §5.4: republish the live-web blob after a successful import.
            # Best-effort and gated by Settings → Live web companion; never
            # raises, so a publish hiccup can't undo the import above. Tell the
            # user whether the upload worked (but stay quiet when it is off).
            outcome = auto_publish.run_trigger(auto_publish.TRIGGER_IMPORT)
            note = auto_publish.describe_outcome(outcome)
            if note is not None:
                ui.notify(note[0], type=note[1])

        ui.upload(on_upload=_on_upload, auto_upload=True).props("accept=.csv,.xlsx").classes(
            "w-full"
        )
        with ui.row().classes("justify-end w-full gap-sm"):
            ui.button("Close", on_click=dlg.close).props("flat")
            import_btn = ui.button("Import", icon="upload_file", on_click=_do_import).props(
                "unelevated color=primary no-caps"
            )
            import_btn.disable()
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
