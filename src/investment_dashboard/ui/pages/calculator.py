"""Investment calculator (spec §8.6) — buy-only rebalance against the
currently active target allocation.

Given a cash amount and the active allocation, the page calls
:func:`investment_dashboard.domain.allocation.plan_rebalance` and shows
the resulting buy plan in a table.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.domain.allocation import plan_rebalance
from investment_dashboard.repositories import allocations_repo, instruments_repo
from investment_dashboard.services import display_currency_service
from investment_dashboard.services.positions_service import compute_positions
from investment_dashboard.services.prices_service import latest_close
from investment_dashboard.ui.components import page_header, section
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import currency_symbol, fmt_shares

PATH = "/calculator"


def _decimal_or_zero(text: str) -> Decimal:
    try:
        return Decimal(text.strip())
    except (InvalidOperation, AttributeError):
        return Decimal(0)


def register() -> None:
    @ui.page(PATH)
    def _calculator() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Calculator", current=PATH):
            page_header(
                "Calculator",
                subtitle="Rebalance buy-only against the active target allocation",
            )

            with session_scope() as session:
                default_ccy = display_currency_service.get_display_currency(session)
                fx_rate = display_currency_service.current_rate(session, quote="USD")

            with section("Inputs"):
                with ui.row().classes("items-end gap-md flex-wrap"):
                    cash_in = (
                        ui.input(
                            "Cash to invest",
                            value="1000",
                        )
                        .classes("min-w-[14rem]")
                        .props("outlined dense")
                    )
                    ccy_in = ui.toggle(
                        list(display_currency_service.SUPPORTED_CURRENCIES),
                        value=default_ccy,
                    ).props("dense unelevated")
                    fractional = ui.checkbox("Allow fractional shares", value=False)
                    ui.space()
                    compute_btn_slot = ui.row().classes("items-center")
                ui.label(
                    "Input the cash amount in your preferred currency; the plan is computed "
                    "internally in EUR (the dashboard's base) and the buy amounts displayed in "
                    "both currencies where an FX rate is available.",
                ).classes("text-caption opacity-70")
            result_container = ui.column().classes("w-full gap-md")

            def _to_eur(amount: Decimal, source_currency: str) -> Decimal:
                if source_currency == "EUR" or fx_rate is None or fx_rate == 0:
                    return amount
                return amount / fx_rate

            def _from_eur(amount_eur: Decimal, target: str) -> Decimal:
                if target == "EUR" or fx_rate is None or fx_rate == 0:
                    return amount_eur
                return amount_eur * fx_rate

            def _run() -> None:
                cash_raw = _decimal_or_zero(cash_in.value or "")
                source_ccy = ccy_in.value or default_ccy
                if cash_raw <= 0:
                    ui.notify("Enter a positive cash amount", type="warning")
                    return
                cash_eur = _to_eur(cash_raw, source_ccy)
                with session_scope() as session:
                    active = allocations_repo.get_active(session)
                    if active is None:
                        ui.notify(
                            "No active target allocation — add one in Settings",
                            type="warning",
                        )
                        return
                    target_pct: dict[int, Decimal] = {
                        item.instrument_id: item.weight_pct for item in active.items
                    }
                    positions = compute_positions(session)
                    current_values: dict[int, Decimal] = {
                        p.instrument.id: p.current_value_eur for p in positions
                    }
                    for instrument_id in target_pct:
                        current_values.setdefault(instrument_id, Decimal(0))
                    current_prices = {
                        instrument_id: latest_close(session, instrument_id) or Decimal(0)
                        for instrument_id in target_pct
                    }
                    symbol_by_id = {
                        i.id: i.symbol for i in instruments_repo.list_instruments(session)
                    }
                try:
                    plan = plan_rebalance(
                        cash_eur,
                        target_pct,
                        current_values,
                        current_prices,
                        allow_fractional_shares=fractional.value,
                    )
                except ValueError as exc:
                    ui.notify(f"Cannot rebalance: {exc}", type="negative")
                    return
                rows = [
                    {
                        "symbol": symbol_by_id.get(r.instrument_id, f"#{r.instrument_id}"),
                        "target_pct": f"{r.target_pct:.2f} %",
                        "current_value_eur": f"€{r.current_value:,.2f}",
                        "current_value_usd": f"${_from_eur(r.current_value, 'USD'):,.2f}",
                        "add_value_eur": f"€{r.add_value:,.2f}",
                        "add_value_usd": f"${_from_eur(r.add_value, 'USD'):,.2f}",
                        "add_shares": fmt_shares(r.add_shares),
                    }
                    for r in plan.rows
                ]
                result_container.clear()
                with result_container:
                    sym_in = currency_symbol(source_ccy)
                    with section("Plan summary"):
                        ui.label(
                            f"Input: {sym_in}{cash_raw:,.2f} ({source_ccy})  →  "
                            f"€{cash_eur:,.2f} EUR internally",
                        ).classes("text-subtitle2 opacity-80")
                        ui.label(
                            f"Residual cash after plan: €{plan.residual_cash:,.2f} "
                            f"(${_from_eur(plan.residual_cash, 'USD'):,.2f})",
                        ).classes("text-subtitle1")
                    with section("Buy plan"):
                        ui.aggrid(
                            {
                                "columnDefs": [
                                    {"headerName": "Symbol", "field": "symbol"},
                                    {
                                        "headerName": "Target %",
                                        "field": "target_pct",
                                        "type": "rightAligned",
                                    },
                                    {
                                        "headerName": "Current value (EUR)",
                                        "field": "current_value_eur",
                                        "type": "rightAligned",
                                    },
                                    {
                                        "headerName": "Current value (USD)",
                                        "field": "current_value_usd",
                                        "type": "rightAligned",
                                    },
                                    {
                                        "headerName": "Add (EUR)",
                                        "field": "add_value_eur",
                                        "type": "rightAligned",
                                    },
                                    {
                                        "headerName": "Add (USD)",
                                        "field": "add_value_usd",
                                        "type": "rightAligned",
                                    },
                                    {
                                        "headerName": "Add shares",
                                        "field": "add_shares",
                                        "type": "rightAligned",
                                    },
                                ],
                                "rowData": rows,
                                "defaultColDef": {"resizable": True, "sortable": True},
                            }
                        ).classes("ag-theme-alpine w-full h-[55vh]")

            # ``_run`` is also wired to the Compute-plan button declared
            # in the Inputs section above (forward reference; closures
            # share the same outer scope).
            with compute_btn_slot:
                ui.button("Compute plan", icon="play_arrow", on_click=_run).props(
                    "unelevated color=primary no-caps"
                )
