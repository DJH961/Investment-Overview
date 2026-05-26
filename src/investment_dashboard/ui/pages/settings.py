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
            ui.aggrid(
                {
                    "columnDefs": [
                        {"headerName": "Broker", "field": "broker"},
                        {"headerName": "Label", "field": "account_label"},
                        {"headerName": "Currency", "field": "native_currency"},
                        {"headerName": "Type", "field": "account_type"},
                    ],
                    "rowData": [
                        {
                            "broker": a.broker,
                            "account_label": a.account_label,
                            "native_currency": a.native_currency,
                            "account_type": a.account_type,
                        }
                        for a in accounts
                    ],
                }
            ).classes("w-full h-[20vh]")

            ui.label("Instruments").classes("text-h6 q-mt-md")
            ui.aggrid(
                {
                    "columnDefs": [
                        {"headerName": "Symbol", "field": "symbol"},
                        {"headerName": "Name", "field": "name"},
                        {"headerName": "Asset class", "field": "asset_class"},
                        {"headerName": "Category", "field": "category"},
                    ],
                    "rowData": [
                        {
                            "symbol": i.symbol,
                            "name": i.name or "",
                            "asset_class": i.asset_class,
                            "category": i.category or "",
                        }
                        for i in instruments
                    ],
                }
            ).classes("w-full h-[25vh]")

            ui.label("Target allocations").classes("text-h6 q-mt-md")
            ui.aggrid(
                {
                    "columnDefs": [
                        {"headerName": "Name", "field": "name"},
                        {"headerName": "Active", "field": "active"},
                        {"headerName": "# Instruments", "field": "n"},
                    ],
                    "rowData": [
                        {"name": a.name, "active": "✓" if a.active else "", "n": len(a.items)}
                        for a in allocations
                    ],
                }
            ).classes("w-full h-[20vh]")
            ui.label(
                "Inline editing for accounts, instruments and allocations lands in v1.1."
            ).classes("text-caption opacity-70")
