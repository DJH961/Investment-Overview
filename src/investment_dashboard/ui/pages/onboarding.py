"""Onboarding page (v1.3) — first-run setup wizard.

Reached automatically when the database has no accounts yet (a fresh
clone, or after the user blows away ``db.sqlite``). The page offers two
paths:

1. **Seed default setup** — one-click insert of the Vanguard, Fidelity
   and Savings Bank accounts plus every instrument listed in the spec.
2. **Add manually** — links to ``/settings`` where free-form add forms
   live for users who want a non-default starting point.

After either flow the user is redirected to ``/overview``.
"""

from __future__ import annotations

import logging

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services.onboarding_service import (
    DEFAULT_ACCOUNTS,
    DEFAULT_INSTRUMENTS,
    is_onboarded,
    seed_default_setup,
)
from investment_dashboard.ui.components import page_header
from investment_dashboard.ui.layout import page_frame

PATH = "/onboarding"

log = logging.getLogger(__name__)


def _seed_clicked() -> None:  # pragma: no cover - UI
    try:
        with session_scope() as session:
            result = seed_default_setup(session)
    except Exception as exc:
        log.exception("Seed default setup failed")
        ui.notify(f"Seed failed: {exc}", type="negative")
        return
    ui.notify(
        f"Seeded {result.accounts_created} account(s) and "
        f"{result.instruments_created} instrument(s).",
        type="positive",
    )
    ui.navigate.to("/overview")


def register() -> None:
    @ui.page(PATH)
    def _onboarding() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Welcome", current=PATH):
            page_header(
                "Welcome to Investment Dashboard",
                subtitle="Looks like this is a fresh database. Pick a starting point "
                "below — you can change everything later from Settings.",
            )

            with session_scope() as session:
                already = is_onboarded(session)
            if already:
                ui.label(
                    "You already have accounts set up. Re-seeding is safe — "
                    "existing accounts and instruments are skipped, only "
                    "missing rows are inserted.",
                ).classes("text-caption opacity-70")

            with ui.row().classes("gap-md flex-wrap items-stretch q-mt-md"):
                with ui.element("div").classes("inv-section min-w-[22rem] max-w-[28rem]"):
                    ui.html('<div class="inv-section-title">Seed the default setup</div>')
                    ui.label(
                        "Creates Vanguard, Fidelity and Savings Bank "
                        "accounts plus every instrument the spec ships "
                        "with. Recommended unless you have a strong "
                        "reason to start empty.",
                    ).classes("text-body2 opacity-80")
                    ui.label("Accounts").classes("text-overline q-mt-sm")
                    for acc in DEFAULT_ACCOUNTS:
                        ui.label(
                            f"• {acc.broker} · {acc.account_label} "
                            f"({acc.native_currency}, {acc.account_type})",
                        ).classes("text-caption")
                    ui.label(
                        f"Instruments — {len(DEFAULT_INSTRUMENTS)} tickers "
                        "(VTI, VOO, FXAIX, SAVINGS_CASH, …)",
                    ).classes("text-caption q-mt-xs opacity-70")
                    ui.button(
                        "Seed default setup",
                        icon="auto_fix_high",
                        on_click=_seed_clicked,
                    ).props("unelevated color=primary no-caps").classes("q-mt-md")

                with ui.element("div").classes("inv-section min-w-[22rem] max-w-[28rem]"):
                    ui.html('<div class="inv-section-title">Start empty / add manually</div>')
                    ui.label(
                        "Go straight to Settings and add accounts, "
                        "instruments and a target allocation by hand.",
                    ).classes("text-body2 opacity-80")
                    ui.button(
                        "Open Settings",
                        icon="settings",
                        on_click=lambda: ui.navigate.to("/settings"),
                    ).props("unelevated color=primary no-caps").classes("q-mt-md")
                    ui.button(
                        "Skip — go to Overview",
                        on_click=lambda: ui.navigate.to("/overview"),
                    ).props("flat no-caps").classes("q-mt-xs")
