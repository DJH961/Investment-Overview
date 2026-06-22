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
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from nicegui import ui
from sqlalchemy.orm import Session

from investment_dashboard.db import session_scope
from investment_dashboard.domain.allocation import (
    RebalancePlan,
    RebalanceRow,
    expand_category_weights,
    plan_rebalance,
)
from investment_dashboard.repositories import allocations_repo
from investment_dashboard.services import chart_prefs_service
from investment_dashboard.ui.components import (
    deferred,
    empty_state,
    kpi_card,
    page_header,
    section,
)
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import currency_symbol, fmt_money, fmt_shares
from investment_dashboard.ui.pages._calculator_query import (
    UNCATEGORIZED,
    CalcData,
    CalcInstrument,
    build_calculator_data,
)

log = logging.getLogger(__name__)

PATH = "/calculator"
ZERO = Decimal(0)
HUNDRED = Decimal(100)
TENTH = Decimal("0.1")

#: Persisted-setting keys (reused via :mod:`chart_prefs_service`'s app_config
#: key/value store) so the calculator's "allow fractional shares" / "rebalance"
#: toggles stick across reloads, like the display-currency and chart prefs.
_PREF_ALLOW_FRACTIONAL = "calc.allow_fractional"
_PREF_REBALANCE = "calc.rebalance"


def _get_bool_pref(session: Session, key: str) -> bool:
    """Read a persisted boolean calculator setting (defaults to ``False``)."""
    return chart_prefs_service.get_pref(session, key, default="0", allowed=["0", "1"]) == "1"


def _set_bool_pref(key: str, value: bool) -> None:
    """Persist a boolean calculator setting in its own DB session."""
    with session_scope() as session:
        chart_prefs_service.set_pref(session, key, "1" if value else "0")


#: Accent ramp for the per-row bars (kept in sync with the overview palette).
_TARGET_COLOR = "var(--inv-accent, #0F4C81)"
_CURRENT_COLOR = "var(--inv-muted, #9aa4b2)"
#: Vivid colour for the *added* (contribution) slice of a bar, so even a small
#: new contribution stands out against an already-large holding. The fallback is
#: the colourblind-safe Wong gain blue (matching ``--inv-gain``), never green.
_ADDED_COLOR = "var(--inv-gain, #0072B2)"


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


def _bar(current_pct: Decimal, target_pct: Decimal, added_from: Decimal | None = None) -> str:
    """A small HTML bar overlaying the current weight under the target marker.

    When ``added_from`` is given it marks the fill level *before* this round's
    contribution; the slice between ``added_from`` and ``current_pct`` is drawn
    in a vivid colour with a guaranteed-visible minimum width, so the cash put
    in this round is obvious even when it is tiny next to total wealth.
    """
    cur = max(0.0, min(100.0, float(current_pct)))
    tgt = max(0.0, min(100.0, float(target_pct)))
    added_html = ""
    if added_from is not None:
        start = max(0.0, min(cur, float(added_from)))
        if cur - start > 1e-9:
            # Guarantee a few px of visible width for tiny contributions while
            # keeping the slice anchored at the post-contribution edge.
            width = max(cur - start, 3.0)
            left = max(0.0, cur - width)
            added_html = (
                f'<div style="position:absolute;top:0;bottom:0;left:{left}%;'
                f'width:{width}%;background:{_ADDED_COLOR};opacity:0.85"></div>'
            )
    return (
        '<div style="position:relative;height:10px;border-radius:5px;'
        'background:var(--inv-surface-2,#eef1f5);overflow:hidden;min-width:7rem">'
        f'<div style="position:absolute;inset:0;width:{cur}%;background:{_CURRENT_COLOR};'
        'opacity:0.45"></div>'
        f"{added_html}"
        f'<div style="position:absolute;top:0;bottom:0;left:calc({tgt}% - 1px);width:2px;'
        f'background:{_TARGET_COLOR}"></div>'
        "</div>"
    )


@dataclass(frozen=True)
class _CalculatorPayload:
    """Everything the Calculator page needs, gathered off the event loop.

    Produced by the page's ``compute`` step (all heavy DB work on a worker
    thread) and handed to the render step on the loop, so a slow build never
    blocks the websocket — see
    :func:`investment_dashboard.ui.components.deferred.deferred`.
    """

    data: CalcData
    active_weights: dict[int, Decimal]
    active_no_buy: set[int]
    active_allow_sell: bool
    active_display_currency: str | None
    #: Persisted calculator settings (independent of any saved target) so the
    #: "allow fractional shares" / "rebalance" toggles survive reloads.
    pref_allow_fractional: bool = False
    pref_rebalance: bool = False


