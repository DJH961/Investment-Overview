"""Settings page (spec §8.7) — accounts/instruments overview + refresh actions.

v1.3 adds:

* Display-currency selector (EUR/USD) — persisted via ``app_config``.
* Add-account / add-instrument / add-allocation forms (onboarding without
  the wizard, or to extend the default seed afterwards).
* "Seed default setup" button so a user mid-onboarding can pull in the
  spec defaults without backing out to ``/onboarding``.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.repositories import (
    accounts_repo,
    allocations_repo,
    instrument_overrides_repo,
    instruments_repo,
)
from investment_dashboard.services import display_currency_service, provider_status
from investment_dashboard.services.fx_service import refresh_fx_history
from investment_dashboard.services.onboarding_service import seed_default_setup
from investment_dashboard.services.prices_service import refresh_prices
from investment_dashboard.ui.components import page_header, section
from investment_dashboard.ui.layout import page_frame

PATH = "/settings"

log = logging.getLogger(__name__)


def _refresh_fx_clicked() -> None:  # pragma: no cover - UI
    try:
        with session_scope() as session:
            n = refresh_fx_history(session, earliest_needed=date.today() - timedelta(days=30))
        ui.notify(f"FX refresh: {n} new rate(s)", type="positive")
    except Exception as exc:
        log.exception("FX refresh failed")
        ui.notify(f"FX refresh failed: {exc}", type="negative")


def _refresh_prices_clicked() -> None:  # pragma: no cover - UI
    try:
        with session_scope() as session:
            result = refresh_prices(session, earliest_needed=date.today() - timedelta(days=30))
        total = sum(result.values())
        ui.notify(f"Price refresh: {total} new close(s)", type="positive")
    except Exception as exc:
        log.exception("Price refresh failed")
        ui.notify(f"Price refresh failed: {exc}", type="negative")


def _seed_clicked() -> None:  # pragma: no cover - UI
    try:
        with session_scope() as session:
            result = seed_default_setup(session)
    except Exception as exc:
        log.exception("Seed default setup failed")
        ui.notify(f"Seed failed: {exc}", type="negative")
        return
    ui.notify(
        f"Seeded {result.accounts_created} account(s) and "
        f"{result.instruments_created} instrument(s).",
        type="positive",
    )
    _settings_refresh()


def _set_display_currency(value: str) -> None:  # pragma: no cover - UI
    try:
        with session_scope() as session:
            display_currency_service.set_display_currency(session, value)
    except ValueError as exc:
        ui.notify(str(exc), type="negative")
        return
    ui.notify(f"Display currency set to {value}", type="positive")
    _settings_refresh()


def _edit_account_dialog(
    account_id: int,
    current_label: str,
    current_type: str | None,
    current_active: bool,
) -> None:
    """Open an inline-edit dialog for an account row."""  # pragma: no cover - UI
    with ui.dialog() as dialog, ui.card():
        ui.label("Edit account").classes("text-h6")
        label_input = ui.input("Label", value=current_label)
        type_input = ui.input("Account type", value=current_type or "")
        active_input = ui.checkbox("Active", value=current_active)

        def _save() -> None:
            try:
                with session_scope() as session:
                    accounts_repo.update_account(
                        session,
                        account_id,
                        account_label=label_input.value.strip() or None,
                        account_type=type_input.value.strip() or None,
                        active=bool(active_input.value),
                    )
                ui.notify("Account updated", type="positive")
                dialog.close()
                _settings_refresh()
            except Exception as exc:
                log.exception("Account update failed")
                ui.notify(f"Update failed: {exc}", type="negative")

        with ui.row():
            ui.button("Cancel", on_click=dialog.close).props("flat")
            ui.button("Save", on_click=_save).props("color=primary")
    dialog.open()


def _add_account_dialog() -> None:  # pragma: no cover - UI
    with ui.dialog() as dialog, ui.card().classes("min-w-[24rem]"):
        ui.label("Add account").classes("text-h6")
        broker_in = ui.select(
            ["vanguard", "fidelity", "savings_bank"],
            value="vanguard",
            label="Broker",
        ).classes("w-full")
        label_in = ui.input("Label", value="").classes("w-full")
        currency_in = ui.select(["USD", "EUR"], value="USD", label="Native currency").classes(
            "w-full",
        )
        type_in = ui.select(
            ["brokerage", "savings", "cash"],
            value="brokerage",
            label="Account type",
        ).classes("w-full")

        def _save() -> None:
            label = (label_in.value or "").strip()
            if not label:
                ui.notify("Label is required", type="warning")
                return
            try:
                with session_scope() as session:
                    accounts_repo.create_account(
                        session,
                        broker=broker_in.value,
                        account_label=label,
                        native_currency=currency_in.value,
                        account_type=type_in.value,
                    )
            except Exception as exc:
                log.exception("Account create failed")
                ui.notify(f"Create failed: {exc}", type="negative")
                return
            ui.notify("Account created", type="positive")
            dialog.close()
            _settings_refresh()

        with ui.row().classes("justify-end w-full gap-sm"):
            ui.button("Cancel", on_click=dialog.close).props("flat")
            ui.button("Add", on_click=_save).props("color=primary")
    dialog.open()


def _add_instrument_dialog() -> None:  # pragma: no cover - UI
    with ui.dialog() as dialog, ui.card().classes("min-w-[24rem]"):
        ui.label("Add instrument").classes("text-h6")
        symbol_in = ui.input("Symbol (e.g. VTI)").classes("w-full")
        name_in = ui.input("Name").classes("w-full")
        asset_class_in = ui.select(
            ["etf", "mutual_fund", "stock", "cash", "savings"],
            value="etf",
            label="Asset class",
        ).classes("w-full")
        category_in = ui.input("Category (e.g. Total US, Growth, Dividend)").classes("w-full")
        currency_in = ui.select(["USD", "EUR"], value="USD", label="Native currency").classes(
            "w-full",
        )
        expense_in = ui.input("Expense ratio (optional, e.g. 0.0003)").classes("w-full")

        def _save() -> None:
            sym = (symbol_in.value or "").strip().upper()
            if not sym:
                ui.notify("Symbol is required", type="warning")
                return
            expense: Decimal | None = None
            raw = (expense_in.value or "").strip()
            if raw:
                try:
                    expense = Decimal(raw)
                except InvalidOperation:
                    ui.notify(f"Invalid expense ratio: {raw!r}", type="negative")
                    return
            try:
                with session_scope() as session:
                    if instruments_repo.get_by_symbol(session, sym) is not None:
                        ui.notify(f"Instrument {sym} already exists", type="warning")
                        return
                    created = instruments_repo.get_or_create(
                        session,
                        symbol=sym,
                        name=(name_in.value or "").strip() or None,
                        asset_class=asset_class_in.value,
                        native_currency=currency_in.value,
                        expense_ratio=expense,
                    )
                    category = (category_in.value or "").strip() or None
                    if category is not None:
                        instrument_overrides_repo.set_category(session, created.id, category)
            except Exception as exc:
                log.exception("Instrument create failed")
                ui.notify(f"Create failed: {exc}", type="negative")
                return
            ui.notify(f"Instrument {sym} added", type="positive")
            dialog.close()
            _settings_refresh()

        with ui.row().classes("justify-end w-full gap-sm"):
            ui.button("Cancel", on_click=dialog.close).props("flat")
            ui.button("Add", on_click=_save).props("color=primary")
    dialog.open()


def _add_allocation_dialog() -> None:  # pragma: no cover - UI
    with session_scope() as session:
        instruments = list(instruments_repo.list_instruments(session))

    with ui.dialog() as dialog, ui.card().classes("min-w-[32rem]"):
        ui.label("Create target allocation").classes("text-h6")
        name_in = ui.input("Name", value="Default").classes("w-full")
        activate_in = ui.checkbox("Activate immediately", value=True)
        ui.label("Weights (%) — must sum to 100. Leave blank to exclude.").classes(
            "text-caption opacity-70",
        )
        weight_inputs: dict[int, ui.input] = {}
        with ui.column().classes("w-full max-h-[40vh] overflow-auto"):
            for instr in instruments:
                with ui.row().classes("items-center gap-sm w-full"):
                    ui.label(f"{instr.symbol} · {instr.name or ''}").classes(
                        "text-body2",
                    ).style("min-width: 18rem")
                    weight_inputs[instr.id] = ui.input("Weight %", value="").classes(
                        "min-w-[8rem]",
                    )

        def _save() -> None:
            name = (name_in.value or "").strip()
            if not name:
                ui.notify("Allocation name is required", type="warning")
                return
            weights: dict[int, Decimal] = {}
            for instrument_id, widget in weight_inputs.items():
                raw = (widget.value or "").strip()
                if not raw:
                    continue
                try:
                    weights[instrument_id] = Decimal(raw)
                except InvalidOperation:
                    ui.notify(f"Invalid weight: {raw!r}", type="negative")
                    return
            if not weights:
                ui.notify("Pick at least one instrument", type="warning")
                return
            total = sum(weights.values(), start=Decimal(0))
            if abs(total - Decimal(100)) > Decimal("0.01"):
                ui.notify(
                    f"Weights sum to {total} %, expected 100 %.",
                    type="negative",
                )
                return
            try:
                with session_scope() as session:
                    allocations_repo.create_allocation(
                        session,
                        name,
                        weights,
                        active=bool(activate_in.value),
                    )
            except Exception as exc:
                log.exception("Allocation create failed")
                ui.notify(f"Create failed: {exc}", type="negative")
                return
            ui.notify("Allocation created", type="positive")
            dialog.close()
            _settings_refresh()

        with ui.row().classes("justify-end w-full gap-sm"):
            ui.button("Cancel", on_click=dialog.close).props("flat")
            ui.button("Save", on_click=_save).props("color=primary")
    dialog.open()


def _edit_instrument_dialog(
    instrument_id: int,
    current_name: str,
    current_category: str,
    current_asset_class: str,
    current_expense_ratio: str,
    current_active: bool,
) -> None:  # pragma: no cover - UI
    with ui.dialog() as dialog, ui.card():
        ui.label("Edit instrument").classes("text-h6")
        name_input = ui.input("Name", value=current_name)
        category_input = ui.input("Category", value=current_category)
        asset_class_input = ui.input("Asset class", value=current_asset_class)
        expense_input = ui.input(
            "Expense ratio (e.g. 0.0007 for 0.07 %)", value=current_expense_ratio
        )
        active_input = ui.checkbox("Active", value=current_active)

        def _save() -> None:
            raw_expense = expense_input.value.strip()
            expense_ratio: Decimal | None
            if raw_expense:
                try:
                    expense_ratio = Decimal(raw_expense)
                except InvalidOperation:
                    ui.notify(f"Invalid expense ratio: {raw_expense!r}", type="negative")
                    return
            else:
                expense_ratio = None
            try:
                with session_scope() as session:
                    instruments_repo.update_instrument(
                        session,
                        instrument_id,
                        name=name_input.value.strip() or None,
                        asset_class=asset_class_input.value.strip() or None,
                        expense_ratio=expense_ratio,
                    )
                    instrument_overrides_repo.upsert(
                        session,
                        instrument_id,
                        category=category_input.value.strip() or None,
                        active=bool(active_input.value),
                    )
                ui.notify("Instrument updated", type="positive")
                dialog.close()
                _settings_refresh()
            except Exception as exc:
                log.exception("Instrument update failed")
                ui.notify(f"Update failed: {exc}", type="negative")

        with ui.row():
            ui.button("Cancel", on_click=dialog.close).props("flat")
            ui.button("Save", on_click=_save).props("color=primary")
    dialog.open()


def _activate_allocation(allocation_id: int) -> None:  # pragma: no cover - UI
    try:
        with session_scope() as session:
            allocations_repo.set_active(session, allocation_id)
        ui.notify("Allocation activated", type="positive")
        _settings_refresh()
    except Exception as exc:
        log.exception("Activation failed")
        ui.notify(f"Activation failed: {exc}", type="negative")


def _settings_refresh() -> None:  # pragma: no cover - UI
    """Reload the settings page after a mutation."""
    ui.navigate.to(PATH)


def _render_display_prefs(current_currency: str) -> None:  # pragma: no cover - UI
    with ui.row().classes("items-center gap-md"):
        ui.label("Primary display currency:").classes("text-body2")
        ui.toggle(
            list(display_currency_service.SUPPORTED_CURRENCIES),
            value=current_currency,
            on_change=lambda e: _set_display_currency(e.value),
        ).props("dense unelevated")
        ui.label(
            "Switches every page's KPIs, tables and charts. "
            "Stored in the local DB so it persists across restarts.",
        ).classes("text-caption opacity-70")


def _render_data_refresh() -> None:  # pragma: no cover - UI
    with ui.row().classes("gap-md"):
        ui.button("Refresh FX rates", icon="currency_exchange", on_click=_refresh_fx_clicked).props(
            "flat color=primary no-caps"
        )
        ui.button("Refresh prices", icon="trending_up", on_click=_refresh_prices_clicked).props(
            "flat color=primary no-caps"
        )
        ui.button("Seed default setup", icon="auto_fix_high", on_click=_seed_clicked).props(
            "flat no-caps"
        )


def _render_accounts_section(accounts: list) -> None:  # pragma: no cover - UI
    with ui.row().classes("items-center w-full"):
        ui.space()
        ui.button("Add account", icon="add", on_click=_add_account_dialog).props(
            "unelevated color=primary dense no-caps",
        )
    with ui.column().classes("w-full gap-xs q-mt-sm"):
        if not accounts:
            ui.label("No accounts yet — add one or seed the defaults.").classes(
                "text-caption opacity-70",
            )
        for a in accounts:
            with ui.row().classes("items-center gap-md w-full"):
                ui.label(f"{a.broker} · {a.account_label}").classes("text-body1")
                ui.label(
                    f"{a.native_currency} · {a.account_type or '—'}"
                    f"{'' if a.active else ' · inactive'}"
                ).classes("text-caption opacity-70")
                ui.space()
                ui.button(
                    "Edit",
                    on_click=lambda _, a=a: _edit_account_dialog(
                        a.id, a.account_label, a.account_type, a.active
                    ),
                ).props("flat dense no-caps")


def _render_instruments_section(
    instruments: list,
    overrides: dict[int, object],
) -> None:  # pragma: no cover - UI
    with ui.row().classes("items-center w-full"):
        ui.space()
        ui.button("Add instrument", icon="add", on_click=_add_instrument_dialog).props(
            "unelevated color=primary dense no-caps",
        )
    with ui.column().classes("w-full gap-xs q-mt-sm"):
        if not instruments:
            ui.label("No instruments yet.").classes("text-caption opacity-70")
        for i in instruments:
            ov = overrides.get(i.id)
            category = ov.category if ov is not None else None
            active = ov.active if ov is not None else True
            with ui.row().classes("items-center gap-md w-full"):
                ui.label(f"{i.symbol} · {i.name or ''}").classes("text-body1")
                expense_lbl = f" · ER {i.expense_ratio}" if i.expense_ratio is not None else ""
                ui.label(
                    f"{i.asset_class} · {category or '—'}{expense_lbl}"
                    f"{'' if active else ' · inactive'}"
                ).classes("text-caption opacity-70")
                ui.space()
                ui.button(
                    "Edit",
                    on_click=lambda _, i=i, category=category, active=active: (
                        _edit_instrument_dialog(
                            i.id,
                            i.name or "",
                            category or "",
                            i.asset_class,
                            str(i.expense_ratio) if i.expense_ratio is not None else "",
                            active,
                        )
                    ),
                ).props("flat dense no-caps")


def _render_allocations_section(allocations: list) -> None:  # pragma: no cover - UI
    with ui.row().classes("items-center w-full"):
        ui.space()
        ui.button("New allocation", icon="add", on_click=_add_allocation_dialog).props(
            "unelevated color=primary dense no-caps",
        )
    with ui.column().classes("w-full gap-xs q-mt-sm"):
        if not allocations:
            ui.label("No allocations yet.").classes("text-caption opacity-70")
        for a in allocations:
            with ui.row().classes("items-center gap-md w-full"):
                ui.label(f"{a.name}").classes("text-body1")
                ui.label(f"{len(a.items)} instruments").classes("text-caption opacity-70")
                ui.space()
                if a.active:
                    ui.badge("Active", color="primary")
                else:
                    ui.button(
                        "Activate",
                        on_click=lambda _, a=a: _activate_allocation(a.id),
                    ).props("flat dense no-caps")


def _render_storage_section() -> None:  # pragma: no cover - UI
    """Storage panel: show resolved tier paths and where each came from."""
    from investment_dashboard.boot import is_read_only  # noqa: PLC0415
    from investment_dashboard.config import get_settings  # noqa: PLC0415
    from investment_dashboard.db import get_active_encryption  # noqa: PLC0415
    from investment_dashboard.storage import resolve_storage_layout  # noqa: PLC0415
    from investment_dashboard.storage.cloud import path_is_in_cloud_folder  # noqa: PLC0415

    settings = get_settings()
    layout = resolve_storage_layout()
    encryption = get_active_encryption()
    rows = [
        ("Ledger", layout.ledger),
        ("Config", layout.config),
        ("Cache", layout.cache),
    ]
    with ui.column().classes("gap-sm"):
        if is_read_only():
            ui.label("Read-only mode — another instance holds the writer lock.").classes(
                "text-warning"
            )
        ui.label(
            f"Encryption: {'enabled (' + (encryption.driver or '') + ')' if encryption.enabled else 'disabled'}"
        )
        for label, resolved in rows:
            cloud = path_is_in_cloud_folder(resolved.path) if resolved.path else None
            line = (
                f"{label}: {resolved.path}  "
                f"(source: {resolved.source.value}"
                f"{', cloud: ' + cloud.provider if cloud else ''})"
            )
            ui.label(line).classes("font-mono text-caption")
        ui.label(f"Configured ledger: {settings.ledger_path}").classes("text-caption text-grey")


def _status_chip_props(status: str) -> tuple[str, str, str]:
    """Map a provider status to (icon, qcolor, human label) for the chip."""
    if status == "ok":
        return ("check_circle", "positive", "Connected")
    if status == "partial":
        return ("warning", "warning", "Partial data")
    if status == "error":
        return ("error", "negative", "Failed")
    return ("help", "grey", "Unknown")


def _format_relative(at: datetime) -> str:
    """Render a timestamp as both relative ("3 m ago") and absolute UTC."""
    now = datetime.now(UTC)
    # Treat any naive datetime as UTC — provider_status always uses tz-aware UTC.
    moment = at if at.tzinfo is not None else at.replace(tzinfo=UTC)
    delta = now - moment
    secs = int(delta.total_seconds())
    if secs < 0:
        rel = "just now"
    elif secs < 60:
        rel = f"{secs}s ago"
    elif secs < 3600:
        rel = f"{secs // 60}m ago"
    elif secs < 86400:
        rel = f"{secs // 3600}h ago"
    else:
        rel = f"{secs // 86400}d ago"
    return f"{rel} ({moment.strftime('%Y-%m-%d %H:%M:%S UTC')})"


def _render_connectivity_section() -> None:  # pragma: no cover - UI
    """Show the latest yfinance / Frankfurter call outcome + recent log."""
    known_providers = ("yfinance", "frankfurter")
    latest = provider_status.all_latest()

    with ui.column().classes("gap-sm w-full"):
        with ui.row().classes("gap-md items-center w-full"):
            for prov in known_providers:
                event = latest.get(prov)
                if event is None:
                    icon, color, label = "help", "grey", "No data yet"
                    detail = "Has not been called since the app started."
                    when = "—"
                else:
                    icon, color, label = _status_chip_props(event.status)
                    detail = event.message
                    when = _format_relative(event.at)
                with ui.card().classes("p-sm"):
                    with ui.row().classes("items-center gap-sm"):
                        ui.icon(icon, color=color)
                        ui.label(prov).classes("text-subtitle2")
                        ui.badge(label, color=color).props("outline")
                    ui.label(when).classes("text-caption opacity-70")
                    ui.label(detail).classes("text-caption")

        events = provider_status.get_log(limit=20)
        if not events:
            ui.label(
                "No provider calls recorded yet. Trigger 'Refresh prices' or "
                "'Refresh FX rates' above, or wait for the next background tick."
            ).classes("text-caption opacity-70")
            return

        with (
            ui.expansion("Recent activity", icon="history").classes("w-full"),
            ui.column().classes("gap-xs w-full"),
        ):
            for ev in events:
                icon, color, _ = _status_chip_props(ev.status)
                with ui.row().classes("items-center gap-sm w-full no-wrap"):
                    ui.icon(icon, color=color).classes("text-sm")
                    ui.label(ev.at.astimezone(UTC).strftime("%H:%M:%S")).classes(
                        "text-caption font-mono opacity-70"
                    )
                    ui.label(ev.provider).classes("text-caption font-mono")
                    ui.label(ev.message).classes("text-caption")


def register() -> None:
    @ui.page(PATH)
    def _settings() -> None:  # pragma: no cover
        with page_frame("Settings", current=PATH):
            page_header("Settings", subtitle="Display preferences, data refresh, accounts")
            with session_scope() as session:
                accounts = list(accounts_repo.list_accounts(session))
                instruments = list(instruments_repo.list_instruments(session))
                instrument_overrides = instrument_overrides_repo.get_override_map(
                    session, [i.id for i in instruments]
                )
                allocations = list(allocations_repo.list_allocations(session))
                current_currency = display_currency_service.get_display_currency(session)

            with section("Display preferences"):
                _render_display_prefs(current_currency)
            with section("Storage"):
                _render_storage_section()
            with section("Data refresh"):
                _render_data_refresh()
            with section("Connectivity"):
                _render_connectivity_section()
            with section("Accounts"):
                _render_accounts_section(accounts)
            with section("Instruments"):
                _render_instruments_section(instruments, instrument_overrides)
            with section("Target allocations"):
                _render_allocations_section(allocations)
