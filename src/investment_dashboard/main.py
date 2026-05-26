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
    onboarding,
    overview,
    transactions,
    yearly,
)
from investment_dashboard.ui.pages import (
    settings as settings_page,
)

log = logging.getLogger(__name__)

#: Background refresh cadence (seconds). Each tick only hits yfinance for
#: instruments whose per-asset-class TTL has expired (see
#: ``services.prices_service.REFRESH_TTL_SECONDS``), so this can be aggressive
#: without spamming the network.
_LIVE_REFRESH_INTERVAL_SECONDS = 60.0


def _register_pages() -> None:
    """Register every page module with NiceGUI."""
    overview.register()
    deposits.register()
    transactions.register()
    monthly.register()
    yearly.register()
    calculator.register()
    settings_page.register()
    onboarding.register()

    @ui.page("/")
    def _root() -> None:  # pragma: no cover - simple redirect
        ui.navigate.to(overview.PATH)


def _live_refresh_tick() -> None:  # pragma: no cover - background loop
    """Refresh due-by-TTL prices once. Logs and swallows any error."""
    try:
        from investment_dashboard.db import session_scope  # noqa: PLC0415
        from investment_dashboard.services.prices_service import (  # noqa: PLC0415
            refresh_due_prices,
        )

        with session_scope() as session:
            refreshed = refresh_due_prices(session)
        if refreshed:
            log.debug("live refresh updated %s", list(refreshed.keys()))
    except Exception:
        log.warning("live price refresh tick failed", exc_info=True)


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
    ui.timer(_LIVE_REFRESH_INTERVAL_SECONDS, _live_refresh_tick)
    ui.run(
        host=settings.host,
        port=settings.port,
        title="Investment Dashboard",
        reload=False,
        show=True,
    )


if __name__ in {"__main__", "__mp_main__"}:
    run()