def register() -> None:
    @ui.page(PATH)
    def _calculator() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Calculator", current=PATH):
            page_header(
                "Calculator",
                subtitle="Build a target mix and turn cash into a buy-only plan",
            )

            def _gather() -> _CalculatorPayload:
                # All DB + metrics work happens here, off the event loop on a
                # worker thread (via ``deferred(compute=...)``), so a large
                # portfolio's calculator load never stalls the websocket and
                # trips the "disconnected" / reconnect storm on open tabs.
                with session_scope() as session:
                    data = build_calculator_data(session)
                    active = allocations_repo.get_active(session)
                    if active is not None:
                        active_weights = {
                            item.instrument_id: item.weight_pct for item in active.items
                        }
                        active_no_buy = {item.instrument_id for item in active.items if item.no_buy}
                        active_allow_sell = bool(active.allow_sell)
                        active_display_currency = active.display_currency
                    else:
                        active_weights = {}
                        active_no_buy = set()
                        active_allow_sell = False
                        active_display_currency = None
                    pref_allow_fractional = _get_bool_pref(session, _PREF_ALLOW_FRACTIONAL)
                    pref_rebalance = _get_bool_pref(session, _PREF_REBALANCE)
                return _CalculatorPayload(
                    data=data,
                    active_weights=active_weights,
                    active_no_buy=active_no_buy,
                    active_allow_sell=active_allow_sell,
                    active_display_currency=active_display_currency,
                    pref_allow_fractional=pref_allow_fractional,
                    pref_rebalance=pref_rebalance,
                )

            def _render(payload: _CalculatorPayload) -> None:
                if not payload.data.instruments:
                    empty_state(
                        "calculate",
                        "No instruments yet",
                        hint="Add an account and an instrument in Settings, then come back "
                        "to build a target mix and plan your next contribution.",
                    )
                    return

                _CalculatorView(payload).render()

            deferred(_render, compute=_gather)


