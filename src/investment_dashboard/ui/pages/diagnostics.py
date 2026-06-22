"""Data Health / Diagnostics page (``/diagnostics``) — audit task **H1**.

A single surface that converts the app's *silent* degradations into one
actionable view: FX-coverage gaps / incomplete transaction legs, instruments
with missing, stale or corrupt prices, holdings that value to nothing, and the
last outcome of each external data provider.

The page is read-only — it reuses :mod:`services.diagnostics_service`, which
never refreshes prices or writes to the database — so visiting it is always
safe and side-effect-free. Remedial actions live where they always have
(Settings → Data refresh / Instruments); this page only *names* the problems
and points at the fix.
"""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import diagnostics_service, runtime_status
from investment_dashboard.services.diagnostics_service import HealthItem, HealthReport
from investment_dashboard.services.support_bundle import build_support_bundle, bundle_filename
from investment_dashboard.ui.components import deferred, empty_state, page_header, section
from investment_dashboard.ui.layout import page_frame

PATH = "/diagnostics"

#: Per-severity icon + Quasar colour token, used by the page and the badge.
SEVERITY_ICON: dict[str, str] = {
    "ok": "check_circle",
    "warning": "warning",
    "error": "error",
}
SEVERITY_COLOR: dict[str, str] = {
    "ok": "positive",
    "warning": "warning",
    "error": "negative",
}


def _render_item(item: HealthItem) -> None:  # pragma: no cover - UI
    """One status row: severity icon, title, detail, and example chips."""
    with ui.element("div").classes("inv-section w-full"):
        with ui.row().classes("items-center gap-sm no-wrap w-full"):
            ui.icon(SEVERITY_ICON[item.severity], color=SEVERITY_COLOR[item.severity])
            ui.label(item.title).classes("text-subtitle2")
            if item.count:
                ui.badge(str(item.count)).props(f"color={SEVERITY_COLOR[item.severity]}")
        ui.label(item.detail).classes("text-body2 opacity-80 q-mt-xs")
        if item.examples:
            with ui.row().classes("items-center gap-xs wrap q-mt-xs"):
                for example in item.examples:
                    ui.html(f'<span class="inv-chip">{example}</span>')


def _render_report(report: HealthReport) -> None:  # pragma: no cover - UI
    problems = report.problems
    healthy = [i for i in report.items if i.ok]

    if not report.has_problems:
        empty_state(
            "verified",
            "All clear",
            hint=(
                "No data-health problems detected. Prices, FX rates and "
                "transaction legs are complete, and every data provider's last "
                "call succeeded."
            ),
        )

    if problems:
        with section(f"Needs attention ({len(problems)})"):
            for item in problems:
                _render_item(item)

    with section("All checks"):
        ui.label(
            "Every probe and its current status. Green means nothing to do.",
        ).classes("text-caption opacity-70 q-mb-sm")
        for item in (*problems, *healthy):
            _render_item(item)


async def _download_support_bundle() -> None:  # pragma: no cover - UI
    """Build the logs-plus-context bundle and offer it as a text download.

    The bundle reads the log file and queries app context, so it is built off
    the event loop (via :func:`nicegui.run.io_bound`) to keep the websocket
    responsive — a large log shouldn't stall every connected tab.
    """
    from nicegui import run  # noqa: PLC0415 - lazy (needs a NiceGUI context)

    content = await run.io_bound(build_support_bundle)
    ui.download.content(content, bundle_filename())
    ui.notify("Support bundle downloaded — attach it when reporting an issue.", type="positive")


def _render_background_errors() -> None:  # pragma: no cover - UI
    """List recent recorded errors (any source), if any.

    Fed by :mod:`services.runtime_status`, which now collects *every*
    warning/error: logged problems, uncaught exceptions on any thread, asyncio
    loop errors and stray ``stderr`` writes — not just the live/startup refresh.
    Showing them here keeps them visible now that the app has no console window.
    """
    errors = runtime_status.recent(limit=10)
    if not errors:
        return
    with section(f"Recent errors ({len(errors)})"):
        ui.label(
            "Problems the app recorded recently — background refresh failures, "
            "logged warnings/errors and uncaught exceptions. Most are best-effort, "
            "so the dashboard keeps working from cached data, but the underlying "
            "issue is worth a look.",
        ).classes("text-body2 opacity-80 q-mb-sm")
        for event in errors:
            with ui.element("div").classes("inv-section w-full"):
                with ui.row().classes("items-center gap-sm no-wrap w-full"):
                    ui.icon("error", color="negative")
                    ui.label(event.source).classes("text-subtitle2")
                    ui.label(event.at.strftime("%Y-%m-%d %H:%M UTC")).classes(
                        "text-caption opacity-60"
                    )
                ui.label(event.message).classes("text-body2 opacity-80 q-mt-xs")


def _render_support_section() -> None:  # pragma: no cover - UI
    """Surface a one-click "download logs to share" action."""
    with section("Report an issue"):
        ui.label(
            "Hit something slow or broken? Download a support bundle — it packages "
            "the recent log file plus your app version and (secret-free) settings "
            "into one text file you can share directly so the problem can be "
            "diagnosed from the actual logs.",
        ).classes("text-body2 opacity-80 q-mb-sm")
        ui.button(
            "Download support bundle",
            icon="download",
            on_click=_download_support_bundle,
        ).props("unelevated color=primary")


def render_body() -> None:  # pragma: no cover - UI
    """Render the page body (factored out so the route stays thin)."""
    page_header(
        "Data Health",
        subtitle="Silent data problems, surfaced in one place.",
    )
    ui.label(
        "This page never changes your data. Fix anything flagged from "
        "Settings → Data refresh (prices/FX) or Settings → Instruments (tickers).",
    ).classes("text-body2 opacity-70 q-mb-sm")
    # The health check scans the whole DB; run it off the event loop so a slow
    # scan never blocks the websocket (and the page paints its shell first).
    deferred(_render_health, compute=_check_health)


def _check_health() -> HealthReport:  # pragma: no cover - heavy DB scan, run off-loop
    with session_scope() as session:
        return diagnostics_service.check_health(session)


def _render_health(report: HealthReport) -> None:  # pragma: no cover - UI
    _render_report(report)
    _render_background_errors()
    _render_support_section()


def register() -> None:
    @ui.page(PATH)
    def _diagnostics() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Data Health", current=PATH):
            render_body()
