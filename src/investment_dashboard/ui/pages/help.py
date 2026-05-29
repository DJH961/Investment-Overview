"""In-app Help & user guide page (``/help``).

Deliberately *not* listed in the sidebar :data:`NAV_ITEMS` — it is "hidden
away but available": reachable from the small help icon in the header and
from the "Help & documentation" section at the bottom of Settings.

The content is plain-English how-to guidance for every page and, in
particular, every Settings control, mirroring ``docs/user_guide.md`` so the
same explanations exist both in-app and as a portable markdown file.
"""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.ui.components import page_header, section
from investment_dashboard.ui.layout import page_frame

PATH = "/help"


#: (title, body) rows describing what each main page is for.
_PAGE_GUIDE: tuple[tuple[str, str], ...] = (
    (
        "Overview",
        "Your portfolio at a glance: total value, total gain, growth and the "
        "headline return metrics (XIRR, TWR, CAGR). Hover the small ⓘ icon next "
        "to any number for a plain-English explanation of what it means.",
    ),
    (
        "Deposits",
        "Every contribution and withdrawal you have made. This is the cash you "
        "put in, separate from investment growth — the foundation the return "
        "metrics are calculated against.",
    ),
    (
        "Transactions",
        "The full ledger of buys, sells, dividends and fees imported from your "
        "brokers or entered by hand. This is the source of truth everything else "
        "is computed from.",
    ),
    (
        "Monthly / Yearly",
        "Performance broken down per calendar month or year, so you can see how "
        "each period contributed to the overall result.",
    ),
    (
        "Analytics",
        "Deeper risk and performance metrics (Sharpe, Sortino, drawdown, beta, "
        "alpha, allocation drift). Every metric has an ⓘ tooltip; the Settings → "
        "Analytics preferences control the benchmark and risk-free rate these "
        "use.",
    ),
    (
        "Calculator",
        "Project your portfolio forward. Start from your own historical return, "
        "then adjust the expected return, contribution step-up and inflation to "
        "model different futures.",
    ),
    (
        "Settings",
        "Where you change how the app behaves: display currency, analytics "
        "inputs, data refresh, storage and your accounts/instruments. See the "
        "section below for a control-by-control explanation.",
    ),
)


#: (title, body) rows explaining each Settings control in plain English.
_SETTINGS_GUIDE: tuple[tuple[str, str], ...] = (
    (
        "Display preferences — Primary display currency",
        "Switches every page between EUR and USD. It only changes how numbers "
        "are shown; it does not move money or alter your transactions. The "
        "choice is saved locally and survives restarts.",
    ),
    (
        "Analytics preferences — Benchmark symbol",
        "The market index your portfolio is compared against for Beta, Alpha and "
        "the comparison curve. The default is VT (Vanguard Total World). Type a "
        "ticker and press Save.",
    ),
    (
        "Analytics preferences — Risk-free symbol & Manual override",
        "The risk-free rate is used by Sharpe, Sortino and Alpha. By default it "
        "tracks the 13-week US T-bill yield (^IRX) fetched live. Use 'Refresh "
        "now' to update it, or set a Manual override (e.g. 0.04 = 4%) to pin it "
        "to a fixed value; clear the override to return to the live feed.",
    ),
    (
        "Storage",
        "Read-only view of where your three database files (ledger, config, "
        "cache) live, whether encryption is on, and whether any file is inside a "
        "cloud-sync folder. Nothing here is editable — it is for confirming your "
        "data is where you expect.",
    ),
    (
        "Data refresh",
        "'Refresh FX rates' pulls fresh EUR/USD rates; 'Refresh prices' pulls "
        "fresh market closes. The app also refreshes in the background, so use "
        "these only when you want the latest numbers immediately. 'Seed default "
        "setup' adds the bundled example accounts and instruments without "
        "touching anything you already have.",
    ),
    (
        "Connectivity",
        "Shows whether the last call to each data provider (yfinance for prices, "
        "Frankfurter for FX) succeeded. Green is good; expand 'Recent activity' "
        "to see the latest attempts if a refresh is not behaving.",
    ),
    (
        "Accounts",
        "Your brokerage and savings accounts. Use 'Add account' to create one "
        "and 'Edit' to rename it, change its type, or mark it inactive. Inactive "
        "accounts are kept for history but excluded from the live view.",
    ),
    (
        "Instruments",
        "The funds, ETFs and cash lines you hold. 'Add instrument' registers a "
        "new ticker; 'Edit' sets its name, category and expense ratio (e.g. "
        "0.0007 for 0.07%). Categories group instruments in allocation views.",
    ),
    (
        "Target allocations",
        "Your desired mix of instruments by percentage. Create one with 'New "
        "allocation' (weights must add up to 100%), then 'Activate' the one you "
        "want the drift metrics to compare against. Only one allocation is "
        "active at a time.",
    ),
)


