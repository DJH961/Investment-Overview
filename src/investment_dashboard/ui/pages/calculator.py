"""Investment calculator — an in-page, category-aware allocation builder.

The calculator lets the user define a *target mix* right here (no trip to
Settings), either **by category** ("10 % International" auto-grouping the funds
in that category) or **by fund**, see how it compares to what they currently
hold, and turn a cash amount into a concrete buy-only plan via
:func:`investment_dashboard.domain.allocation.plan_rebalance`.

The target the user builds can be saved as a named target allocation (and
optionally activated), so the same definition can drive the allocation-drift
views elsewhere — the busy weight-entry form no longer lives in Settings.
"""

from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.domain.allocation import expand_category_weights, plan_rebalance
from investment_dashboard.repositories import allocations_repo
from investment_dashboard.ui.components import empty_state, kpi_card, page_header, section
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import currency_symbol, fmt_money, fmt_shares
from investment_dashboard.ui.pages._calculator_query import (
    CalcData,
    CalcInstrument,
    build_calculator_data,
)

log = logging.getLogger(__name__)

PATH = "/calculator"
ZERO = Decimal(0)
HUNDRED = Decimal(100)
TENTH = Decimal("0.1")

#: Accent ramp for the per-row bars (kept in sync with the overview palette).
_TARGET_COLOR = "var(--inv-accent, #0F4C81)"
_CURRENT_COLOR = "var(--inv-muted, #9aa4b2)"


def _decimal_or_zero(value: object) -> Decimal:
    if value is None or value == "":
        return ZERO
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return ZERO


def _round_to_100(weights: dict[int, Decimal]) -> dict[int, Decimal]:
    """Round weights to one decimal and absorb the residual into the largest."""
    rounded = {i: w.quantize(TENTH) for i, w in weights.items() if w > ZERO}
    if not rounded:
        return {}
    residual = HUNDRED - sum(rounded.values(), start=ZERO)
    if residual != ZERO:
        biggest = max(rounded, key=lambda i: rounded[i])
        rounded[biggest] += residual
    return rounded


def _scale_to_100(weights: dict[int, Decimal]) -> dict[int, Decimal]:
    """Normalise positive weights so they sum to exactly 100."""
    total = sum((w for w in weights.values() if w > ZERO), start=ZERO)
    if total <= ZERO:
        return {}
    return {i: w * HUNDRED / total for i, w in weights.items() if w > ZERO}


def _bar(current_pct: Decimal, target_pct: Decimal) -> str:
    """A small HTML bar overlaying the current weight under the target marker."""
    cur = max(0.0, min(100.0, float(current_pct)))
    tgt = max(0.0, min(100.0, float(target_pct)))
    return (
        '<div style="position:relative;height:10px;border-radius:5px;'
        'background:var(--inv-surface-2,#eef1f5);overflow:hidden;min-width:7rem">'
        f'<div style="position:absolute;inset:0;width:{cur}%;background:{_CURRENT_COLOR};'
        'opacity:0.45"></div>'
        f'<div style="position:absolute;top:0;bottom:0;left:calc({tgt}% - 1px);width:2px;'
        f'background:{_TARGET_COLOR}"></div>'
        "</div>"
    )


def register() -> None:
    @ui.page(PATH)
    def _calculator() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Calculator", current=PATH):
            page_header(
                "Calculator",
                subtitle="Build a target mix and turn cash into a buy-only plan",
            )
            with session_scope() as session:
                data = build_calculator_data(session)
                active = allocations_repo.get_active(session)
                active_weights = (
                    {item.instrument_id: item.weight_pct for item in active.items}
                    if active is not None
                    else {}
                )

            if not data.instruments:
                empty_state(
                    "calculate",
                    "No instruments yet",
                    hint="Add an account and an instrument in Settings, then come back "
                    "to build a target mix and plan your next contribution.",
                )
                return

            _CalculatorView(data, active_weights).render()


