"""Settings page (spec §8.7) — accounts/instruments overview + refresh actions.

v1.3 adds:

* Display-currency selector (EUR/USD) — persisted via ``app_config``.
* Add-account / add-instrument / add-allocation forms (onboarding without
  the wizard, or to extend the default seed afterwards).
* "Seed default setup" button so a user mid-onboarding can pull in the
  spec defaults without backing out to ``/onboarding``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta, tzinfo
from decimal import Decimal, InvalidOperation

from nicegui import run, ui

from investment_dashboard.db import session_scope
from investment_dashboard.repositories import (
    accounts_repo,
    allocations_repo,
    app_config_repo,
    instrument_overrides_repo,
    instruments_repo,
    transactions_repo,
)
from investment_dashboard.services import (
    auto_refresh,
    benchmark_service,
    display_currency_service,
    fetch_report,
    instrument_enrichment_service,
    prices_service,
    provider_status,
    risk_free_service,
    timezone_service,
    transaction_fx_service,
)
from investment_dashboard.services.fx_service import refresh_fx_history
from investment_dashboard.services.onboarding_service import seed_default_setup
from investment_dashboard.services.prices_service import refresh_prices
from investment_dashboard.ui.components import confirm_dialog, page_header, section
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import fmt_pct

PATH = "/settings"

log = logging.getLogger(__name__)


#: Minimum time the in-place "loading" spinner on a manual refresh button stays
#: visible. When prices/FX are already current the service early-returns without
#: any network round-trip (see ``refresh_prices`` / ``refresh_fx_history``), so
#: the work finishes in a few milliseconds and — without a floor — the spinner
#: would flash for less than a frame and the tap would look completely inert.
#: This mirrors the web companion's ``MANUAL_REFRESH_MIN_FEEDBACK_MS`` so the
#: same "nothing happens" bug can't recur on the local app either.
MANUAL_REFRESH_MIN_FEEDBACK_SECONDS = 0.65


def _remaining_feedback_delay(elapsed_seconds: float) -> float:
    """Seconds to keep a manual-refresh spinner up after the work finished.

    Floors the visible feedback at :data:`MANUAL_REFRESH_MIN_FEEDBACK_SECONDS`
    so a refresh the service satisfies from cache (no network call) still shows
    a perceptible spinner instead of flashing for less than a frame. Never
    negative, so an already-slow refresh adds no artificial delay.
    """
    return max(0.0, MANUAL_REFRESH_MIN_FEEDBACK_SECONDS - elapsed_seconds)


@asynccontextmanager
async def _button_busy(button: ui.button) -> AsyncIterator[None]:  # pragma: no cover - UI
    """Show a spinner on ``button`` (disabled) while the wrapped work runs.

    Gives an immediate, in-place visual cue that a manual refresh registered and
    is in progress — the work itself is offloaded to a worker thread so the
    spinner keeps animating instead of the click silently blocking the UI.

    The spinner is held for at least :data:`MANUAL_REFRESH_MIN_FEEDBACK_SECONDS`:
    a refresh whose data is already up to date returns almost instantly, so
    without this floor the spinner would appear and vanish within a single frame
    and the tap would look like nothing happened.
    """
    button.props("loading")
    button.disable()
    started = time.monotonic()
    try:
        yield
    finally:
        remaining = _remaining_feedback_delay(time.monotonic() - started)
        if remaining > 0:
            await asyncio.sleep(remaining)
        button.props(remove="loading")
        button.enable()


async def _refresh_fx_clicked(button: ui.button) -> None:  # pragma: no cover - UI
    def _work() -> int:
        with session_scope() as session:
            return refresh_fx_history(session, earliest_needed=date.today() - timedelta(days=30))

    async with _button_busy(button):
        try:
            n = await run.io_bound(_work)
            ui.notify(f"FX refresh: {n} new rate(s)", type="positive")
        except Exception as exc:
            log.exception("FX refresh failed")
            ui.notify(f"FX refresh failed: {exc}", type="negative")


async def _refresh_prices_clicked(button: ui.button) -> None:  # pragma: no cover - UI
    def _work() -> int:
        with session_scope() as session:
            result = refresh_prices(session, earliest_needed=date.today() - timedelta(days=30))
        return sum(result.values())

    async with _button_busy(button):
        try:
            total = await run.io_bound(_work)
            ui.notify(f"Price refresh: {total} new close(s)", type="positive")
        except Exception as exc:
            log.exception("Price refresh failed")
            ui.notify(f"Price refresh failed: {exc}", type="negative")


def _recalc_fx_legs_clicked() -> None:  # pragma: no cover - UI
    """Force a full rebuild of every transaction's frozen EUR/USD legs.

    First makes sure FX history reaches back to the earliest trade (retrying
    the refresh), then recomputes both currency legs on every ledger row from
    that history. Use this after a failed/partial import, or whenever the FX
    data has been corrected, to bring all derived KPIs back into agreement.
    """
    try:
        with session_scope() as session:
            earliest = transactions_repo.earliest_transaction_date(session)
            if earliest is not None:
                transaction_fx_service.ensure_fx_coverage(session, earliest_needed=earliest)
            result = transaction_fx_service.backfill_missing_legs(session, force=True)
    except Exception as exc:
        log.exception("Recalculate FX-derived values failed")
        ui.notify(f"Recalculation failed: {exc}", type="negative")
        return
    msg = f"Recalculated {result.updated} transaction(s)"
    if result.incomplete:
        ui.notify(
            f"{msg}; {result.incomplete} still missing FX data — refresh FX rates and try again.",
            type="warning",
        )
    else:
        ui.notify(f"{msg}. All legs valued at trade-date FX.", type="positive")


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


def _set_timezone(value: str) -> None:  # pragma: no cover - UI
    try:
        with session_scope() as session:
            timezone_service.set_timezone(session, value)
    except ValueError as exc:
        ui.notify(str(exc), type="negative")
        return
    ui.notify(f"Timezone set to {value}", type="positive")
    ui.navigate.reload()


def _set_refresh_interval(value: object) -> None:  # pragma: no cover - UI
    """Persist + live-apply the auto-update (price refresh) cadence."""
    try:
        seconds = int(float(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        ui.notify("Enter a whole number of seconds", type="negative")
        return
    with session_scope() as session:
        stored = auto_refresh.set_interval_seconds(session, seconds)
    # Re-arm the running timer immediately so the change takes effect now.
    try:
        from investment_dashboard import main as _main  # noqa: PLC0415

        _main.set_live_refresh_interval(float(stored))
    except Exception:  # pragma: no cover - defensive (e.g. timer not armed in tests)
        log.debug("could not re-arm live refresh timer", exc_info=True)
    ui.notify(f"Auto-update every {stored}s", type="positive")


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


def _apply_market_suggestion(
    *,
    symbol_in: ui.input,
    name_in: ui.input,
    asset_class_in: ui.select,
    category_in: ui.input,
    currency_in: ui.select,
    expense_in: ui.input,
) -> None:  # pragma: no cover - UI
    """Pre-fill the add-instrument form from market metadata."""
    sym = (symbol_in.value or "").strip().upper()
    if not sym:
        ui.notify("Enter a symbol first", type="warning")
        return
    suggestion = instrument_enrichment_service.suggest_instrument_fields(sym)
    filled: list[str] = []
    if suggestion.name and not (name_in.value or "").strip():
        name_in.value = suggestion.name
        filled.append("name")
    if suggestion.asset_class:
        asset_class_in.value = suggestion.asset_class
        filled.append("asset class")
    if suggestion.category and not (category_in.value or "").strip():
        category_in.value = suggestion.category
        filled.append("category")
    if suggestion.native_currency in {"USD", "EUR"}:
        currency_in.value = suggestion.native_currency
        filled.append("currency")
    if suggestion.expense_ratio is not None and not (expense_in.value or "").strip():
        expense_in.value = format(suggestion.expense_ratio, "f")
        filled.append("expense ratio")
    if filled:
        ui.notify(f"Filled from market data: {', '.join(filled)}", type="positive")
    else:
        ui.notify(f"No market metadata found for {sym}", type="warning")


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

        ui.button(
            "Fetch from market data",
            icon="cloud_download",
            on_click=lambda: _apply_market_suggestion(
                symbol_in=symbol_in,
                name_in=name_in,
                asset_class_in=asset_class_in,
                category_in=category_in,
                currency_in=currency_in,
                expense_in=expense_in,
            ),
        ).props("flat color=primary").classes("self-start")
        ui.label(
            "Asset class, category and expense ratio are auto-populated from market "
            "data — adjust only if the published values are wrong.",
        ).classes("text-caption opacity-70")

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


def _edit_instrument_dialog(
    instrument_id: int,
    current_symbol: str,
    current_name: str,
    current_category: str,
    current_asset_class: str,
    current_native_currency: str,
    current_expense_ratio: str,
    current_active: bool,
) -> None:  # pragma: no cover - UI
    with ui.dialog() as dialog, ui.card():
        ui.label("Edit instrument").classes("text-h6")
        symbol_input = ui.input("Ticker symbol", value=current_symbol)
        ui.label(
            "Repoint a preset/imported line that resolves to the wrong ticker "
            "(e.g. a DAX line that never priced). Cached prices are cleared so "
            "the next refresh repopulates from the new symbol."
        ).classes("text-caption opacity-70")
        name_input = ui.input("Name", value=current_name)
        category_input = ui.input("Category", value=current_category)
        asset_class_input = ui.input("Asset class", value=current_asset_class)
        currency_input = ui.input("Native currency (3-letter)", value=current_native_currency)
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
            new_symbol = symbol_input.value.strip().upper()
            symbol_changed = bool(new_symbol) and new_symbol != current_symbol.strip().upper()
            try:
                with session_scope() as session:
                    instruments_repo.update_instrument(
                        session,
                        instrument_id,
                        symbol=new_symbol or None,
                        name=name_input.value.strip() or None,
                        asset_class=asset_class_input.value.strip() or None,
                        native_currency=currency_input.value.strip() or None,
                        expense_ratio=expense_ratio,
                        clear_expense_ratio=not raw_expense,
                    )
                    instrument_overrides_repo.upsert(
                        session,
                        instrument_id,
                        category=category_input.value.strip() or None,
                        active=bool(active_input.value),
                    )
                    if symbol_changed:
                        # The cached closes belong to the old ticker; drop them
                        # so the new symbol's prices are fetched fresh.
                        prices_service.invalidate_instrument_prices(session, instrument_id)
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


def _save_benchmark_symbol(value: str) -> None:  # pragma: no cover - UI
    try:
        with session_scope() as session:
            benchmark_service.set_symbol(session, value)
    except ValueError as exc:
        ui.notify(str(exc), type="negative")
        return
    ui.notify(f"Benchmark symbol set to {value.upper()}", type="positive")
    _settings_refresh()


def _save_risk_free_symbol(value: str) -> None:  # pragma: no cover - UI
    try:
        with session_scope() as session:
            risk_free_service.set_symbol(session, value)
    except ValueError as exc:
        ui.notify(str(exc), type="negative")
        return
    ui.notify(f"Risk-free symbol set to {value}", type="positive")
    _settings_refresh()


def _save_risk_free_manual(value: str) -> None:  # pragma: no cover - UI
    cleaned = value.strip()
    parsed: Decimal | None
    if cleaned == "":
        parsed = None
    else:
        try:
            parsed = Decimal(cleaned)
        except (InvalidOperation, ValueError):
            ui.notify("Manual rate must be a decimal fraction (e.g. 0.04)", type="negative")
            return
    try:
        with session_scope() as session:
            risk_free_service.set_manual_rate(session, parsed)
    except ValueError as exc:
        ui.notify(str(exc), type="negative")
        return
    if parsed is None:
        ui.notify("Cleared manual risk-free rate; using live ^IRX feed", type="positive")
    else:
        ui.notify(f"Manual risk-free rate set to {fmt_pct(parsed)}", type="positive")
    _settings_refresh()


def _refresh_risk_free_clicked() -> None:  # pragma: no cover - UI
    try:
        with session_scope() as session:
            snap = risk_free_service.refresh(session)
    except Exception as exc:
        ui.notify(f"Refresh failed: {exc}", type="negative")
        return
    if snap.rate is None:
        ui.notify(
            "Risk-free fetch returned no data — keeping cached value.",
            type="warning",
        )
    else:
        ui.notify(f"Risk-free rate refreshed to {fmt_pct(snap.rate)}", type="positive")
    _settings_refresh()


def _render_analytics_prefs(
    *,
    benchmark_symbol: str,
    rf_snapshot,  # type: ignore[no-untyped-def]
) -> None:  # pragma: no cover - UI
    with ui.row().classes("items-center gap-md flex-wrap"):
        ui.label("Benchmark symbol:").classes("text-body2")
        bench_input = ui.input(value=benchmark_symbol).props("dense outlined").style("width:140px")
        ui.button(
            "Save",
            icon="save",
            on_click=lambda: _save_benchmark_symbol(bench_input.value),
        ).props("flat color=primary no-caps")
        ui.label("Default: VT (Vanguard Total World).").classes("text-caption opacity-70")
    with ui.row().classes("items-center gap-md flex-wrap q-mt-sm"):
        ui.label("Risk-free symbol:").classes("text-body2")
        rf_input = ui.input(value=rf_snapshot.symbol).props("dense outlined").style("width:140px")
        ui.button(
            "Save",
            icon="save",
            on_click=lambda: _save_risk_free_symbol(rf_input.value),
        ).props("flat color=primary no-caps")
        ui.button(
            "Refresh now",
            icon="refresh",
            on_click=_refresh_risk_free_clicked,
        ).props("flat no-caps")
        cached = (
            f"current: {fmt_pct(rf_snapshot.rate)}"
            + (
                f" (fetched {rf_snapshot.fetched_at.isoformat(timespec='minutes')})"
                if rf_snapshot.fetched_at
                else ""
            )
            if rf_snapshot.rate is not None
            else "no rate cached yet"
        )
        ui.label(cached).classes("text-caption opacity-70")
    with ui.row().classes("items-center gap-md flex-wrap q-mt-sm"):
        ui.label("Manual override:").classes("text-body2")
        manual_input = (
            ui.input(
                placeholder="0.04 = 4%",
                value=str(rf_snapshot.rate) if rf_snapshot.is_manual and rf_snapshot.rate else "",
            )
            .props("dense outlined")
            .style("width:140px")
        )
        ui.button(
            "Save",
            icon="save",
            on_click=lambda: _save_risk_free_manual(manual_input.value),
        ).props("flat color=primary no-caps")
        ui.label(
            "Pins Sharpe / Sortino / Alpha to your chosen rate. "
            "Leave blank to use the live ^IRX feed.",
        ).classes("text-caption opacity-70")


def _settings_refresh() -> None:  # pragma: no cover - UI
    """Reload the settings page after a mutation."""
    ui.navigate.to(PATH)


#: Reset levels offered in the Settings "Reset data" section, smallest blast
#: radius first. Each tuple is (level, title, what-it-clears, what-it-keeps).
_RESET_OPTIONS = (
    (
        "cache",
        "Reset cached market data",
        "Clears downloaded prices, FX rates and position snapshots. They are "
        "re-downloaded automatically on the next refresh.",
        "Keeps every account, instrument, transaction and setting.",
        "refresh",
    ),
    (
        "transactions",
        "Clear all transactions",
        "Deletes every imported transaction (and the cached data derived from "
        "them) so you can re-import a corrected file from scratch.",
        "Keeps your accounts, instruments, target allocations and settings.",
        "receipt_long",
    ),
    (
        "everything",
        "Reset everything (factory reset)",
        "Removes all data — accounts, instruments, transactions, allocations, "
        "overrides and preferences — returning the app to its first-run state.",
        "Keeps nothing; you will be taken back through onboarding.",
        "delete_forever",
    ),
)


def _perform_reset(level_value: str) -> None:  # pragma: no cover - UI
    from investment_dashboard.services.database_reset_service import (  # noqa: PLC0415
        ResetLevel,
        reset_database,
    )

    try:
        result = reset_database(ResetLevel(level_value))
    except Exception as exc:
        log.exception("database reset failed")
        ui.notify(f"Reset failed: {exc}", type="negative")
        return

    ui.notify(
        f"Reset complete — removed {result.total_deleted} row(s).",
        type="positive",
    )
    if level_value == "everything":
        ui.navigate.to("/onboarding")
    else:
        _settings_refresh()


def _open_reset_dialog(
    level_value: str,
    title: str,
    clears: str,
    keeps: str,
) -> None:  # pragma: no cover - UI
    """Confirm a reset before performing it.

    The destructive "everything" level additionally requires the user to type
    ``RESET`` so it can never be triggered by a stray click.
    """
    requires_phrase = level_value == "everything"
    with ui.dialog() as dialog, ui.card().classes("min-w-[28rem] gap-sm"):
        ui.label(title).classes("text-h6")
        ui.label(clears).classes("text-body2")
        ui.label(keeps).classes("text-caption opacity-70")
        ui.label("This cannot be undone.").classes("text-negative text-body2 q-mt-sm")

        phrase_input = None
        if requires_phrase:
            ui.label("Type RESET to confirm:").classes("text-body2 q-mt-sm")
            phrase_input = ui.input(placeholder="RESET").props("dense outlined autofocus")

        def _confirm() -> None:
            if requires_phrase and (phrase_input is None or phrase_input.value.strip() != "RESET"):
                ui.notify("Type RESET to confirm the factory reset.", type="warning")
                return
            dialog.close()
            _perform_reset(level_value)

        with ui.row().classes("justify-end w-full gap-sm q-mt-md"):
            ui.button("Cancel", on_click=dialog.close).props("flat no-caps")
            ui.button("Reset", icon="warning", on_click=_confirm).props(
                "unelevated color=negative no-caps"
            )
    dialog.open()


def _download_audit_export() -> None:  # pragma: no cover - UI
    """Build the full dashboard snapshot and offer it as a JSON download."""
    from investment_dashboard.services.audit_export_service import (  # noqa: PLC0415
        audit_export_filename,
        build_audit_export_json,
    )

    try:
        with session_scope() as session:
            payload = build_audit_export_json(session)
    except Exception as exc:
        log.exception("audit export failed")
        ui.notify(f"Audit export failed: {exc}", type="negative")
        return
    ui.download.content(payload, audit_export_filename())
    ui.notify("Audit export downloaded.", type="positive")


def _render_audit_export_controls() -> None:  # pragma: no cover - UI
    ui.button(
        "Download audit export (JSON)",
        icon="download",
        on_click=_download_audit_export,
    ).props("unelevated color=primary no-caps")


def _render_dev_tools_section() -> None:  # pragma: no cover - UI
    """Collapsed developer panel: a password-gated full audit export.

    The export bundles every dashboard's computed figures and the raw ledger
    into one JSON file so the app's totals and growth rates can be reconciled
    against an external source. It lives behind a collapsed expansion (and an
    optional dev password) so it stays out of the everyday flow.
    """
    from investment_dashboard.services.audit_export_service import (  # noqa: PLC0415
        dev_password_configured,
        verify_dev_password,
    )

    with ui.expansion("Developer tools", icon="developer_mode").classes("w-full"):
        ui.label(
            "Advanced diagnostics. The audit export bundles every dashboard's "
            "computed figures (overview, monthly, yearly, analytics, "
            "calculator, deposits) together with the raw ledger into a single "
            "JSON file, so the app's totals and growth rates can be reconciled "
            "against an external source and any divergence pinned down.",
        ).classes("text-caption opacity-70 q-mb-sm")
        if not dev_password_configured():
            ui.label(
                "No developer password is set, so this export is ungated. Set "
                "the INV_DASHBOARD_DEV_PASSWORD environment variable to require "
                "one here.",
            ).classes("text-caption text-grey q-mb-sm")
            _render_audit_export_controls()
            return

        ui.label("Enter the developer password to unlock the audit export.").classes(
            "text-caption opacity-70"
        )
        pw_in = (
            ui.input("Developer password")
            .props("outlined dense type=password")
            .classes("w-full max-w-md")
        )
        slot = ui.column().classes("gap-sm q-mt-sm")

        def _unlock() -> None:
            if not verify_dev_password(pw_in.value or ""):
                ui.notify("Incorrect developer password.", type="warning")
                return
            slot.clear()
            with slot:
                _render_audit_export_controls()
            ui.notify("Developer tools unlocked.", type="positive")

        ui.button("Unlock", icon="lock_open", on_click=_unlock).props(
            "unelevated color=primary no-caps"
        )


def _render_reset_section() -> None:  # pragma: no cover - UI
    with ui.column().classes("w-full gap-sm"):
        for level_value, title, clears, keeps, icon in _RESET_OPTIONS:
            with ui.row().classes("items-center gap-md w-full"):
                with ui.column().classes("gap-none"):
                    ui.label(title).classes("text-body1")
                    ui.label(clears).classes("text-caption opacity-70")
                    ui.label(keeps).classes("text-caption opacity-70")
                ui.space()
                ui.button(
                    "Reset",
                    icon=icon,
                    on_click=lambda _, lv=level_value, t=title, c=clears, k=keeps: (
                        _open_reset_dialog(lv, t, c, k)
                    ),
                ).props("outline color=negative dense no-caps")


def _render_display_prefs(
    current_currency: str, current_timezone: str
) -> None:  # pragma: no cover - UI
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
    with ui.row().classes("items-center gap-md q-mt-sm"):
        ui.label("Timezone:").classes("text-body2")
        ui.select(
            timezone_service.supported_timezones(),
            value=current_timezone,
            with_input=True,
            on_change=lambda e: _set_timezone(e.value),
        ).props("dense outlined options-dense").classes("min-w-[16rem]")
        ui.label(
            'Sets the clock shown in the header. "Local" follows this '
            "computer's timezone; pick any zone to override it.",
        ).classes("text-caption opacity-70")
    with session_scope() as session:
        current_interval = auto_refresh.get_interval_seconds(session)
    with ui.row().classes("items-center gap-md q-mt-sm"):
        ui.label("Auto-update prices every:").classes("text-body2")
        ui.number(
            value=current_interval,
            min=auto_refresh.MIN_INTERVAL_SECONDS,
            max=auto_refresh.MAX_INTERVAL_SECONDS,
            step=5,
            suffix="s",
            on_change=lambda e: _set_refresh_interval(e.value),
        ).props("dense outlined").classes("w-[8rem]")
        ui.label(
            "How often the app pulls fresh prices in the background "
            f"({auto_refresh.MIN_INTERVAL_SECONDS}-{auto_refresh.MAX_INTERVAL_SECONDS}s). "
            "A thin bar pulses at the top of the page while an update runs.",
        ).classes("text-caption opacity-70")


def _confirm_recalc_fx_legs() -> None:  # pragma: no cover - UI
    confirm_dialog(
        "Recalculate FX-derived values?",
        "This rebuilds every transaction's FX legs at trade-date rates, "
        "overwriting the currently stored values. It cannot be undone.",
        on_confirm=_recalc_fx_legs_clicked,
        confirm_label="Recalculate",
        confirm_icon="calculate",
        confirm_color="primary",
    )


def _confirm_seed() -> None:  # pragma: no cover - UI
    confirm_dialog(
        "Seed default setup?",
        "This adds the preset accounts and instruments to your ledger. "
        "Run it on a fresh ledger; on an existing one it may create duplicates.",
        on_confirm=_seed_clicked,
        confirm_label="Seed",
        confirm_icon="auto_fix_high",
        confirm_color="primary",
    )


def _render_data_refresh() -> None:  # pragma: no cover - UI
    with ui.row().classes("gap-md"):
        fx_btn = ui.button("Refresh FX rates", icon="currency_exchange").props(
            "flat color=primary no-caps"
        )
        fx_btn.on_click(lambda: _refresh_fx_clicked(fx_btn))
        prices_btn = ui.button("Refresh prices", icon="trending_up").props(
            "flat color=primary no-caps"
        )
        prices_btn.on_click(lambda: _refresh_prices_clicked(prices_btn))
        ui.button(
            "Recalculate FX-derived values",
            icon="calculate",
            on_click=_confirm_recalc_fx_legs,
        ).props("flat color=primary no-caps")
        ui.button("Seed default setup", icon="auto_fix_high", on_click=_confirm_seed).props(
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
                            i.symbol,
                            i.name or "",
                            category or "",
                            i.asset_class,
                            i.native_currency,
                            str(i.expense_ratio) if i.expense_ratio is not None else "",
                            active,
                        )
                    ),
                ).props("flat dense no-caps")


def _render_allocations_section(allocations: list) -> None:  # pragma: no cover - UI
    with ui.row().classes("items-center w-full"):
        ui.space()
        ui.button(
            "Build a target in the Calculator",
            icon="calculate",
            on_click=lambda: ui.navigate.to("/calculator"),
        ).props("unelevated color=primary dense no-caps")
    with ui.column().classes("w-full gap-xs q-mt-sm"):
        if not allocations:
            ui.label(
                "No saved targets yet — head to the Calculator to build one by category "
                "or by fund, then save it here.",
            ).classes("text-caption opacity-70")
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


def _save_sync_folder(raw: str) -> None:  # pragma: no cover - UI callback
    """Persist a custom cloud/sync folder for the ledger + config tiers.

    Writes ``ledger_path`` / ``config_path`` into the config-tier
    ``app_config`` table (the ``PERSISTED`` step of the resolver), which
    overrides the auto-detected cloud folder on the next launch. Pass an
    empty string to clear the override and fall back to auto-detection.
    """
    from pathlib import Path  # noqa: PLC0415

    folder = raw.strip()
    try:
        with session_scope() as session:
            if not folder:
                app_config_repo.set_value(session, "ledger_path", None)
                app_config_repo.set_value(session, "config_path", None)
            else:
                base = Path(folder).expanduser()
                app_config_repo.set_value(session, "ledger_path", str(base / "ledger.sqlite"))
                app_config_repo.set_value(session, "config_path", str(base / "config.sqlite"))
    except Exception as exc:
        ui.notify(f"Could not save sync folder: {exc}", type="negative")
        return
    if folder:
        ui.notify(
            "Sync folder saved — restart the app for it to take effect.",
            type="positive",
        )
    else:
        ui.notify(
            "Cleared — the app will auto-detect a cloud folder on next launch.",
            type="positive",
        )


def _render_storage_section() -> None:  # pragma: no cover - UI
    """Storage panel: show resolved tier paths and let the user point the
    ledger + config tiers at a custom cloud/sync folder."""
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

        # Editable cloud/sync link (v2.8). The ledger + config tiers live
        # under this folder; the cache always stays local. Persisted into
        # app_config so the resolver picks it over the auto-detected cloud
        # provider on the next launch.
        ui.separator().classes("q-my-sm")
        ui.label("Cloud / sync folder").classes("text-subtitle2")
        ui.label(
            "Point your ledger and config files at a folder of your choice "
            "(e.g. a different cloud provider, or a plain local folder if you "
            "don't want OneDrive). Leave blank to auto-detect. Takes effect "
            "after a restart.",
        ).classes("text-caption opacity-70")
        current_folder = str(layout.ledger.path.parent) if layout.ledger.path is not None else ""
        folder_in = (
            ui.input("Sync folder", value=current_folder)
            .props("outlined dense")
            .classes("w-full max-w-2xl font-mono")
        )
        with ui.row().classes("gap-sm"):
            ui.button(
                "Save sync folder",
                icon="save",
                on_click=lambda: _save_sync_folder(folder_in.value or ""),
            ).props("unelevated color=primary no-caps")
            ui.button(
                "Use auto-detected",
                icon="autorenew",
                on_click=lambda: (_save_sync_folder(""), folder_in.set_value("")),
            ).props("flat no-caps")

        ui.separator().classes("q-my-sm")
        _render_move_ledger(is_read_only())

        ui.separator().classes("q-my-sm")
        _render_encryption_passphrase(encryption.enabled)


def _move_ledger(raw: str) -> None:  # pragma: no cover - UI callback
    """Physically relocate the ledger + config tiers to ``raw`` and persist it.

    Copies each synced-tier file into the chosen folder (rolling backup +
    integrity check + atomic move), removes the originals, writes the new
    paths into ``app_config`` so the resolver finds them next launch, and
    asks the user to restart.
    """
    from investment_dashboard.db import get_active_encryption  # noqa: PLC0415
    from investment_dashboard.storage.move import (  # noqa: PLC0415
        PERSIST_KEYS,
        MoveError,
        move_synced_tiers,
    )

    folder = raw.strip()
    if not folder:
        ui.notify("Choose a destination folder first.", type="warning")
        return
    try:
        result = move_synced_tiers(folder, encryption=get_active_encryption())
        with session_scope() as session:
            for tier, new_path in result.moved.items():
                app_config_repo.set_value(session, PERSIST_KEYS[tier], str(new_path))
    except MoveError as exc:
        ui.notify(str(exc), type="negative")
        return
    except Exception as exc:
        log.exception("Move ledger failed")
        ui.notify(f"Move failed: {exc}", type="negative")
        return
    if result.leftover_sources:
        ui.notify(
            "Moved, but the old file(s) could not be deleted yet "
            f"({len(result.leftover_sources)} left) — they release on restart. "
            "Restart the app for the move to take effect.",
            type="warning",
            timeout=0,
            close_button="OK",
        )
    else:
        ui.notify(
            "Ledger moved — restart the app for it to take effect.",
            type="positive",
        )


def _render_move_ledger(read_only: bool) -> None:  # pragma: no cover - UI
    """Folder picker that relocates the ledger + config tiers (plan §4.4)."""
    ui.label("Move ledger…").classes("text-subtitle2")
    ui.label(
        "Relocate your ledger and config database files to another folder "
        "(for example onto a different drive or cloud folder). The files are "
        "copied with an integrity check and a safety backup, the originals "
        "removed, and the new location remembered. Takes effect after a "
        "restart. The local cache is left where it is.",
    ).classes("text-caption opacity-70")
    dest_in = (
        ui.input("Destination folder", placeholder="/path/to/new/folder")
        .props("outlined dense")
        .classes("w-full max-w-2xl font-mono")
    )
    move_btn = ui.button(
        "Move ledger",
        icon="drive_file_move",
        on_click=lambda: _move_ledger(dest_in.value or ""),
    ).props("unelevated color=primary no-caps")
    if read_only:
        # Another instance holds the writer lock; moving its files would be
        # unsafe, so disable the action in read-only mode.
        dest_in.disable()
        move_btn.disable()
        ui.label(
            "Disabled in read-only mode — close the other instance first.",
        ).classes("text-caption text-warning")


def _save_passphrase(passphrase: str, confirm: str) -> None:  # pragma: no cover - UI
    """Validate + store the synced-tier passphrase in the OS keychain."""
    from investment_dashboard.storage.encryption import (  # noqa: PLC0415
        store_passphrase_in_keyring,
        validate_passphrase,
    )

    error = validate_passphrase(passphrase, confirm)
    if error is not None:
        ui.notify(error, type="warning")
        return
    if store_passphrase_in_keyring(passphrase):
        ui.notify(
            "Passphrase saved to the OS keychain. Save a recovery file too, "
            "then restart with encryption enabled.",
            type="positive",
        )
    else:
        ui.notify(
            "Could not reach the OS keychain. Check that a keyring backend is "
            "available for your operating system.",
            type="negative",
        )


def _download_recovery_file(passphrase: str, confirm: str) -> None:  # pragma: no cover - UI
    """Offer the passphrase as a downloadable recovery document."""
    from investment_dashboard.storage.encryption import (  # noqa: PLC0415
        RECOVERY_FILENAME,
        build_recovery_file,
        validate_passphrase,
    )

    error = validate_passphrase(passphrase, confirm)
    if error is not None:
        ui.notify(error, type="warning")
        return
    ui.download.content(build_recovery_file(passphrase), RECOVERY_FILENAME)
    ui.notify(
        "Recovery file downloaded — store it somewhere safe and offline.",
        type="positive",
    )


def _render_encryption_passphrase(enabled: bool) -> None:  # pragma: no cover - UI
    """Collect the synced-tier passphrase and offer a recovery file.

    Encryption itself is turned on with ``INV_DASHBOARD_ENCRYPT_SYNCED_TIERS``
    + the ``[encrypted]`` SQLCipher driver; this panel makes the *passphrase*
    side usable from the app — storing it in the OS keychain (so the env var
    isn't required) and producing the offline recovery document that the
    encryption plan called for.
    """
    ui.label("Encryption passphrase").classes("text-subtitle2")
    ui.label(
        "Store the SQLCipher passphrase for your synced ledger/config tiers in "
        "the OS keychain, and save an offline recovery file. The passphrase is "
        "never written to your database folder; if you lose it the encrypted "
        "data cannot be recovered.",
    ).classes("text-caption opacity-70")
    if not enabled:
        ui.label(
            "Encryption is currently disabled. Saving a passphrase here prepares "
            "it for when you enable encryption (restart with the `[encrypted]` "
            "extra installed and INV_DASHBOARD_ENCRYPT_SYNCED_TIERS=true).",
        ).classes("text-caption text-grey")
    pass_in = (
        ui.input("Passphrase").props("outlined dense type=password").classes("w-full max-w-md")
    )
    confirm_in = (
        ui.input("Confirm passphrase")
        .props("outlined dense type=password")
        .classes("w-full max-w-md")
    )
    with ui.row().classes("gap-sm"):
        ui.button(
            "Save to keychain",
            icon="key",
            on_click=lambda: _save_passphrase(pass_in.value or "", confirm_in.value or ""),
        ).props("unelevated color=primary no-caps")
        ui.button(
            "Download recovery file",
            icon="download",
            on_click=lambda: _download_recovery_file(pass_in.value or "", confirm_in.value or ""),
        ).props("flat no-caps")


def _set_auto_shutdown_pref(enabled: bool) -> None:  # pragma: no cover - UI
    """Persist + arm the auto-shutdown-on-tab-close preference."""
    from investment_dashboard import shutdown  # noqa: PLC0415

    try:
        with session_scope() as session:
            app_config_repo.set_value(
                session, "auto_shutdown_on_tab_close", "true" if enabled else "false"
            )
    except Exception as exc:
        ui.notify(f"Could not save preference: {exc}", type="negative")
        return
    shutdown.set_auto_shutdown(enabled)
    ui.notify(
        "Server will quit when the last tab closes."
        if enabled
        else "Auto-shutdown on tab close disabled.",
        type="positive",
    )


def _handoff_lock_clicked() -> None:  # pragma: no cover - UI
    """Release the writer lock so another instance can take over."""
    from investment_dashboard import shutdown  # noqa: PLC0415

    if shutdown.release_writer_lock_for_handoff():
        ui.notify(
            "Writer lock released — this window is now read-only. "
            "Another instance can take over writes.",
            type="positive",
        )
        ui.navigate.reload()
    else:
        ui.notify("No writer lock to release (already read-only).", type="info")


def _shutdown_clicked() -> None:  # pragma: no cover - UI
    """Confirm, then release the lock and stop the server."""
    from investment_dashboard import shutdown  # noqa: PLC0415

    with ui.dialog() as dialog, ui.card():
        ui.label("Shut down the dashboard server?").classes("text-subtitle1")
        ui.label(
            "This stops the background server and releases the writer lock. "
            "You'll need to relaunch the app to use it again.",
        ).classes("text-caption opacity-70")
        with ui.row().classes("justify-end w-full gap-sm"):
            ui.button("Cancel", on_click=dialog.close).props("flat no-caps")

            def _confirm() -> None:
                dialog.close()
                # Shared graceful-shutdown sequence: republish (gated) and
                # report the result, suppress the reconnect banner, auto-close
                # the tab, then stop the server.
                shutdown.begin_graceful_shutdown()

            ui.button("Shut down", icon="power_settings_new", on_click=_confirm).props(
                "unelevated color=negative no-caps"
            )
    dialog.open()


def _render_server_section() -> None:  # pragma: no cover - UI
    """Server controls: hand off the writer lock, toggle auto-shutdown, quit."""
    from investment_dashboard import shutdown  # noqa: PLC0415
    from investment_dashboard.boot import holds_writer_lock, is_read_only  # noqa: PLC0415

    holding = holds_writer_lock()
    with ui.column().classes("w-full gap-sm"):
        if is_read_only():
            ui.label("This window is read-only — another instance holds the writer lock.").classes(
                "text-warning"
            )
        else:
            ui.label("This window holds the writer lock (read-write).").classes("text-positive")

        ui.switch(
            "Quit the server when I close the last browser tab",
            value=shutdown.auto_shutdown_enabled(),
            on_change=lambda e: _set_auto_shutdown_pref(e.value),
        )
        ui.label(
            "Stops the background server a few seconds after the last tab "
            "closes, releasing the writer lock so other instances can run.",
        ).classes("text-caption opacity-70")

        with ui.row().classes("items-center gap-sm q-mt-sm"):
            handoff = ui.button(
                "Release writer lock",
                icon="lock_open",
                on_click=_handoff_lock_clicked,
            ).props("outline color=primary no-caps")
            if not holding:
                handoff.props("disable")
            ui.button(
                "Shut down server",
                icon="power_settings_new",
                on_click=_shutdown_clicked,
            ).props("unelevated color=negative no-caps")
        ui.label(
            '"Release writer lock" keeps this window open but read-only so '
            "another instance can take over writes; "
            '"Shut down server" stops the app entirely.',
        ).classes("text-caption opacity-70")


def _status_chip_props(status: str) -> tuple[str, str, str]:
    """Map a provider status to (icon, qcolor, human label) for the chip."""
    if status == "ok":
        return ("check_circle", "positive", "Connected")
    if status == "partial":
        return ("warning", "warning", "Partial data")
    if status == "error":
        return ("error", "negative", "Failed")
    return ("help", "grey", "Unknown")


def _format_relative(at: datetime, *, tz: tzinfo | None = None) -> str:
    """Render a timestamp as both relative ("3 m ago") and absolute wall-clock.

    ``tz`` formats the absolute part in the user's configured display timezone
    (defaulting to UTC when unset) so the connectivity log matches the header
    clock rather than always reading UTC.
    """
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
    shown = moment.astimezone(tz) if tz is not None else moment
    suffix = "" if tz is not None else " UTC"
    return f"{rel} ({shown.strftime('%Y-%m-%d %H:%M:%S')}{suffix})"


def _render_connectivity_section() -> None:  # pragma: no cover - UI
    """Show the latest yfinance / Frankfurter call outcome + recent log."""
    known_providers = ("yfinance", "frankfurter")
    latest = provider_status.all_latest()
    fetched = fetch_report.all_latest()
    with session_scope() as session:
        tz = timezone_service.resolve_tzinfo(timezone_service.get_timezone(session))

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
                    when = _format_relative(event.at, tz=tz)
                with ui.card().classes("p-sm"):
                    with ui.row().classes("items-center gap-sm"):
                        ui.icon(icon, color=color)
                        ui.label(prov).classes("text-subtitle2")
                        ui.badge(label, color=color).props("outline")
                    ui.label(when).classes("text-caption opacity-70")
                    ui.label(detail).classes("text-caption")
                    report = fetched.get(prov)
                    if report is not None:
                        ui.label(f"Fetched: {', '.join(report.symbols)}").classes(
                            "text-caption opacity-70"
                        ).style("max-width:22rem; overflow-wrap:anywhere")

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
                    ui.label(ev.at.astimezone(tz).strftime("%H:%M:%S")).classes(
                        "text-caption font-mono opacity-70"
                    )
                    ui.label(ev.provider).classes("text-caption font-mono")
                    ui.label(ev.message).classes("text-caption")


def _live_web_config(session) -> dict[str, str | None]:  # pragma: no cover - UI
    """Read persisted live-web prefs from app_config (non-secret only)."""
    return {
        "repo": app_config_repo.get(session, "live_web_repo"),
        "enabled": app_config_repo.get(session, "live_web_enabled"),
        "include_transactions": app_config_repo.get(session, "live_web_include_transactions"),
        "publish_on_import": app_config_repo.get(session, "live_web_publish_on_import"),
        "publish_on_shutdown": app_config_repo.get(session, "live_web_publish_on_shutdown"),
        "publish_on_manual_edit": app_config_repo.get(session, "live_web_publish_on_manual_edit"),
        "last_published_at": app_config_repo.get(session, "live_web_last_published_at"),
    }


def _save_live_web_passphrase(passphrase: str, confirm: str) -> None:  # pragma: no cover - UI
    """Validate + store the mobile (web companion) passphrase in the keychain."""
    from investment_dashboard.storage.encryption import (  # noqa: PLC0415
        store_mobile_passphrase_in_keyring,
        validate_passphrase,
    )

    error = validate_passphrase(passphrase, confirm)
    if error is not None:
        ui.notify(error, type="warning")
        return
    if store_mobile_passphrase_in_keyring(passphrase):
        ui.notify(
            "Mobile passphrase saved to the OS keychain. Use the same phrase "
            "in the browser to unlock the live view.",
            type="positive",
        )
    else:
        ui.notify(
            "Could not reach the OS keychain. Check that a keyring backend "
            "is available for your operating system.",
            type="negative",
        )


def _save_publish_token(token: str) -> None:  # pragma: no cover - UI
    """Store the GitHub publish PAT in the OS keychain."""
    from investment_dashboard.storage.encryption import (  # noqa: PLC0415
        store_publish_token_in_keyring,
    )

    if not token.strip():
        ui.notify("Paste a GitHub token first.", type="warning")
        return
    if store_publish_token_in_keyring(token.strip()):
        ui.notify("GitHub token saved to the OS keychain.", type="positive")
    else:
        ui.notify(
            "Could not reach the OS keychain. Check that a keyring backend "
            "is available for your operating system.",
            type="negative",
        )


def _save_live_web_prefs(
    repo: str,
    enabled: bool,
    include_transactions: bool,
    publish_on_import: bool,
    publish_on_shutdown: bool,
    publish_on_manual_edit: bool,
) -> None:
    # pragma: no cover - UI
    """Persist the non-secret live-web preferences to app_config."""
    try:
        with session_scope() as session:
            app_config_repo.set_value(session, "live_web_repo", repo.strip() or None)
            app_config_repo.set_value(session, "live_web_enabled", "true" if enabled else "false")
            app_config_repo.set_value(
                session,
                "live_web_include_transactions",
                "true" if include_transactions else "false",
            )
            app_config_repo.set_value(
                session,
                "live_web_publish_on_import",
                "true" if publish_on_import else "false",
            )
            app_config_repo.set_value(
                session,
                "live_web_publish_on_shutdown",
                "true" if publish_on_shutdown else "false",
            )
            app_config_repo.set_value(
                session,
                "live_web_publish_on_manual_edit",
                "true" if publish_on_manual_edit else "false",
            )
    except Exception as exc:
        ui.notify(f"Could not save preferences: {exc}", type="negative")
        return
    ui.notify("Live web companion preferences saved.", type="positive")


def _publish_now_clicked(repo: str, include_transactions: bool) -> None:  # pragma: no cover - UI
    """Build → encrypt → publish the live-web blob, then record the timestamp."""
    from investment_dashboard.services import publish_service  # noqa: PLC0415

    try:
        with session_scope() as session:
            result = publish_service.publish_now(
                session,
                repo=repo.strip() or None,
                include_transactions=include_transactions,
            )
        with session_scope() as session:
            app_config_repo.set_value(
                session, "live_web_last_published_at", result.published_at.isoformat()
            )
    except publish_service.PublishError as exc:
        ui.notify(str(exc), type="negative")
        return
    except Exception as exc:  # pragma: no cover - network/runtime
        ui.notify(f"Publish failed: {exc}", type="negative")
        return
    ui.notify(
        f"Published {result.asset_name} ({result.size_bytes} bytes) to "
        f"{result.repo}@{result.release_tag}.",
        type="positive",
    )


def _format_last_published(raw: str | None, tz: tzinfo) -> str:  # pragma: no cover - UI
    """Render the stored last-published ISO timestamp in the user's timezone.

    Stored as a UTC ISO-8601 string; shown without a zone suffix since the user
    already chose the display zone in Settings. Falls back to the raw value if it
    can't be parsed (forward-compatible / never blank).
    """
    if not raw:
        return "Not published yet."
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        return f"Last published: {raw}"
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return f"Last published: {moment.astimezone(tz):%Y-%m-%d %H:%M}"


def _render_live_web_companion_section() -> None:  # pragma: no cover - UI
    """Settings panel for the v3.0 live web companion (proposal §5.6)."""
    with session_scope() as session:
        cfg = _live_web_config(session)
        tz = timezone_service.resolve_tzinfo(timezone_service.get_timezone(session))

    ui.label(
        "Publish an encrypted snapshot of your portfolio to a GitHub release "
        "so a browser-based companion can show live figures on the go. The "
        "blob is AES-256-GCM encrypted on this machine; only someone with your "
        "mobile passphrase can read it.",
    ).classes("text-caption opacity-70")

    repo_in = (
        ui.input("Repository (owner/name)", value=cfg["repo"] or "")
        .props("outlined dense")
        .classes("w-full max-w-md")
    )
    enabled_sw = ui.switch("Enable publishing", value=cfg["enabled"] == "true")
    include_sw = ui.switch(
        "Include transactions in the export",
        value=cfg["include_transactions"] == "true",
    )
    ui.label("Auto-publish (only fires while publishing is enabled)").classes("text-subtitle2")
    on_import_sw = ui.switch(
        "Publish after every successful import",
        # Auto-triggers default on when the master switch is enabled (§8.2).
        value=cfg["publish_on_import"] != "false",
    )
    on_shutdown_sw = ui.switch(
        "Publish on graceful app close",
        value=cfg["publish_on_shutdown"] != "false",
    )
    on_manual_edit_sw = ui.switch(
        "Publish ~2 min after a manual transaction edit",
        value=cfg["publish_on_manual_edit"] != "false",
    )
    ui.button(
        "Save preferences",
        icon="save",
        on_click=lambda: _save_live_web_prefs(
            repo_in.value or "",
            bool(enabled_sw.value),
            bool(include_sw.value),
            bool(on_import_sw.value),
            bool(on_shutdown_sw.value),
            bool(on_manual_edit_sw.value),
        ),
    ).props("flat no-caps")

    ui.separator()
    ui.label("Secrets (stored in the OS keychain, never in the repo)").classes("text-subtitle2")
    pass_in = (
        ui.input("Mobile passphrase")
        .props("outlined dense type=password autocomplete=new-password")
        .classes("w-full max-w-md")
    )
    confirm_in = (
        ui.input("Confirm passphrase")
        .props("outlined dense type=password autocomplete=new-password")
        .classes("w-full max-w-md")
    )
    token_in = (
        ui.input("GitHub token (fine-grained PAT, Contents: write)")
        .props("outlined dense type=password autocomplete=off")
        .classes("w-full max-w-md")
    )
    with ui.row().classes("gap-sm"):
        ui.button(
            "Save passphrase",
            icon="key",
            on_click=lambda: _save_live_web_passphrase(pass_in.value or "", confirm_in.value or ""),
        ).props("unelevated color=primary no-caps")
        ui.button(
            "Save token",
            icon="vpn_key",
            on_click=lambda: _save_publish_token(token_in.value or ""),
        ).props("flat no-caps")

    ui.separator()
    with ui.row().classes("items-center gap-md"):
        ui.button(
            "Publish now",
            icon="cloud_upload",
            on_click=lambda: _publish_now_clicked(repo_in.value or "", bool(include_sw.value)),
        ).props("unelevated color=primary no-caps")
        last = cfg["last_published_at"]
        ui.label(_format_last_published(last, tz)).classes("text-caption opacity-70")


def _render_help_section() -> None:  # pragma: no cover - UI
    ui.label(
        "New to the dashboard, or unsure what a control does? Open the in-app "
        "guide for a plain-English explanation of every page and every setting "
        "on this screen.",
    ).classes("text-caption opacity-70")
    with ui.row().classes("gap-md q-mt-sm"):
        ui.button(
            "Open Help & user guide",
            icon="help_outline",
            on_click=lambda: ui.navigate.to("/help"),
        ).props("unelevated color=primary no-caps")


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
                current_timezone = timezone_service.get_timezone(session)
                benchmark_symbol = benchmark_service.get_symbol(session)
                rf_snapshot = risk_free_service.get_risk_free_rate(
                    session,
                    fetcher=lambda symbol: None,  # don't hit the network on a settings render
                )

            with section("Display preferences"):
                ui.label(
                    "Controls how figures are shown across the app. These "
                    "options change presentation only — they never alter your "
                    "transactions or move money.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_display_prefs(current_currency, current_timezone)
            with section("Analytics preferences"):
                ui.label(
                    "Inputs used by the risk metrics on the Analytics page. The "
                    "benchmark is what your portfolio is compared against; the "
                    "risk-free rate feeds Sharpe, Sortino and Alpha.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_analytics_prefs(
                    benchmark_symbol=benchmark_symbol,
                    rf_snapshot=rf_snapshot,
                )
            with section("Storage"):
                ui.label(
                    "Where your data files live and whether encryption or "
                    "cloud-sync is in effect. You can point the ledger and "
                    "config tiers at a sync folder of your choice below.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_storage_section()
            with section("Server"):
                ui.label(
                    "Start/stop controls for the local server. Hand off the "
                    "writer lock to another instance, or shut the server down "
                    "cleanly when you're done.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_server_section()
            with section("Live web companion"):
                ui.label(
                    "Publish an encrypted, read-only snapshot to a GitHub "
                    "release for a browser companion that shows live figures "
                    "on the go. Off until you add a repo, passphrase and token.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_live_web_companion_section()
            with section("Data refresh"):
                ui.label(
                    "Pull fresh prices and FX rates on demand. The app also "
                    "refreshes in the background, so use these only when you want "
                    "the latest numbers right now.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_data_refresh()
            with section("Connectivity"):
                ui.label(
                    "Whether the last call to each data provider succeeded. "
                    "Green is good; check here if a refresh is not updating.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_connectivity_section()
            with section("Accounts"):
                ui.label(
                    "Your brokerage and savings accounts. Mark an account "
                    "inactive to keep its history while hiding it from the live "
                    "view.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_accounts_section(accounts)
            with section("Instruments"):
                ui.label(
                    "The funds, ETFs and cash lines you hold. The expense ratio "
                    "is a decimal fraction (0.0007 = 0.07%); categories group "
                    "instruments in allocation views.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_instruments_section(instruments, instrument_overrides)
            with section("Target allocations"):
                ui.label(
                    "Your desired instrument mix by percentage (weights must sum "
                    "to 100%). Activate one to drive the allocation-drift "
                    "metrics; only one is active at a time.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_allocations_section(allocations)
            with section("Help & documentation"):
                _render_help_section()
            with section("Developer tools"):
                ui.label(
                    "Diagnostics for reconciling the app against another "
                    "source. Tucked away and optionally password-gated.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_dev_tools_section()
            # Reset lives last — it's the most destructive action, so it sits
            # at the bottom of the page rather than near the top (v2.8).
            with section("Reset data"):
                ui.label(
                    "Wipe data so you can start over or re-import. Pick the "
                    "smallest option that fits — each asks for confirmation, and "
                    "the factory reset cannot be undone.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_reset_section()
