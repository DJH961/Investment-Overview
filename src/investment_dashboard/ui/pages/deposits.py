"""Deposits page (spec §8.2) — summary KPIs + cash-flow table."""

from __future__ import annotations

from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.ui.components import (
    empty_state,
    page_header,
    section,
)
from investment_dashboard.ui.components.kpi_card import dual_kpi_card
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import fmt_money
from investment_dashboard.ui.pages._deposits_query import (
    DepositSummary,
    compute_summary,
    list_deposit_rows,
)

PATH = "/deposits"


def _pair_for(summary: DepositSummary, key: str) -> tuple[Decimal, Decimal]:
    """Return ``(eur, usd)`` totals for one summary key."""
    return getattr(summary, f"{key}_eur"), getattr(summary, f"{key}_usd")


def register() -> None:
    @ui.page(PATH)
    def _deposits() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Deposits", current=PATH):
            page_header("Deposits", subtitle="Deposits, withdrawals and interest")
            with session_scope() as session:
                summary = compute_summary(session)
                rows = list_deposit_rows(session)
                display_ccy = display_currency_service.get_display_currency(session)

            def _kpi(label: str, key: str) -> None:
                eur, usd = _pair_for(summary, key)
                dual_kpi_card(
                    label,
                    fmt_money(eur, "EUR"),
                    fmt_money(usd, "USD"),
                    primary=display_ccy,
                )

            with ui.row().classes("gap-md flex-wrap w-full"):
                _kpi("Total contributed", "total_contrib")
                _kpi("YTD contributions", "ytd_contrib")
                _kpi("MTD contributions", "mtd_contrib")
                _kpi("Interest YTD", "interest_ytd")
            if not rows:
                empty_state(
                    "savings",
                    "No deposits recorded",
                    hint="Import a broker CSV from Transactions, or add manual rows there.",
                )
            else:
                with section("Cash-flow ledger"):
                    ui.aggrid(
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
                                # v2.5 — drop the native + currency columns
                                # in favour of explicit dual EUR + USD,
                                # mirroring PR #18 on Transactions. The
                                # native value remains available in the
                                # row's ``amount_native`` tooltip cell.
                                {
                                    "headerName": "Amount (EUR)",
                                    "field": "amount_eur",
                                    "type": "rightAligned",
                                    "tooltipField": "amount_native_tt",
                                },
                                {
                                    "headerName": "Amount (USD)",
                                    "field": "amount_usd",
                                    "type": "rightAligned",
                                    "tooltipField": "amount_native_tt",
                                },
                                {"headerName": "Description", "field": "description"},
                            ],
                            "rowData": rows,
                            "defaultColDef": {
                                "resizable": True,
                                "sortable": True,
                                "flex": 1,
                                "minWidth": 100,
                            },
                            "pagination": True,
                            "paginationAutoPageSize": True,
                        }
                    ).classes("ag-theme-alpine w-full h-[60vh]")