class _CalculatorView:  # pragma: no cover - UI wiring
    """Stateful view object holding the in-page allocation builder."""

    def __init__(self, data: CalcData, active_weights: dict[int, Decimal]) -> None:
        self.data = data
        self.by_id = data.by_id()
        self.active_weights = active_weights
        self.fx = data.fx_rate_usd_per_eur
        # Builder state.
        self.mode = "category"  # or "fund"
        self.cat_targets: dict[str, float] = {}
        self.cat_split: dict[str, str] = {c.name: "value" for c in data.categories}
        self.cat_selected: dict[str, set[int]] = {
            c.name: {m.instrument_id for m in c.members} for c in data.categories
        }
        self.fund_targets: dict[int, float] = {}

    # -- currency helpers --------------------------------------------------
    def _from_eur(self, amount_eur: Decimal, target: str) -> Decimal:
        if target == "EUR" or not self.fx or self.fx == ZERO:
            return amount_eur
        return amount_eur * self.fx

    def _to_eur(self, amount: Decimal, source: str) -> Decimal:
        if source == "EUR" or not self.fx or self.fx == ZERO:
            return amount
        return amount / self.fx

    # -- render ------------------------------------------------------------
    def render(self) -> None:
        self._render_summary()
        self._render_cash_section()
        self._render_target_section()
        self.result_box = ui.column().classes("w-full gap-md")

    def _render_summary(self) -> None:
        total = self.data.total_value_eur
        held = sum(1 for i in self.data.instruments if i.current_value_eur > ZERO)
        with ui.row().classes("w-full gap-md flex-wrap q-mb-sm"):
            kpi_card(
                "Portfolio value",
                fmt_money(total, "EUR"),
                sub=fmt_money(self._from_eur(total, "USD"), "USD"),
            )
            kpi_card("Holdings", str(held))
            kpi_card("Categories", str(len(self.data.categories)))

    def _render_cash_section(self) -> None:
        with (
            section("1 · How much are you investing?"),
            ui.row().classes("items-end gap-md flex-wrap"),
        ):
            self.cash_in = (
                ui.number("Cash to invest", value=1000, min=0, format="%.2f")
                .classes("min-w-[12rem]")
                .props("outlined dense")
            )
            self.ccy_in = ui.toggle(["EUR", "USD"], value=self.data.default_currency).props(
                "dense unelevated"
            )
            self.fractional = ui.checkbox("Allow fractional shares", value=False)

    def _render_target_section(self) -> None:
        with section("2 · Set your target mix"):
            with ui.row().classes("items-center gap-md flex-wrap"):
                ui.toggle(
                    {"category": "By category", "fund": "By fund"},
                    value=self.mode,
                    on_change=self._on_mode_change,
                ).props("dense unelevated")
                ui.space()
                ui.button(
                    "Match current mix", icon="content_copy", on_click=self._preset_current
                ).props("flat dense no-caps")
                ui.button("Equal weight", icon="balance", on_click=self._preset_equal).props(
                    "flat dense no-caps"
                )
                if self.active_weights:
                    ui.button(
                        "Load saved target", icon="bookmark", on_click=self._preset_saved
                    ).props("flat dense no-caps")
                ui.button("Clear", icon="clear", on_click=self._preset_clear).props(
                    "flat dense no-caps"
                )

            ui.label(
                "Enter a target % per row. Totals are normalised to 100 % when you compute, "
                "so you can sketch freely. By category, each category's % is split across the "
                "funds you tick — fairly by current value, or evenly.",
            ).classes("text-caption opacity-70")

            with ui.row().classes("items-center gap-md w-full q-mt-sm"):
                self.total_bar = (
                    ui.linear_progress(value=0, show_value=False)
                    .props("rounded size=10px")
                    .classes("flex-1")
                )
                self.total_label = ui.html("")

            self.builder_box = ui.column().classes("w-full gap-xs q-mt-sm")
            self._render_builder()

            with ui.row().classes("items-center gap-md q-mt-md"):
                ui.button("Compute plan", icon="play_arrow", on_click=self._compute).props(
                    "unelevated color=primary no-caps"
                )
                ui.button("Save as target…", icon="save", on_click=self._save_dialog).props(
                    "flat no-caps"
                )

    # -- builder body ------------------------------------------------------
    def _render_builder(self) -> None:
        self.builder_box.clear()
        with self.builder_box:
            if self.mode == "category":
                for cat in self.data.categories:
                    self._render_category_row(cat.name)
            else:
                for instr in sorted(
                    self.data.instruments, key=lambda i: i.current_value_eur, reverse=True
                ):
                    self._render_fund_row(instr)
        self._update_total()

    def _render_category_row(self, name: str) -> None:
        cat = next(c for c in self.data.categories if c.name == name)
        with ui.element("div").classes("inv-section w-full").style("padding:0.6rem 0.8rem"):
            with ui.row().classes("items-center gap-md w-full no-wrap"):
                with ui.column().classes("gap-none").style("min-width:11rem"):
                    ui.label(name).classes("text-body1")
                    ui.html(
                        '<span class="text-caption opacity-70">now '
                        f"{cat.current_pct:.1f} % · {fmt_money(cat.current_value_eur, 'EUR')}</span>"
                    )
                ui.html(
                    _bar(cat.current_pct, _decimal_or_zero(self.cat_targets.get(name)))
                ).classes("flex-1")
                ui.number(
                    "Target %",
                    value=self.cat_targets.get(name),
                    min=0,
                    format="%.1f",
                    on_change=lambda e, n=name: self._set_cat_target(n, e.value),
                ).props("outlined dense suffix=%").classes("w-[7rem]")
            with ui.expansion("Funds in this category", icon="tune").classes("w-full"):
                with ui.row().classes("items-center gap-md flex-wrap"):
                    ui.label("Split:").classes("text-caption opacity-70")
                    ui.toggle(
                        {"value": "Fair by value", "equal": "Even"},
                        value=self.cat_split.get(name, "value"),
                        on_change=lambda e, n=name: self.cat_split.__setitem__(n, e.value),
                    ).props("dense unelevated")
                for member in cat.members:
                    self._render_member_checkbox(name, member)

    def _render_member_checkbox(self, category: str, member: CalcInstrument) -> None:
        checked = member.instrument_id in self.cat_selected[category]
        label = f"{member.symbol} · {member.name}  ({member.current_pct:.1f} %)"
        ui.checkbox(
            label,
            value=checked,
            on_change=lambda e, c=category, mid=member.instrument_id: self._toggle_member(
                c, mid, bool(e.value)
            ),
        ).classes("text-body2")

    def _render_fund_row(self, instr: CalcInstrument) -> None:
        with (
            ui.row()
            .classes("items-center gap-md w-full no-wrap inv-section")
            .style("padding:0.5rem 0.8rem")
        ):
            with ui.column().classes("gap-none").style("min-width:13rem"):
                ui.label(f"{instr.symbol} · {instr.name}").classes("text-body2")
                ui.html(
                    f'<span class="text-caption opacity-70">{instr.category} · now '
                    f"{instr.current_pct:.1f} %</span>"
                )
            ui.html(
                _bar(
                    instr.current_pct, _decimal_or_zero(self.fund_targets.get(instr.instrument_id))
                )
            ).classes("flex-1")
            ui.number(
                "Target %",
                value=self.fund_targets.get(instr.instrument_id),
                min=0,
                format="%.1f",
                on_change=lambda e, mid=instr.instrument_id: self._set_fund_target(mid, e.value),
            ).props("outlined dense suffix=%").classes("w-[7rem]")

    # -- state mutation ----------------------------------------------------
    def _on_mode_change(self, e: object) -> None:
        self.mode = e.value  # type: ignore[attr-defined]
        self._render_builder()

    def _set_cat_target(self, name: str, value: object) -> None:
        self.cat_targets[name] = float(value) if value not in (None, "") else 0.0
        self._update_total()

    def _set_fund_target(self, mid: int, value: object) -> None:
        self.fund_targets[mid] = float(value) if value not in (None, "") else 0.0
        self._update_total()

    def _toggle_member(self, category: str, mid: int, checked: bool) -> None:
        if checked:
            self.cat_selected[category].add(mid)
        else:
            self.cat_selected[category].discard(mid)

    # -- presets -----------------------------------------------------------
    def _preset_current(self) -> None:
        if self.mode == "category":
            self.cat_targets = {
                c.name: round(float(c.current_pct), 1) for c in self.data.categories
            }
            self.cat_split = {c.name: "value" for c in self.data.categories}
            self.cat_selected = {
                c.name: {m.instrument_id for m in c.members} for c in self.data.categories
            }
        else:
            self.fund_targets = {
                i.instrument_id: round(float(i.current_pct), 1)
                for i in self.data.instruments
                if i.current_pct > ZERO
            }
        self._render_builder()

    def _preset_equal(self) -> None:
        if self.mode == "category":
            cats = self.data.categories
            share = round(100.0 / len(cats), 1) if cats else 0.0
            self.cat_targets = {c.name: share for c in cats}
        else:
            held = [i for i in self.data.instruments if i.current_value_eur > ZERO]
            pool = held or self.data.instruments
            share = round(100.0 / len(pool), 1) if pool else 0.0
            self.fund_targets = {i.instrument_id: share for i in pool}
        self._render_builder()

    def _preset_saved(self) -> None:
        # Saved targets are per-fund; show them in fund mode for fidelity.
        self.mode = "fund"
        self.fund_targets = {mid: round(float(pct), 1) for mid, pct in self.active_weights.items()}
        self._render_builder()

    def _preset_clear(self) -> None:
        self.cat_targets = {}
        self.fund_targets = {}
        self._render_builder()

    # -- live total --------------------------------------------------------
    def _current_total(self) -> Decimal:
        if self.mode == "category":
            return sum((_decimal_or_zero(v) for v in self.cat_targets.values()), start=ZERO)
        return sum((_decimal_or_zero(v) for v in self.fund_targets.values()), start=ZERO)

    def _update_total(self) -> None:
        total = self._current_total()
        self.total_bar.set_value(min(1.0, float(total) / 100.0))
        on_target = abs(total - HUNDRED) <= Decimal("0.05")
        if total == ZERO:
            text = '<span class="text-caption opacity-70">No targets set yet</span>'
        elif on_target:
            color = "var(--inv-gain, #21ba45)"
            text = f'<span style="color:{color};font-weight:600">{total:g} %  ✓</span>'
        else:
            diff = HUNDRED - total
            verb = "more" if diff > ZERO else "over"
            text = (
                f'<span class="text-caption">{total:g} % '
                '<span class="opacity-70">(normalised to 100 % on compute; '
                f"{abs(diff):g} % {verb})</span></span>"
            )
        self.total_label.set_content(text)

    # -- compute -----------------------------------------------------------
    def _build_weights(self) -> dict[int, Decimal] | None:
        if self.mode == "category":
            return self._build_category_weights()
        weights = {
            mid: _decimal_or_zero(v)
            for mid, v in self.fund_targets.items()
            if _decimal_or_zero(v) > ZERO
        }
        if not weights:
            ui.notify("Set at least one fund target", type="warning")
            return None
        return weights

    def _build_category_weights(self) -> dict[int, Decimal] | None:
        cat_weights = {
            name: _decimal_or_zero(v)
            for name, v in self.cat_targets.items()
            if _decimal_or_zero(v) > ZERO
        }
        if not cat_weights:
            ui.notify("Set at least one category target", type="warning")
            return None
        current_values = {i.instrument_id: i.current_value_eur for i in self.data.instruments}
        weights: dict[int, Decimal] = {}
        for name, weight in cat_weights.items():
            selected = sorted(self.cat_selected.get(name, set()))
            if not selected:
                ui.notify(f"Pick at least one fund for '{name}'", type="warning")
                return None
            expanded = expand_category_weights(
                {name: weight},
                {name: selected},
                current_values,
                split=self.cat_split.get(name, "value"),
            )
            for mid, w in expanded.items():
                weights[mid] = weights.get(mid, ZERO) + w
        return weights

    def _compute(self) -> None:
        raw = self._build_weights()
        if raw is None:
            return
        target_pct = _scale_to_100(raw)
        if not target_pct:
            ui.notify("Targets must be positive", type="warning")
            return
        cash_raw = _decimal_or_zero(self.cash_in.value)
        source_ccy = self.ccy_in.value or self.data.default_currency
        if cash_raw <= ZERO:
            ui.notify("Enter a positive cash amount", type="warning")
            return
        cash_eur = self._to_eur(cash_raw, source_ccy)
        current_values = {i.instrument_id: i.current_value_eur for i in self.data.instruments}
        current_prices = {
            mid: self.by_id[mid].price_eur
            for mid in target_pct
            if self.by_id[mid].price_eur is not None
        }
        try:
            plan = plan_rebalance(
                cash_eur,
                target_pct,
                {mid: current_values.get(mid, ZERO) for mid in target_pct},
                current_prices,  # type: ignore[arg-type]
                allow_fractional_shares=bool(self.fractional.value),
            )
        except ValueError as exc:
            ui.notify(f"Cannot rebalance: {exc}", type="negative")
            return
        self._render_result(plan, cash_raw, cash_eur, source_ccy)

    # -- result ------------------------------------------------------------
    def _render_result(self, plan, cash_raw, cash_eur, source_ccy) -> None:
        self.result_box.clear()
        with self.result_box:
            sym = currency_symbol(source_ccy)
            with section("Plan summary"), ui.row().classes("w-full gap-md flex-wrap"):
                kpi_card(
                    "Investing",
                    f"{sym}{cash_raw:,.2f}",
                    sub=f"{fmt_money(cash_eur, 'EUR')} internal",
                )
                invested = plan.cash_to_invest - plan.residual_cash
                kpi_card(
                    "Allocated",
                    fmt_money(invested, "EUR"),
                    sub=fmt_money(self._from_eur(invested, "USD"), "USD"),
                )
                kpi_card(
                    "Left over",
                    fmt_money(plan.residual_cash, "EUR"),
                    sub=fmt_money(self._from_eur(plan.residual_cash, "USD"), "USD"),
                )
            with section("Buy plan"):
                total_after = sum((r.current_value + r.add_value for r in plan.rows), start=ZERO)
                for r in sorted(plan.rows, key=lambda row: row.add_value, reverse=True):
                    instr = self.by_id.get(r.instrument_id)
                    sym_name = instr.symbol if instr else f"#{r.instrument_id}"
                    after_pct = (
                        (r.current_value + r.add_value) * HUNDRED / total_after
                        if total_after > ZERO
                        else ZERO
                    )
                    self._render_plan_row(sym_name, r, after_pct)

    def _render_plan_row(self, name: str, r, after_pct: Decimal) -> None:
        with (
            ui.row()
            .classes("items-center gap-md w-full no-wrap inv-section")
            .style("padding:0.5rem 0.8rem")
        ):
            with ui.column().classes("gap-none").style("min-width:8rem"):
                ui.label(name).classes("text-body1")
                ui.html(
                    f'<span class="text-caption opacity-70">target {r.target_pct:.1f} % '
                    f"→ {after_pct:.1f} % after</span>"
                )
            ui.html(_bar(after_pct, r.target_pct)).classes("flex-1")
            with ui.column().classes("gap-none items-end").style("min-width:11rem"):
                if r.add_value > ZERO:
                    ui.html(
                        '<span style="color:var(--inv-gain,#21ba45);font-weight:600">'
                        f"+ {fmt_money(r.add_value, 'EUR')}</span>"
                    )
                    shares = f" · {fmt_shares(r.add_shares)} sh" if r.add_shares > ZERO else ""
                    ui.html(
                        '<span class="text-caption opacity-70">'
                        f"+ {fmt_money(self._from_eur(r.add_value, 'USD'), 'USD')}{shares}</span>"
                    )
                else:
                    ui.html('<span class="text-caption opacity-50">no buy</span>')

    # -- save --------------------------------------------------------------
    def _save_dialog(self) -> None:
        raw = self._build_weights()
        if raw is None:
            return
        weights = _round_to_100(_scale_to_100(raw))
        if not weights:
            ui.notify("Nothing to save — set some targets first", type="warning")
            return
        with ui.dialog() as dialog, ui.card().classes("min-w-[22rem]"):
            ui.label("Save target allocation").classes("text-h6")
            name_in = ui.input("Name", value="My target").classes("w-full")
            activate_in = ui.checkbox("Activate (drive allocation-drift views)", value=True)
            ui.label(f"{len(weights)} funds · sums to 100 %").classes("text-caption opacity-70")

            def _save() -> None:
                name = (name_in.value or "").strip()
                if not name:
                    ui.notify("Name is required", type="warning")
                    return
                try:
                    with session_scope() as session:
                        allocations_repo.create_allocation(
                            session, name, weights, active=bool(activate_in.value)
                        )
                except Exception as exc:
                    log.exception("Save target failed")
                    ui.notify(f"Save failed: {exc}", type="negative")
                    return
                ui.notify("Target saved", type="positive")
                dialog.close()

            with ui.row().classes("justify-end w-full gap-sm"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button("Save", on_click=_save).props("color=primary")
        dialog.open()
