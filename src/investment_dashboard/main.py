"""NiceGUI entry point: boot the app and register all pages."""

from __future__ import annotations

import logging

from nicegui import ui

from investment_dashboard import __version__
from investment_dashboard.boot import run_boot_sequence
from investment_dashboard.config import get_settings
from investment_dashboard.logging import configure_logging
from investment_dashboard.ui.pages import (
    calculator,
    deposits,
    monthly,
    overview,
    transactions,
    yearly,
)
from investment_dashboard.ui.pages import (
    settings as settings_page,
)

log = logging.getLogger(__name__)


def _register_pages() -> None:
    """Register every page module with NiceGUI."""
    overview.register()
    deposits.register()
    transactions.register()
    monthly.register()
    yearly.register()
    calculator.register()
    settings_page.register()

    @ui.page("/")
    def _root() -> None:  # pragma: no cover - simple redirect
        ui.navigate.to(overview.PATH)


def run() -> None:
    configure_logging()
    settings = get_settings()
    log.info(
        "Starting Investment Dashboard %s on %s:%s",
        __version__,
        settings.host,
        settings.port,
    )
    run_boot_sequence()
    _register_pages()
    ui.run(
        host=settings.host,
        port=settings.port,
        title="Investment Dashboard",
        reload=False,
        show=False,
    )


if __name__ in {"__main__", "__mp_main__"}:
    run()
