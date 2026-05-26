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
from investment_dashboard.services.positions_service import compute_positions
from investment_dashboard.services.prices_service import latest_close
from investment_dashboard.ui.layout import page_frame

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
            ui.label("Investment calculator").classes("text-h5")
            cash_in = ui.input("Cash to invest (EUR)", value="1000").classes("min-w-[14rem]")
            fractional = ui.checkbox("Allow fractional shares", value=False)
            result_container = ui.column().classes("w-full")

            def _run() -> None:
                cash = _decimal_or_zero(cash_in.value or "")
                if cash <= 0:
                    ui.notify("Enter a positive cash amount", type="warning")
                    return
                with session_scope() as session:
                    active = allocations_repo.get_active(session)
                    if active is None:
                        ui.notify(
                            "No active target allocation — add one in Settings", type="warning"
                        )
                        return
                    target_pct: dict[int, Decimal] = {
                        item.instrument_id: item.weight_pct for item in active.items
                    }
                    positions = compute_positions(session)
                    current_values: dict[int, Decimal] = {
                        p.instrument.id: p.current_value_eur for p in positions
                    }
                    # Ensure every targeted instrument has a current value entry.
                    for instrument_id in target_pct:
                        current_values.setdefault(instrument_id, Decimal(0))
                    current_prices = {
                        instrument_id: latest_close(session, instrument_id) or Decimal(0)
                        for instrument_id in target_pct
                    }
                    symbol_by_id = {
                        i.id: i.symbol
                        for i in instruments_repo.list_instruments(session, only_active=False)
                    }
                try:
                    plan = plan_rebalance(
                        cash,
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
                        "current_value": f"{r.current_value:,.2f}",
                        "add_value": f"{r.add_value:,.2f}",
                        "add_shares": f"{r.add_shares}",
                    }
                    for r in plan.rows
                ]
                result_container.clear()
                with result_container:
                    ui.label(f"Residual cash after plan: €{plan.residual_cash:,.2f}").classes(
                        "text-subtitle1"
                    )
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
                                    "field": "current_value",
                                    "type": "rightAligned",
                                },
                                {
                                    "headerName": "Add (EUR)",
                                    "field": "add_value",
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
                    ).classes("w-full h-[40vh]")

            ui.button("Compute plan", on_click=_run).props("color=primary")
