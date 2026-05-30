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
from investment_dashboard.repositories import app_config_repo
from investment_dashboard.services.onboarding_service import (
    DEFAULT_ACCOUNTS,
    DEFAULT_INSTRUMENTS,
    InvalidTickerError,
    add_validated_instrument,
    is_onboarded,
    seed_default_setup,
)
from investment_dashboard.services.ticker_validation_service import validate_ticker
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


def _validated_ticker_card() -> None:  # pragma: no cover - UI
    """A validated path for adding a custom ticker during onboarding.

    The user types a symbol, **Validate** confirms it resolves to a real,
    priceable instrument on the market-data provider (showing the resolved
    name + last close so they can eyeball the match), and only then is
    **Add** enabled — so a typo or wrong-exchange suffix can't be seeded.
    """
    with ui.element("div").classes("inv-section min-w-[22rem] max-w-[28rem]"):
        ui.html('<div class="inv-section-title">Add your own ticker (validated)</div>')
        ui.label(
            "Hold something not in the defaults — e.g. the Global X DAX "
            "Germany ETF (ticker DAX)? Enter the symbol and validate it "
            "before it's added, so you don't seed an incorrect ticker.",
        ).classes("text-body2 opacity-80")

        symbol_input = ui.input("Ticker symbol", placeholder="DAX").props("dense").classes("w-full")
        category_input = (
            ui.input("Category (optional)", placeholder="DAX").props("dense").classes("w-full")
        )
        validate_button = (
            ui.button("Validate", icon="verified").props("flat no-caps").classes("q-mt-xs")
        )
        status = ui.label("").classes("text-caption q-mt-xs")
        add_button = ui.button("Add instrument", icon="add").props(
            "unelevated color=primary no-caps"
        )
        add_button.disable()

        state: dict[str, str | None] = {"validated_symbol": None}

        def _validate() -> None:
            result = validate_ticker(symbol_input.value or "")
            status.text = result.message
            status.classes(
                replace="text-caption q-mt-xs "
                + ("text-positive" if result.valid else "text-negative")
            )
            if result.valid:
                state["validated_symbol"] = result.symbol
                add_button.enable()
            else:
                state["validated_symbol"] = None
                add_button.disable()

        def _invalidate() -> None:
            # Any edit to the symbol forces a re-validation before adding.
            state["validated_symbol"] = None
            add_button.disable()

        def _add() -> None:
            symbol = symbol_input.value or ""
            normalize = symbol.strip().upper()
            if normalize and state["validated_symbol"] != normalize:
                ui.notify("Validate the ticker first.", type="warning")
                return
            try:
                with session_scope() as session:
                    result = add_validated_instrument(
                        session,
                        symbol,
                        category=(category_input.value or None),
                    )
            except InvalidTickerError as exc:
                ui.notify(str(exc), type="negative")
                return
            except Exception as exc:
                log.exception("Add validated instrument failed")
                ui.notify(f"Add failed: {exc}", type="negative")
                return
            ui.notify(f"Added {result.symbol} — {result.name or result.symbol}.", type="positive")
            symbol_input.value = ""
            category_input.value = ""
            status.text = ""
            _invalidate()

        symbol_input.on("blur", lambda _: _invalidate())
        validate_button.on("click", _validate)
        add_button.on("click", _add)


def _cloud_link_card() -> None:  # pragma: no cover - UI
    """Let the user choose where their data syncs, during first-run setup.

    The ledger + config tiers live under this folder (the cache always
    stays local). By default the app auto-detects a consumer-cloud folder
    (OneDrive, iCloud, Dropbox, Google Drive); here the user can override
    that with any folder they like — e.g. a different provider, or a plain
    local path if they don't want OneDrive. The choice is persisted into
    ``app_config`` so the resolver honours it on the next launch.
    """
    from pathlib import Path  # noqa: PLC0415

    from investment_dashboard.storage import resolve_storage_layout  # noqa: PLC0415
    from investment_dashboard.storage.cloud import detect_cloud_sync_root  # noqa: PLC0415

    with ui.element("div").classes("inv-section min-w-[22rem] max-w-[28rem]"):
        ui.html('<div class="inv-section-title">Choose your cloud / sync folder</div>')
        detected = detect_cloud_sync_root()
        if detected is not None:
            ui.label(
                f"Auto-detected {detected.provider} at {detected.root}. "
                "Leave the box blank to use it, or set a different folder "
                "below (e.g. another cloud provider or a local folder).",
            ).classes("text-body2 opacity-80")
        else:
            ui.label(
                "No cloud folder detected. Set a folder below to sync your "
                "ledger and config files, or leave blank to keep them local.",
            ).classes("text-body2 opacity-80")

        layout = resolve_storage_layout()
        current_folder = str(layout.ledger.path.parent) if layout.ledger.path is not None else ""
        folder_in = (
            ui.input("Sync folder", value=current_folder, placeholder="/path/to/cloud/folder")
            .props("dense outlined")
            .classes("w-full font-mono")
        )

        def _save() -> None:
            folder = (folder_in.value or "").strip()
            try:
                with session_scope() as session:
                    if not folder:
                        app_config_repo.set_value(session, "ledger_path", None)
                        app_config_repo.set_value(session, "config_path", None)
                    else:
                        base = Path(folder).expanduser()
                        app_config_repo.set_value(
                            session, "ledger_path", str(base / "ledger.sqlite")
                        )
                        app_config_repo.set_value(
                            session, "config_path", str(base / "config.sqlite")
                        )
            except Exception as exc:
                log.exception("Save sync folder failed")
                ui.notify(f"Could not save sync folder: {exc}", type="negative")
                return
            ui.notify(
                "Sync folder saved — restart the app for it to take effect.",
                type="positive",
            )

        ui.button("Save sync folder", icon="cloud_sync", on_click=_save).props(
            "unelevated color=primary no-caps"
        ).classes("q-mt-md")


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

                _validated_ticker_card()

                _cloud_link_card()
