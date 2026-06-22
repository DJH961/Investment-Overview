"""NiceGUI entry point: boot the app and register all pages."""

from __future__ import annotations

import logging
import threading

from nicegui import app, ui

from investment_dashboard import __version__
from investment_dashboard.boot import run_boot_sequence, run_deferred_network_refresh
from investment_dashboard.config import get_settings
from investment_dashboard.logging import configure_logging
from investment_dashboard.ui import connectivity
from investment_dashboard.ui import style as ui_style
from investment_dashboard.ui.pages import (
    analytics,
    calculator,
    deposits,
    diagnostics,
    holdings,
    monthly,
    onboarding,
    overview,
    projection,
    transactions,
    yearly,
)
from investment_dashboard.ui.pages import (
    help as help_page,
)
from investment_dashboard.ui.pages import (
    settings as settings_page,
)

log = logging.getLogger(__name__)

#: Fallback background refresh cadence (seconds), used only when the persisted
#: value can't be read. The live cadence is now user-editable in Settings —
#: see :mod:`investment_dashboard.services.auto_refresh`. Each tick only hits
#: the network for instruments whose per-asset-class TTL has expired
#: (``services.prices_service.REFRESH_TTL_SECONDS``), so it stays cheap.
_LIVE_REFRESH_INTERVAL_SECONDS = 60.0

#: Handle to the live-refresh ``app.timer`` (boxed in a dict so Settings can
#: re-arm its cadence at runtime without a module-level ``global``). NiceGUI
#: timers expose a bindable ``interval``.
_live_refresh_timer: dict[str, object] = {"timer": None}


def set_live_refresh_interval(seconds: float) -> None:
    """Update the running live-refresh timer's cadence (called from Settings)."""
    timer = _live_refresh_timer["timer"]
    if timer is not None:
        timer.interval = seconds  # type: ignore[attr-defined]


def _register_pages() -> None:
    """Register every page module with NiceGUI."""
    ui_style.install()
    # Inject the live connection + navigation feedback layer (top progress bar,
    # immediate "connection lost" banner, header status dot) on every page.
    connectivity.install()
    overview.register()
    holdings.register()
    deposits.register()
    transactions.register()
    monthly.register()
    yearly.register()
    projection.register()
    analytics.register()
    calculator.register()
    diagnostics.register()
    settings_page.register()
    onboarding.register()
    help_page.register()

    @ui.page("/")
    def _root() -> None:  # pragma: no cover - simple redirect
        ui.navigate.to(overview.PATH)


def _live_refresh_tick() -> None:  # pragma: no cover - background loop
    """Refresh due-by-TTL prices once (delegates to the shared runner)."""
    from investment_dashboard.services import auto_refresh  # noqa: PLC0415

    auto_refresh.tick_refresh("Live price refresh")


def _run_deferred_network_refresh_guarded() -> None:  # pragma: no cover - thread body
    """Run the deferred refresh, recording any unexpected failure for the UI."""
    from investment_dashboard.services import refresh_status  # noqa: PLC0415

    refresh_status.begin("Startup data refresh")
    updated = False
    try:
        run_deferred_network_refresh()
        updated = True
    except Exception as exc:
        log.warning(
            "deferred startup refresh failed", exc_info=True, extra={"runtime_status_skip": True}
        )
        from investment_dashboard.services import runtime_status  # noqa: PLC0415

        runtime_status.record_error("Startup data refresh", f"{type(exc).__name__}: {exc}")
    finally:
        refresh_status.finish("Startup data refresh", updated=updated)


def _start_deferred_network_refresh() -> None:
    """Kick off the best-effort FX/price refresh on a background daemon thread.

    Keeping the network work off the startup path lets ``ui.run(show=True)``
    open the browser immediately instead of leaving the user waiting at the
    console while rates and prices download. The thread is a daemon so it
    never keeps the process alive on shutdown.
    """
    thread = threading.Thread(
        target=_run_deferred_network_refresh_guarded,
        name="inv-dashboard-startup-refresh",
        daemon=True,
    )
    thread.start()


