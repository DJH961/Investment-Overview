"""Deposits page (spec §8.2) — summary KPIs + cash-flow table."""

from __future__ import annotations

from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.ui.components.kpi_card import kpi_card
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import fmt_money
from investment_dashboard.ui.pages._deposits_query import (
    compute_summary,
    list_deposit_rows,
)

PATH = "/deposits"


def _convert(amount_eur: Decimal, target: str, fx_rate: Decimal | None) -> Decimal:
    if target == "EUR" or fx_rate is None or fx_rate == 0:
        return amount_eur
    return amount_eur * fx_rate


def register() -> None:
    @ui.page(PATH)
    def _deposits() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Deposits", current=PATH):
            ui.label("Deposits, withdrawals and interest").classes("text-h5")
            with session_scope() as session:
                summary = compute_summary(session)
                rows = list_deposit_rows(session)
                display_ccy = display_currency_service.get_display_currency(session)
                fx_rate = display_currency_service.current_rate(session, quote="USD")
            secondary_ccy = "EUR" if display_ccy != "EUR" else "USD"

            def _kpi(label: str, eur_value: Decimal) -> None:
                primary = _convert(eur_value, display_ccy, fx_rate)
                secondary = _convert(eur_value, secondary_ccy, fx_rate)
                kpi_card(
                    label,
                    fmt_money(primary, display_ccy),
                    sub=fmt_money(secondary, secondary_ccy),
                )

            with ui.row().classes("gap-md flex-wrap"):
                _kpi("Total contributed", summary.total_contrib_eur)
                _kpi("YTD contributions", summary.ytd_contrib_eur)
                _kpi("MTD contributions", summary.mtd_contrib_eur)
                _kpi("Interest YTD", summary.interest_ytd_eur)
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
                        {
                            "headerName": "Amount (USD)",
                            "field": "amount_usd",
                            "type": "rightAligned",
                        },
                        {"headerName": "Description", "field": "description"},
                    ],
                    "rowData": _add_usd_column(rows, fx_rate),
                    "defaultColDef": {"resizable": True, "sortable": True},
                    "pagination": True,
                    "paginationAutoPageSize": True,
                }
            ).classes("w-full h-[60vh]")


def _add_usd_column(
    rows: list[dict[str, object]], fx_rate: Decimal | None
) -> list[dict[str, object]]:
    """Augment each deposit row with a USD-equivalent column.

    Done client-side here (rather than in the query layer) so the query
    helper remains UI-agnostic and stays easy to unit-test with no FX
    context.
    """
    out: list[dict[str, object]] = []
    for r in rows:
        new = dict(r)
        if fx_rate is None or fx_rate == 0:
            new["amount_usd"] = ""
        else:
            try:
                amount_eur = Decimal(str(r["amount_eur"]).replace(",", ""))
                new["amount_usd"] = f"{amount_eur * fx_rate:,.2f}"
            except Exception:
                new["amount_usd"] = ""
        out.append(new)
    return out