#: (question, answer) FAQ / troubleshooting rows.
_FAQ: tuple[tuple[str, str], ...] = (
    (
        "A number looks wrong or out of date",
        "Open Settings → Data refresh and click 'Refresh prices' and 'Refresh "
        "FX rates'. Then check Settings → Connectivity to confirm the providers "
        "responded successfully.",
    ),
    (
        "I want to start over with example data",
        "Settings → Data refresh → 'Seed default setup' adds the bundled example "
        "accounts and instruments. It is safe to run: existing rows are skipped, "
        "only missing ones are added.",
    ),
    (
        "What is the difference between XIRR, TWR and CAGR?",
        "XIRR is your personal return accounting for when you deposited money; "
        "TWR ignores deposit timing and is best for comparing to an index; CAGR "
        "assumes a single lump sum at the start. Hover the ⓘ next to each on the "
        "Overview and Analytics pages for more.",
    ),
    (
        "Where is my data stored, and is it private?",
        "Everything stays in local SQLite files on your machine (see Settings → "
        "Storage for the exact paths). The app is single-user and local-first; "
        "nothing is uploaded unless you place the files in a cloud-sync folder "
        "yourself.",
    ),
)


def _render_intro() -> None:  # pragma: no cover - UI
    ui.label(
        "New here, or unsure what a setting does? This page explains every "
        "screen and every Settings control in plain English. Expand a section "
        "below to read more. The same content is available as a markdown user "
        "guide in the project's docs/user_guide.md file.",
    ).classes("text-body2 opacity-80")


def _render_rows(rows: tuple[tuple[str, str], ...]) -> None:  # pragma: no cover - UI
    with ui.column().classes("w-full gap-xs"):
        for title, body in rows:
            with ui.expansion(title).classes("w-full"):
                ui.label(body).classes("text-body2 opacity-80")


def _render_quickstart() -> None:  # pragma: no cover - UI
    steps = (
        "On first launch, choose 'Seed default setup' to load example accounts "
        "and instruments, or 'Start empty' to add your own.",
        "Import or add your transactions so the dashboard has data to work with.",
        "Open Settings → Display preferences and pick EUR or USD.",
        "Browse Overview and Analytics; hover any ⓘ icon to learn what a number means.",
        "Adjust Settings → Analytics preferences (benchmark and risk-free rate) "
        "to tune the risk metrics to your liking.",
    )
    with ui.column().classes("w-full gap-xs"):
        for i, step in enumerate(steps, start=1):
            with ui.row().classes("items-start gap-sm no-wrap w-full"):
                ui.badge(str(i)).props("color=primary")
                ui.label(step).classes("text-body2 opacity-80")


def register() -> None:
    @ui.page(PATH)
    def _help() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Help", current=PATH):
            page_header(
                "Help & user guide",
                subtitle="How to use the dashboard, and what every Settings control does.",
            )
            _render_intro()
            with section("Quick start"):
                _render_quickstart()
            with section("The pages"):
                ui.label(
                    "What each screen in the sidebar is for.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_rows(_PAGE_GUIDE)
            with section("Settings explained"):
                ui.label(
                    "Every control on the Settings page, top to bottom.",
                ).classes("text-caption opacity-70 q-mb-sm")
                _render_rows(_SETTINGS_GUIDE)
            with section("FAQ & troubleshooting"):
                _render_rows(_FAQ)
