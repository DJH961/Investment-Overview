"""Deposits page (spec §8.2) — summary KPIs + cash-flow table."""

from __future__ import annotations

from typing import Any

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.ui.components.kpi_card import kpi_card
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.pages._deposits_query import (
    compute_summary,
    list_deposit_rows,
)

PATH = "/deposits"


def _fmt_eur(value: Any) -> str:
    return f"€{value:,.2f}"


def register() -> None:
    @ui.page(PATH)
    def _deposits() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Deposits", current=PATH):
            ui.label("Deposits, withdrawals and interest").classes("text-h5")
            with session_scope() as session:
                summary = compute_summary(session)
                rows = list_deposit_rows(session)
            with ui.row().classes("gap-md flex-wrap"):
                kpi_card("Total contributed", _fmt_eur(summary.total_contrib_eur))
                kpi_card("YTD contributions", _fmt_eur(summary.ytd_contrib_eur))
                kpi_card("MTD contributions", _fmt_eur(summary.mtd_contrib_eur))
                kpi_card("Interest YTD", _fmt_eur(summary.interest_ytd_eur))
            ui.separator()
            ui.aggrid(
                {
                    "columnDefs": [
                        {"headerName": "Date", "field": "date", "sortable": True, "filter": True},
                        {"headerName": "Account", "field": "account", "filter": True},
                        {"headerName": "Kind", "field": "kind", "filter": True},
                        {
                            "headerName": "Amount (native)",
                            "field": "amount_native",
                            "type": "rightAligned",
                        },
                        {"headerName": "Currency", "field": "currency"},
                        {
                            "headerName": "Amount (EUR)",
                            "field": "amount_eur",
                            "type": "rightAligned",
                        },
                        {"headerName": "Description", "field": "description"},
                    ],
                    "rowData": rows,
                    "defaultColDef": {"resizable": True, "sortable": True},
                    "pagination": True,
                    "paginationAutoPageSize": True,
                }
            ).classes("w-full h-[60vh]")