def _resolve_auto_shutdown() -> bool:
    """Initial auto-shutdown-on-tab-close preference for this boot.

    The persisted ``auto_shutdown_on_tab_close`` app-config key (toggled from
    Settings) wins; absent that we fall back to the ``shutdown_on_tab_close``
    setting / ``INV_DASHBOARD_SHUTDOWN_ON_TAB_CLOSE`` env default.
    """
    try:
        from investment_dashboard.db import session_scope  # noqa: PLC0415
        from investment_dashboard.repositories import app_config_repo  # noqa: PLC0415

        with session_scope() as session:
            raw = app_config_repo.get(session, "auto_shutdown_on_tab_close")
    except Exception:  # pragma: no cover - defensive (read-only / fresh DB)
        raw = None
    if raw is not None:
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    return get_settings().shutdown_on_tab_close


def run() -> None:
    configure_logging()
    # Catch failures that never reach logging (uncaught exceptions on any
    # thread, asyncio loop errors, stray stderr writes) and surface them in-app
    # too. Installed after configure_logging so the stderr tee doesn't capture
    # normal log output. The asyncio handler needs a running loop, so it's
    # attached from an app.on_startup hook below.
    from investment_dashboard.services import error_reporting  # noqa: PLC0415

    error_reporting.install()
    app.on_startup(error_reporting.install_asyncio_handler)
    # Safety net: warn (in-app + log) when a long synchronous calculation blocks
    # the event loop, instead of letting the resulting websocket stall silently
    # disconnect every tab. The durable fix is to keep heavy work off the loop
    # (see ui.components.deferred's compute hook); this makes a freeze visible.
    from investment_dashboard.services import loop_watchdog  # noqa: PLC0415

    loop_watchdog.install()
    settings = get_settings()
    log.info(
        "Starting Investment Dashboard %s on %s:%s",
        __version__,
        settings.host,
        settings.port,
    )
    # Run only the fast, offline portion of boot synchronously so the UI is
    # served right away; the slow network refresh happens in the background.
    run_boot_sequence(skip_network=True)
    _register_pages()
    if settings.api_enabled:
        from nicegui import app as _fastapi_app  # noqa: PLC0415

        from investment_dashboard.api import mount_api  # noqa: PLC0415

        mount_api(_fastapi_app)
        log.info("JSON API mounted at /api (token auth %s)", "on" if settings.api_token else "off")
    # Register clean-shutdown handlers so the single-writer lock is always
    # released when the server stops, and optionally auto-stop when the last
    # browser tab closes (see :mod:`investment_dashboard.shutdown`).
    from investment_dashboard import shutdown as _shutdown  # noqa: PLC0415

    _shutdown.install(auto_shutdown=_resolve_auto_shutdown())
    _start_deferred_network_refresh()
    # Use ``app.timer`` (not ``ui.timer``) so the background refresh is a
    # client-independent, server-side timer. ``ui.timer`` would create a UI
    # element on the auto-index page in the global scope, which NiceGUI rejects
    # alongside ``@ui.page`` routes ("ui.page cannot be used ... in the global
    # scope"). The cadence is user-editable (Settings → auto-update interval);
    # the handle lets Settings re-arm it live via ``set_live_refresh_interval``.
    interval = float(_LIVE_REFRESH_INTERVAL_SECONDS)
    try:
        from investment_dashboard.db import session_scope  # noqa: PLC0415
        from investment_dashboard.services import auto_refresh  # noqa: PLC0415

        with session_scope() as session:
            interval = float(auto_refresh.get_interval_seconds(session))
    except Exception:  # pragma: no cover - defensive: fall back to the default
        log.debug("could not read auto-update interval; using default", exc_info=True)
    _live_refresh_timer["timer"] = app.timer(interval, _live_refresh_tick)
    ui.run(
        host=settings.host,
        port=settings.port,
        title="Investment Dashboard",
        reload=False,
        show=True,
        # The local server occasionally stalls briefly (a heavy metrics build,
        # a slow disk/cloud-synced DB read). The default 3s reconnect window is
        # short enough that such a stall discards the client and forces a full
        # reload — which is exactly the "I seemingly disconnect and get stuck"
        # symptom. A longer window lets the existing tab ride out the stall and
        # resume with its state intact.
        reconnect_timeout=10.0,
    )


if __name__ in {"__main__", "__mp_main__"}:
    run()
