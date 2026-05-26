"""NiceGUI entry point — smoke page for Phase 0/1."""

from __future__ import annotations

import logging

from nicegui import ui

from investment_dashboard import __version__
from investment_dashboard.config import get_settings
from investment_dashboard.logging import configure_logging

log = logging.getLogger(__name__)


@ui.page("/")
def index() -> None:
    with ui.column().classes("w-full items-center q-pa-lg"):
        ui.label("Investment Dashboard").classes("text-h3")
        ui.label(f"v{__version__} — scaffolding ready").classes("text-subtitle1")
        ui.separator()
        ui.label(
            "This page is a placeholder. The Overview / Deposits / Transactions / "
            "Monthly / Yearly / Calculator / Settings pages will land in the next phases."
        ).classes("text-body1")


def run() -> None:
    configure_logging()
    settings = get_settings()
    log.info("Starting Investment Dashboard %s on %s:%s", __version__, settings.host, settings.port)
    ui.run(
        host=settings.host,
        port=settings.port,
        title="Investment Dashboard",
        reload=False,
        show=False,
    )


if __name__ in {"__main__", "__mp_main__"}:
    run()
