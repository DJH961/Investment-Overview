"""Settings page (spec §8.7) — accounts/instruments overview + refresh actions."""

from __future__ import annotations

import logging
from datetime import date, timedelta

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.repositories import (
    accounts_repo,
    allocations_repo,
    instruments_repo,
)
from investment_dashboard.services.fx_service import refresh_fx_history
from investment_dashboard.services.prices_service import refresh_prices
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
            from decimal import Decimal, InvalidOperation  # noqa: PLC0415

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
                        category=category_input.value.strip() or None,
                        asset_class=asset_class_input.value.strip() or None,
                        expense_ratio=expense_ratio,
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


def register() -> None:
    @ui.page(PATH)
    def _settings() -> None:  # pragma: no cover
        with page_frame("Settings", current=PATH):
            ui.label("Settings").classes("text-h5")
            with session_scope() as session:
                accounts = list(accounts_repo.list_accounts(session))
                instruments = list(instruments_repo.list_instruments(session, only_active=False))
                allocations = list(allocations_repo.list_allocations(session))

            with ui.row().classes("gap-md"):
                ui.button("Refresh FX rates", on_click=_refresh_fx_clicked).props(
                    "color=primary outline"
                )
                ui.button("Refresh prices", on_click=_refresh_prices_clicked).props(
                    "color=primary outline"
                )

            ui.separator()
            ui.label("Accounts").classes("text-h6")
            with ui.column().classes("w-full gap-xs"):
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
                        ).props("flat dense")

            ui.label("Instruments").classes("text-h6 q-mt-md")
            with ui.column().classes("w-full gap-xs"):
                for i in instruments:
                    with ui.row().classes("items-center gap-md w-full"):
                        ui.label(f"{i.symbol} · {i.name or ''}").classes("text-body1")
                        expense_lbl = (
                            f" · ER {i.expense_ratio}" if i.expense_ratio is not None else ""
                        )
                        ui.label(
                            f"{i.asset_class} · {i.category or '—'}{expense_lbl}"
                            f"{'' if i.active else ' · inactive'}"
                        ).classes("text-caption opacity-70")
                        ui.space()
                        ui.button(
                            "Edit",
                            on_click=lambda _, i=i: _edit_instrument_dialog(
                                i.id,
                                i.name or "",
                                i.category or "",
                                i.asset_class,
                                str(i.expense_ratio) if i.expense_ratio is not None else "",
                                i.active,
                            ),
                        ).props("flat dense")

            ui.label("Target allocations").classes("text-h6 q-mt-md")
            with ui.column().classes("w-full gap-xs"):
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
                            ).props("flat dense")
