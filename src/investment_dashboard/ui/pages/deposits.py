"""Deposits page (spec §8.2) — summary KPIs + cash-flow table."""

from __future__ import annotations

from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.ui.components import (
    empty_state,
    kpi_card,
    page_header,
    section,
)
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import fmt_money
from investment_dashboard.ui.pages._deposits_query import (
    DepositSummary,
    compute_summary,
    list_deposit_rows,
)

PATH = "/deposits"


def _pair_for(summary: DepositSummary, key: str, display_ccy: str) -> tuple[Decimal, Decimal]:
    """Return (primary, secondary) totals for one KPI, both currencies pre-aggregated.

    The values come from :class:`DepositSummary`'s per-trade-date USD
    totals (and the ledger's EUR totals), never from a today's-spot
    rescale of the EUR sum, so a USD-native account contributes its
    actual USD cashflows instead of being double-converted.
    """
    eur_value: Decimal = getattr(summary, f"{key}_eur")
    usd_value: Decimal = getattr(summary, f"{key}_usd")
    if display_ccy == "USD":
        return usd_value, eur_value
    return eur_value, usd_value


def register() -> None:
    @ui.page(PATH)
    def _deposits() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Deposits", current=PATH):
            page_header("Deposits", subtitle="Deposits, withdrawals and interest")
            with session_scope() as session:
                summary = compute_summary(session)
                rows = list_deposit_rows(session)
                display_ccy = display_currency_service.get_display_currency(session)
            secondary_ccy = "EUR" if display_ccy != "EUR" else "USD"

            def _kpi(label: str, key: str) -> None:
                primary, secondary = _pair_for(summary, key, display_ccy)
                kpi_card(
                    label,
                    fmt_money(primary, display_ccy),
                    sub=fmt_money(secondary, secondary_ccy),
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
                                {
                                    "headerName": "Amount (USD)",
                                    "field": "amount_usd",
                                    "type": "rightAligned",
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