class _CalculatorView:  # pragma: no cover - UI wiring
    """Stateful view object holding the in-page allocation builder."""

    def __init__(self, payload: _CalculatorPayload) -> None:
        data = payload.data
        self.data = data
        self.by_id = data.by_id()
        self.active_weights = payload.active_weights
        self.active_no_buy = payload.active_no_buy
        self.active_allow_sell = payload.active_allow_sell
        self.active_display_currency = payload.active_display_currency
        #: True when a saved target is available to auto-load on open.
        self.has_saved_target = bool(payload.active_weights)
        self.fx = data.fx_rate_usd_per_eur
        # Display/entry currency (drives the portfolio + per-holding values and
        # the cash amount). Toggling it re-renders the figures live.
        self.display_ccy = (
            data.default_currency if data.default_currency in ("EUR", "USD") else "EUR"
        )
        # Persisted toggles (survive reloads): whether the plan may sell
        # over-weight funds to rebalance (off = buy-only) and whether buys may
        # use fractional shares.
        self.allow_sell = payload.pref_rebalance
        self.allow_fractional = payload.pref_allow_fractional
        # Builder state.
        self.mode = "category"  # or "fund"
        self.cat_targets: dict[str, float] = {}
        self.cat_split: dict[str, str] = {c.name: "value" for c in data.categories}
        # Funds the user will actively invest into per category. Members not in
        # this set are still counted toward the category % but never bought.
        self.cat_selected: dict[str, set[int]] = {
            c.name: {m.instrument_id for m in c.members} for c in data.categories
        }
        self.fund_targets: dict[int, float] = {}
        # Convenience lookup of every member id per category (for no-buy math).
        self.cat_members: dict[str, list[int]] = {
            c.name: [m.instrument_id for m in c.members] for c in data.categories
        }

    # -- currency helpers --------------------------------------------------
    def _from_eur(self, amount_eur: Decimal, target: str) -> Decimal:
        if target == "EUR" or not self.fx or self.fx == ZERO:
            return amount_eur
        return amount_eur * self.fx

    def _to_eur(self, amount: Decimal, source: str) -> Decimal:
        if source == "EUR" or not self.fx or self.fx == ZERO:
            return amount
        return amount / self.fx

    def _other_ccy(self) -> str:
        return "USD" if self.display_ccy == "EUR" else "EUR"

    def _fmt(self, amount_eur: Decimal) -> str:
        """Format an EUR amount in the currently selected display currency."""
        return fmt_money(self._from_eur(amount_eur, self.display_ccy), self.display_ccy)

    def _fmt_other(self, amount_eur: Decimal) -> str:
        """Format an EUR amount in the *other* currency (for the sub-line)."""
        other = self._other_ccy()
        return fmt_money(self._from_eur(amount_eur, other), other)

    # -- render ------------------------------------------------------------
    def render(self) -> None:
        self.summary_box = ui.column().classes("w-full gap-none")
        self._render_summary()
        self._render_cash_section()
        self._render_target_section()
        self.result_box = ui.column().classes("w-full gap-md")
        # Auto-load the saved target weighting (if any) so the user's last saved
        # mix is ready immediately — no "Load" click needed. Runs after all the
        # widgets exist because it pushes values back into them.
        if self.has_saved_target:
            self._preset_saved()

    def _on_ccy_change(self, e: object) -> None:
        self.display_ccy = e.value  # type: ignore[attr-defined]
        # Re-paint every figure that is shown in the selected currency.
        self._render_summary()
        self._render_builder()
        # A previously computed plan was rendered in the old currency; drop it
        # so the user re-computes rather than reading mismatched figures.
        if hasattr(self, "result_box"):
            self.result_box.clear()

    def _render_summary(self) -> None:
        self.summary_box.clear()
        total = self.data.total_value_eur
        held = sum(1 for i in self.data.instruments if i.current_value_eur > ZERO)
        with self.summary_box, ui.row().classes("w-full items-center gap-md flex-wrap q-mb-sm"):
            kpi_card(
                "Portfolio value",
                self._fmt(total),
                sub=self._fmt_other(total),
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
            self.ccy_in = ui.toggle(
                ["EUR", "USD"],
                value=self.display_ccy,
                on_change=self._on_ccy_change,
            ).props("dense unelevated")
            self.fractional = ui.checkbox(
                "Allow fractional shares",
                value=self.allow_fractional,
                on_change=self._on_fractional,
            )
            self.rebalance = ui.checkbox(
                "Rebalance (allow selling)", value=self.allow_sell, on_change=self._on_rebalance
            ).tooltip("Off = buy only. On = sell over-weight funds to balance precisely.")

    def _on_fractional(self, e: object) -> None:
        self.allow_fractional = bool(e.value)  # type: ignore[attr-defined]
        _set_bool_pref(_PREF_ALLOW_FRACTIONAL, self.allow_fractional)

    def _on_rebalance(self, e: object) -> None:
        self.allow_sell = bool(e.value)  # type: ignore[attr-defined]
        _set_bool_pref(_PREF_REBALANCE, self.allow_sell)

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
                if self.has_saved_target:
                    # The saved target auto-loads on open, but keep a manual
                    # "Load saved target" button to re-apply it after the user
                    # tweaks or clears the inputs. Forgetting the saved target is
                    # covered by the existing "Clear" button below.
                    ui.button(
                        "Load saved target", icon="bookmark", on_click=self._preset_saved
                    ).props("flat dense no-caps").tooltip("Re-apply your saved target weighting.")
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
                        f"{cat.current_pct:.1f} % · {self._fmt(cat.current_value_eur)}</span>"
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
                ui.label(
                    "Untick a fund you don't invest in: the funds you do tick "
                    "share this category's whole % between them, and the un-ticked "
                    "fund just keeps its current holding (left to dilute over time).",
                ).classes("text-caption opacity-70")
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
        # Rebuild the category view from the saved per-fund weights so a target
        # saved "by category" loads back in category mode: group each fund's
        # weight under its category, and tick only the funds the saved plan
        # actually bought (no-buy members stay counted but un-ticked).
        cat_of = {i.instrument_id: i.category for i in self.data.instruments}
        cat_targets: dict[str, float] = {}
        selected_in_saved: dict[str, set[int]] = {}
        for mid, pct in self.active_weights.items():
            category = cat_of.get(mid)
            if category is None:
                continue
            cat_targets[category] = cat_targets.get(category, 0.0) + float(pct)
            # Restore the central no-buy distinction: a saved member counts
            # toward its category % but is only re-ticked when it was buyable.
            if mid not in self.active_no_buy:
                selected_in_saved.setdefault(category, set()).add(mid)

        self.cat_targets = {name: round(value, 1) for name, value in cat_targets.items()}
        self.cat_selected = {
            c.name: {m.instrument_id for m in c.members} for c in self.data.categories
        }
        # Only override categories that the saved plan touched, removing any
        # no-buy members so the un-ticked state survives the round-trip.
        saved_categories = {
            category for mid in self.active_weights if (category := cat_of.get(mid)) is not None
        }
        for category in saved_categories:
            if category in self.cat_selected:
                self.cat_selected[category] = selected_in_saved.get(category, set())
        # Keep the per-fund view in sync for users who switch to fund mode.
        self.fund_targets = {mid: round(float(pct), 1) for mid, pct in self.active_weights.items()}
        self.mode = "category"
        # Restore the saved calculator settings (rebalance toggle + display
        # currency) so loading a target reproduces the exact plan it was built
        # under.
        self.allow_sell = self.active_allow_sell
        if hasattr(self, "rebalance"):
            self.rebalance.set_value(self.allow_sell)
        if self.active_display_currency in ("EUR", "USD"):
            self.display_ccy = self.active_display_currency
            if hasattr(self, "ccy_in"):
                self.ccy_in.set_value(self.display_ccy)
            self._render_summary()
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
    def _build_weights(self) -> tuple[dict[int, Decimal], set[int]] | None:
        """Return ``(weights_by_id, no_buy_ids)`` or ``None`` on a validation error.

        ``no_buy_ids`` are funds that count toward the target percentages but
        should never receive fresh cash (the user un-ticked them).
        """
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
        return weights, set()

    def _build_category_weights(self) -> tuple[dict[int, Decimal], set[int]] | None:
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
            # Split the category's % across only the funds the user actually
            # invests in (the ticked ones). Funds left un-ticked don't get a
            # slice — the invested funds "pick up the slack" and absorb the whole
            # category target between them. The un-ticked funds simply keep their
            # current holding, whose share of the portfolio is left to dilute as
            # more cash flows into the funds the user does buy. (Previously the
            # category % was split across *all* members, which wrongly raised the
            # target of funds the user never tops up.)
            members = self.cat_members.get(name, [])
            if not members:
                continue
            selected = [mid for mid in members if mid in self.cat_selected.get(name, set())]
            if not selected:
                ui.notify(
                    f"Tick at least one fund to invest in for “{name}”, or set its target to 0.",
                    type="warning",
                )
                return None
            expanded = expand_category_weights(
                {name: weight},
                {name: selected},
                current_values,
                split=self.cat_split.get(name, "value"),
            )
            for mid, w in expanded.items():
                weights[mid] = weights.get(mid, ZERO) + w
        return weights, set()

    def _compute(self) -> None:
        built = self._build_weights()
        if built is None:
            return
        raw, no_buy = built
        target_pct = _scale_to_100(raw)
        if not target_pct:
            ui.notify("Targets must be positive", type="warning")
            return
        cash_raw = _decimal_or_zero(self.cash_in.value)
        source_ccy = self.display_ccy
        if cash_raw < ZERO or (cash_raw == ZERO and not self.allow_sell):
            ui.notify(
                "Enter a positive cash amount (or turn on rebalancing to sell only)",
                type="warning",
            )
            return
        cash_eur = self._to_eur(cash_raw, source_ccy)
        current_values = {i.instrument_id: i.current_value_eur for i in self.data.instruments}
        # In buy-only "by category" mode, credit funds the user holds but left
        # un-ticked toward their category's funding (see _held_unticked_extras).
        extra_no_buy, category_of = self._held_unticked_extras(target_pct, current_values)
        no_buy_ids = set(no_buy) | extra_no_buy
        current_prices = {
            mid: self.by_id[mid].price_eur
            for mid in target_pct
            if mid in self.by_id and self.by_id[mid].price_eur is not None
        }
        try:
            plan = plan_rebalance(
                cash_eur,
                target_pct,
                {mid: current_values.get(mid, ZERO) for mid in target_pct},
                current_prices,  # type: ignore[arg-type]
                allow_fractional_shares=bool(self.fractional.value),
                allow_sell=self.allow_sell,
                no_buy_ids=no_buy_ids & set(target_pct),
                category_of=category_of,
            )
        except ValueError as exc:
            ui.notify(f"Cannot rebalance: {exc}", type="negative")
            return
        self._render_result(plan, cash_raw, cash_eur, source_ccy)

    def _held_unticked_extras(
        self,
        target_pct: dict[int, Decimal],
        current_values: Mapping[int, Decimal],
    ) -> tuple[set[int], dict[int, str] | None]:
        """Fold funds the user holds but left un-ticked into a buy-only category
        plan, so an already well-funded category — counting those held funds —
        asks for no fresh cash even when the ticked fund alone looks
        under-weight.

        The held, un-ticked members of every *targeted* category are added to
        ``target_pct`` (mutated in place) as 0 %-target rows, returned in the
        ``no_buy`` set so they are never bought, and a ``{id: category}`` map is
        returned so :func:`plan_rebalance` measures each category's shortfall as
        a whole. Returns ``(set(), None)`` outside buy-only category mode, which
        leaves the legacy per-fund behaviour untouched.
        """
        if self.mode != "category" or self.allow_sell:
            return set(), None
        no_buy_ids: set[int] = set()
        for name, weight in self.cat_targets.items():
            if _decimal_or_zero(weight) <= ZERO:
                continue
            selected = self.cat_selected.get(name, set())
            for mid in self.cat_members.get(name, []):
                if mid in selected or mid in target_pct:
                    continue
                if current_values.get(mid, ZERO) <= ZERO:
                    continue
                target_pct.setdefault(mid, ZERO)
                no_buy_ids.add(mid)
        category_of = {
            mid: (self.by_id[mid].category if mid in self.by_id else UNCATEGORIZED)
            for mid in target_pct
        }
        return no_buy_ids, category_of

    # -- result ------------------------------------------------------------
    def _render_result(
        self,
        plan: RebalancePlan,
        cash_raw: Decimal,
        cash_eur: Decimal,
        source_ccy: str,
    ) -> None:
        self.result_box.clear()
        # Current weight of each fund in today's portfolio (before the plan).
        current_pct_by_id = {i.instrument_id: i.current_pct for i in self.data.instruments}
        with self.result_box:
            sym = currency_symbol(source_ccy)
            buys = sum((r.add_value for r in plan.rows if r.add_value > ZERO), start=ZERO)
            sells = sum((-r.add_value for r in plan.rows if r.add_value < ZERO), start=ZERO)
            with section("Plan summary"), ui.row().classes("w-full gap-md flex-wrap"):
                # Contribution as a share of existing wealth — context for how
                # small (or large) this round's cash is next to the whole
                # portfolio, so a modest top-up reads honestly rather than
                # looking like it moves everything.
                wealth_eur = self.data.total_value_eur
                pct_of_wealth = (cash_eur * HUNDRED / wealth_eur) if wealth_eur > ZERO else None
                invest_sub = f"{fmt_money(cash_eur, 'EUR')} internal"
                if pct_of_wealth is not None:
                    invest_sub += f" · {pct_of_wealth:.1f}% of wealth"
                kpi_card(
                    "Investing",
                    f"{sym}{cash_raw:,.2f}",
                    sub=invest_sub,
                )
                kpi_card(
                    "Buying",
                    self._fmt(buys),
                    sub=self._fmt_other(buys),
                )
                if sells > ZERO:
                    kpi_card(
                        "Selling",
                        self._fmt(sells),
                        sub=self._fmt_other(sells),
                    )
                kpi_card(
                    "Left over",
                    self._fmt(plan.residual_cash),
                    sub=self._fmt_other(plan.residual_cash),
                )
            heading = "Rebalance plan" if self.allow_sell else "Buy plan"
            with section(heading):
                total_after = sum((r.current_value + r.add_value for r in plan.rows), start=ZERO)
                if self.mode == "category":
                    # A "by category" plan reads best grouped into category
                    # buckets (target %, cash in, then the member funds) rather
                    # than as one flat fund list.
                    self._render_category_plan(plan, total_after, current_pct_by_id)
                else:
                    for r in sorted(plan.rows, key=lambda row: row.add_value, reverse=True):
                        instr = self.by_id.get(r.instrument_id)
                        sym_name = instr.symbol if instr else f"#{r.instrument_id}"
                        after_pct = (
                            (r.current_value + r.add_value) * HUNDRED / total_after
                            if total_after > ZERO
                            else ZERO
                        )
                        before_pct = (
                            r.current_value * HUNDRED / total_after if total_after > ZERO else ZERO
                        )
                        current_pct = current_pct_by_id.get(r.instrument_id, ZERO)
                        self._render_plan_row(
                            sym_name, r, current_pct, after_pct, before_pct=before_pct
                        )

    def _render_category_plan(
        self,
        plan: RebalancePlan,
        total_after: Decimal,
        current_pct_by_id: dict[int, Decimal],
    ) -> None:
        """Render the plan grouped by category: a header bucket per category with
        its rolled-up target / cash-in, followed by its member fund rows."""
        groups: dict[str, list[RebalanceRow]] = {}
        for r in plan.rows:
            instr = self.by_id.get(r.instrument_id)
            category = (instr.category if instr else None) or UNCATEGORIZED
            groups.setdefault(category, []).append(r)

        def _buy(rows: list[RebalanceRow]) -> Decimal:
            return sum((row.add_value for row in rows if row.add_value > ZERO), start=ZERO)

        def _after_pct(value: Decimal) -> Decimal:
            return value * HUNDRED / total_after if total_after > ZERO else ZERO

        # Most cash deployed first, mirroring the flat plan's "biggest move" sort.
        for category, rows in sorted(groups.items(), key=lambda kv: _buy(kv[1]), reverse=True):
            target_pct = sum((row.target_pct for row in rows), start=ZERO)
            current_pct = sum(
                (current_pct_by_id.get(row.instrument_id, ZERO) for row in rows), start=ZERO
            )
            before_value = sum((row.current_value for row in rows), start=ZERO)
            after_value = sum((row.current_value + row.add_value for row in rows), start=ZERO)
            add_value = sum((row.add_value for row in rows), start=ZERO)
            self._render_category_header(
                category,
                target_pct,
                current_pct,
                _after_pct(after_value),
                add_value,
                before_pct=_after_pct(before_value),
            )
            for r in sorted(rows, key=lambda row: row.add_value, reverse=True):
                instr = self.by_id.get(r.instrument_id)
                sym_name = instr.symbol if instr else f"#{r.instrument_id}"
                member_current = current_pct_by_id.get(r.instrument_id, ZERO)
                self._render_plan_row(
                    sym_name,
                    r,
                    member_current,
                    _after_pct(r.current_value + r.add_value),
                    indent=True,
                    before_pct=_after_pct(r.current_value),
                )

    def _render_category_header(
        self,
        name: str,
        target_pct: Decimal,
        current_pct: Decimal,
        after_pct: Decimal,
        add_value: Decimal,
        *,
        before_pct: Decimal | None = None,
    ) -> None:
        with (
            ui.row()
            .classes("items-center gap-md w-full no-wrap")
            .style(
                "padding:0.65rem 0.85rem;margin-top:1.25rem;border-radius:0.5rem;"
                "background:var(--inv-surface-2,#eef1f5)"
            )
        ):
            with ui.column().classes("gap-none").style("min-width:9rem"):
                ui.label(name).classes("text-subtitle1").style("font-weight:800")
                ui.html(
                    '<span class="text-caption opacity-70">'
                    f"now {current_pct:.1f} % → {after_pct:.1f} % after "
                    f"· target {target_pct:.1f} %</span>"
                )
            ui.html(_bar(after_pct, target_pct, added_from=before_pct)).classes("flex-1")
            with ui.column().classes("gap-none items-end").style("min-width:11rem"):
                if add_value > ZERO:
                    ui.html(
                        '<span class="inv-plan-amount" style="color:var(--inv-gain,#21ba45)">'
                        f"+ {self._fmt(add_value)}</span>"
                    )
                    ui.html(f'<span class="inv-plan-sub">+ {self._fmt_other(add_value)}</span>')
                elif add_value < ZERO:
                    ui.html(
                        '<span class="inv-plan-amount" style="color:var(--inv-loss,#c10015)">'
                        f"- {self._fmt(-add_value)} net</span>"
                    )
                else:
                    ui.html('<span class="text-caption opacity-50">no new cash</span>')

    def _render_plan_row(
        self,
        name: str,
        r: RebalanceRow,
        current_pct: Decimal,
        after_pct: Decimal,
        *,
        indent: bool = False,
        before_pct: Decimal | None = None,
    ) -> None:
        # Member rows under a category header are inset with a left rail and
        # rendered a notch smaller/quieter than the category header, so the
        # individual funds sit clearly *below* their category in the hierarchy.
        row_style = "padding:0.5rem 0.8rem"
        if indent:
            row_style = (
                "padding:0.28rem 0.8rem;margin-left:1.9rem;"
                "border-left:2px solid var(--inv-hairline,#e2e6eb)"
            )
        name_class = "text-caption opacity-80" if indent else "text-body1"
        label_min = "min-width:7rem" if indent else "min-width:8rem"
        value_min = "min-width:10rem" if indent else "min-width:11rem"
        amount_class = "inv-plan-amount inv-plan-amount--member" if indent else "inv-plan-amount"
        with ui.row().classes("items-center gap-md w-full no-wrap inv-section").style(row_style):
            with ui.column().classes("gap-none").style(label_min):
                ui.label(name).classes(name_class)
                ui.html(
                    '<span class="text-caption opacity-70">'
                    f"now {current_pct:.1f} % → {after_pct:.1f} % after "
                    f"· target {r.target_pct:.1f} %</span>"
                )
            ui.html(_bar(after_pct, r.target_pct, added_from=before_pct)).classes("flex-1")
            with ui.column().classes("gap-none items-end").style(value_min):
                if r.add_value > ZERO:
                    ui.html(
                        f'<span class="{amount_class}" '
                        'style="color:var(--inv-gain,#21ba45)">'
                        f"+ {self._fmt(r.add_value)}</span>"
                    )
                    ui.html(f'<span class="inv-plan-sub">+ {self._fmt_other(r.add_value)}</span>')
                    if r.add_shares > ZERO:
                        ui.html(
                            f'<span class="inv-plan-shares">{fmt_shares(r.add_shares)} shares</span>'
                        )
                elif r.add_value < ZERO:
                    sell_value = -r.add_value
                    ui.html(
                        f'<span class="{amount_class}" '
                        'style="color:var(--inv-loss,#c10015)">'
                        f"- {self._fmt(sell_value)} sell</span>"
                    )
                    ui.html(f'<span class="inv-plan-sub">- {self._fmt_other(sell_value)}</span>')
                    if r.add_shares < ZERO:
                        ui.html(
                            '<span class="inv-plan-shares">'
                            f"{fmt_shares(-r.add_shares)} shares</span>"
                        )
                elif r.no_buy:
                    ui.html('<span class="text-caption opacity-50">held · no new cash</span>')
                else:
                    ui.html('<span class="text-caption opacity-50">no buy</span>')

    # -- save --------------------------------------------------------------
    def _save_dialog(self) -> None:
        built = self._build_weights()
        if built is None:
            return
        raw, no_buy = built
        weights = _round_to_100(_scale_to_100(raw))
        if not weights:
            ui.notify("Nothing to save — set some targets first", type="warning")
            return
        # Only mark funds that survive into the saved weights as no-buy.
        saved_no_buy = no_buy & set(weights)
        held_note = f" · {len(saved_no_buy)} held (no new cash)" if saved_no_buy else ""
        with ui.dialog() as dialog, ui.card().classes("min-w-[22rem]"):
            ui.label("Save target allocation").classes("text-h6")
            name_in = ui.input("Name", value="My target").classes("w-full")
            activate_in = ui.checkbox("Activate (drive allocation-drift views)", value=True)
            ui.label(f"{len(weights)} funds · sums to 100 %{held_note}").classes(
                "text-caption opacity-70"
            )

            def _save() -> None:
                name = (name_in.value or "").strip()
                if not name:
                    ui.notify("Name is required", type="warning")
                    return
                try:
                    with session_scope() as session:
                        allocations_repo.create_allocation(
                            session,
                            name,
                            weights,
                            active=bool(activate_in.value),
                            no_buy_ids=saved_no_buy,
                            allow_sell=self.allow_sell,
                            display_currency=self.display_ccy,
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
