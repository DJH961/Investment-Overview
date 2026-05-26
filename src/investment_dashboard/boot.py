"""Boot sequence — runs once per app start before NiceGUI listens.

Steps (spec §13):
1. Apply Alembic migrations (idempotent).
2. Register the colorblind Plotly template.
3. Best-effort FX refresh.
4. Best-effort market-price refresh for tracked instruments.

Steps 3 and 4 are best-effort: they log a warning if the network is
unavailable and let the app start anyway, so the UI is usable offline.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from pathlib import Path

from investment_dashboard.config import get_settings
from investment_dashboard.ui.theme import register_plotly_template

log = logging.getLogger(__name__)

#: Window of days to backfill on every boot for FX/prices. We keep this
#: short because the heavy lifting happens on first ingest; subsequent
#: boots only need to catch up the gap since last run.
_BOOT_BACKFILL_DAYS = 14


def _run_migrations() -> None:
    """Run ``alembic upgrade head`` programmatically."""
    try:
        from alembic import command  # noqa: PLC0415
        from alembic.config import Config  # noqa: PLC0415
    except ImportError:
        log.warning("alembic not installed; skipping migrations")
        return

    # Locate alembic.ini at the repo root (three levels up from this file).
    pkg_root = Path(__file__).resolve().parent
    candidates = [
        pkg_root.parent.parent.parent / "alembic.ini",  # editable install
        Path.cwd() / "alembic.ini",
    ]
    ini_path = next((p for p in candidates if p.exists()), None)
    if ini_path is None:
        log.warning("alembic.ini not found; skipping migrations")
        return

    cfg = Config(str(ini_path))
    settings = get_settings()
    cfg.set_main_option("sqlalchemy.url", settings.db_url)
    command.upgrade(cfg, "head")
    log.info("Alembic upgrade head applied")


def _refresh_fx() -> None:
    try:
        from investment_dashboard.db import session_scope  # noqa: PLC0415
        from investment_dashboard.services.fx_service import refresh_fx_history  # noqa: PLC0415

        earliest = date.today() - timedelta(days=_BOOT_BACKFILL_DAYS)
        with session_scope() as session:
            refresh_fx_history(session, earliest_needed=earliest)
        log.info("FX rates refreshed")
    except Exception:
        log.warning("FX refresh failed; continuing with cached rates", exc_info=True)


def _refresh_prices() -> None:
    try:
        from investment_dashboard.db import session_scope  # noqa: PLC0415
        from investment_dashboard.services.prices_service import refresh_prices  # noqa: PLC0415

        earliest = date.today() - timedelta(days=_BOOT_BACKFILL_DAYS)
        with session_scope() as session:
            refresh_prices(session, earliest_needed=earliest)
        log.info("Prices refreshed")
    except Exception:
        log.warning("Price refresh failed; continuing with cached prices", exc_info=True)


def run_boot_sequence(*, skip_network: bool = False) -> None:
    """Run all startup steps.

    Args:
        skip_network: if ``True``, skip FX/price refresh (useful for tests
            and offline development).
    """
    _run_migrations()
    register_plotly_template()
    if skip_network:
        log.info("skip_network=True — not refreshing FX or prices")
        return
    _refresh_fx()
    _refresh_prices()
