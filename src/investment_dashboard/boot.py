"""Boot sequence — runs once per app start before NiceGUI listens.

Steps (spec §13 + v2.0 plan phases 3-5):
1. Resolve encryption (Phase 4): if the user enabled it, fetch the
   passphrase from the OS keychain (or env override) and wire it onto
   the engine factory. Boot fails fast with a clear message when the
   SQLCipher driver is missing.
2. Resolve the cloud-aware storage layout and persist it onto
   ``Settings`` so engines created later see the right paths.
3. Refuse to open if stray ``-wal`` / ``-shm`` sidecars sit next to a
   cloud-located file (Phase 5).
4. Acquire the single-writer file lock (Phase 5). On failure boot
   continues in read-only mode.
5. Integrity-check ledger and config tiers (Phase 5).
6. Take an on-boot rolling backup of ledger + config (Phase 5).
7. Apply Alembic migrations (idempotent).
8. Register the colorblind Plotly template.
9. Cache-orphan janitor.
10. Best-effort FX refresh.
11. Best-effort market-price refresh for tracked instruments.

Steps 10/11 are best-effort: they log a warning if the network is
unavailable and let the app start anyway, so the UI is usable offline.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from pathlib import Path

from investment_dashboard.config import get_settings
from investment_dashboard.ui.theme import register_plotly_template

log = logging.getLogger(__name__)

#: Maximum window of days we'll *catch up* on every boot when no
#: transactions yet exist. Once the ledger has data, the actual backfill
#: floor is the earliest transaction date so the per-trade-date FX
#: history is dense enough for the FX-aware Modified-Dietz growth on
#: ``/monthly`` and ``/yearly`` to actually differ between EUR and USD.
_BOOT_BACKFILL_DAYS = 14


def _earliest_needed_date() -> date:
    """Return the floor date FX / price refresh must cover on this boot.

    For a populated ledger this is the date of the earliest transaction
    (so per-trade-date FX lookups in
    :mod:`investment_dashboard.ui.pages._period_query` find a rate
    instead of falling back to the EUR ledger value, which silently
    collapses USD growth onto EUR growth — the v2.3 bug). For an empty
    ledger we keep the legacy 14-day window so first-boot doesn't fan
    out an open-ended fetch.
    """
    try:
        from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
        from investment_dashboard.repositories.transactions_repo import (  # noqa: PLC0415
            earliest_transaction_date,
        )

        with ledger_session_scope() as session:
            earliest = earliest_transaction_date(session)
    except Exception:  # pragma: no cover - defensive
        earliest = None
    fallback = date.today() - timedelta(days=_BOOT_BACKFILL_DAYS)
    if earliest is None:
        return fallback
    return min(earliest, fallback)


#: Set to ``True`` by ``_acquire_writer_lock`` when the lock was held by
#: another process; UI code can consult :func:`is_read_only` to suppress
#: write buttons.
_boot_state: dict[str, object] = {"read_only": False, "held_lock": None}


def is_read_only() -> bool:
    """True when this boot lost the writer-lock race."""
    return bool(_boot_state["read_only"])


def _load_persisted_overrides() -> dict[str, str]:
    """Read ``ledger_path`` / ``config_path`` from the config tier.

    The lookup tolerates a missing/uninitialised config DB (first
    boot, or a freshly split layout).
    """
    try:
        from sqlalchemy import text  # noqa: PLC0415

        from investment_dashboard.config import get_settings as _gs  # noqa: PLC0415
        from investment_dashboard.db import make_engine  # noqa: PLC0415

        settings = _gs()
        config_url = settings.config_url
        eng = make_engine(config_url)
        with eng.connect() as conn:
            row = conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table' AND name='app_config'")
            ).fetchone()
            if row is None:
                return {}
            res = conn.execute(text("SELECT key, value FROM app_config")).fetchall()
        eng.dispose()
        return {k: v for k, v in res if v and k in {"ledger_path", "config_path"}}
    except Exception:
        log.debug("could not read persisted path overrides", exc_info=True)
        return {}


def _apply_resolved_layout() -> None:
    """Resolve cloud-aware paths and stamp them on the active Settings."""
    settings = get_settings()
    # When the legacy single-file env var is set we keep the existing
    # behaviour (all three tiers point at the same file) so existing
    # installs continue to work unchanged.
    import os  # noqa: PLC0415

    if os.environ.get("INV_DASHBOARD_DB_PATH"):
        return
    persisted = _load_persisted_overrides()
    layout = settings.storage_layout(config_overrides=persisted)
    object.__setattr__(settings, "ledger_path", layout.ledger.path)
    object.__setattr__(settings, "config_path", layout.config.path)
    object.__setattr__(settings, "cache_path", layout.cache.path)
    log.info(
        "storage layout: ledger=%s (%s), config=%s (%s), cache=%s (%s)",
        layout.ledger.path,
        layout.ledger.source.value,
        layout.config.path,
        layout.config.source.value,
        layout.cache.path,
        layout.cache.source.value,
    )


def _apply_encryption() -> None:
    from investment_dashboard.db import set_active_encryption  # noqa: PLC0415
    from investment_dashboard.storage.encryption import resolve_encryption  # noqa: PLC0415

    settings = get_settings()
    cfg = resolve_encryption(
        encrypt_synced_tiers=settings.encrypt_synced_tiers,
        env_passphrase=settings.db_passphrase,
    )
    set_active_encryption(cfg)
    if cfg.enabled:
        log.info("encryption enabled (driver=%s)", cfg.driver)


def _check_sidecars() -> None:
    from investment_dashboard.storage.sidecar import assert_no_sidecars_in_cloud  # noqa: PLC0415

    settings = get_settings()
    paths = [settings.ledger_path, settings.config_path]
    paths = [p for p in paths if p is not None and p.as_posix() != ":memory:"]
    assert_no_sidecars_in_cloud(paths)


def _acquire_writer_lock() -> None:
    from investment_dashboard.storage.lock import (  # noqa: PLC0415
        WriteLockError,
        acquire_write_lock,
    )

    settings = get_settings()
    ledger = settings.ledger_path
    if ledger is None or ledger.as_posix() == ":memory:":
        return
    try:
        _boot_state["held_lock"] = acquire_write_lock(ledger)
    except WriteLockError:
        log.warning("writer lock held by another instance; continuing in read-only mode")
        _boot_state["read_only"] = True


def _integrity_check_tiers() -> None:
    from investment_dashboard.db import get_active_encryption  # noqa: PLC0415
    from investment_dashboard.storage.integrity import (  # noqa: PLC0415
        IntegrityCheckFailed,
        integrity_check,
    )

    settings = get_settings()
    encryption = get_active_encryption()
    for label, path in (
        ("ledger", settings.ledger_path),
        ("config", settings.config_path),
    ):
        if path is None or path.as_posix() == ":memory:":
            continue
        try:
            result = integrity_check(path, encryption=encryption)
            if result == "missing":
                continue
            log.info("integrity check passed for %s (%s)", label, path)
        except IntegrityCheckFailed:
            log.error("integrity check FAILED for %s at %s", label, path, exc_info=True)
            raise


def _rolling_backup() -> None:
    from investment_dashboard.db import get_active_encryption  # noqa: PLC0415
    from investment_dashboard.storage.backup import snapshot  # noqa: PLC0415

    settings = get_settings()
    encryption = get_active_encryption()
    for label, path in (
        ("ledger", settings.ledger_path),
        ("config", settings.config_path),
    ):
        if path is None or path.as_posix() == ":memory:":
            continue
        try:
            out = snapshot(path, encryption=encryption)
            if out is not None:
                log.info("backup written: %s -> %s", label, out)
        except Exception:
            log.warning("backup failed for %s", label, exc_info=True)


def _run_migrations() -> None:
    """Bring the database schema up to date.

    In a development / editable checkout ``alembic.ini`` and the
    ``migrations/`` tree sit next to the package, so we run
    ``alembic upgrade head`` for a faithful, incremental migration.

    The packaged Windows installer and the portable bundle ship **only**
    the ``investment_dashboard`` wheel — ``alembic.ini`` and the migration
    scripts are not part of the wheel. In that case there is nothing for
    Alembic to run, which historically left a freshly installed app with
    an empty database: every page then failed with ``no such table``. To
    make the release usable start-to-finish we fall back to creating the
    current schema directly with ``create_all`` across every storage tier.
    ``create_all`` only creates missing tables, so it is a safe no-op once
    Alembic has built the schema in a dev checkout.
    """
    if not _run_alembic_upgrade():
        _ensure_schema_present()


def _run_alembic_upgrade() -> bool:
    """Run ``alembic upgrade head``. Returns ``True`` only if it actually ran.

    Returns ``False`` (without raising) when Alembic is not importable or
    when ``alembic.ini`` cannot be located — the two situations that occur
    in the packaged installer/portable bundle, where the caller falls back
    to :func:`_ensure_schema_present`.
    """
    try:
        from alembic import command  # noqa: PLC0415
        from alembic.config import Config  # noqa: PLC0415
    except ImportError:
        log.warning("alembic not installed; will create schema directly")
        return False

    # Locate alembic.ini at the repo root (three levels up from this file).
    pkg_root = Path(__file__).resolve().parent
    candidates = [
        pkg_root.parent.parent.parent / "alembic.ini",  # editable install
        Path.cwd() / "alembic.ini",
    ]
    ini_path = next((p for p in candidates if p.exists()), None)
    if ini_path is None:
        log.warning("alembic.ini not found; will create schema directly")
        return False

    cfg = Config(str(ini_path))
    settings = get_settings()
    if settings.is_split_db:
        log.info(
            "split-DB mode: running migrations against ledger only "
            "(per-tier Alembic version tables are a Phase 2 follow-up)"
        )
    settings.ledger_path.parent.mkdir(parents=True, exist_ok=True)  # type: ignore[union-attr]
    cfg.set_main_option("sqlalchemy.url", settings.ledger_url)
    command.upgrade(cfg, "head")
    log.info("Alembic upgrade head applied")
    return True


def _ensure_schema_present() -> None:
    """Create the current ORM schema directly, one storage tier at a time.

    Used when Alembic migrations are unavailable (the packaged installer /
    portable bundle). ``create_all`` is idempotent — it only emits
    ``CREATE TABLE`` for tables that do not yet exist — so a partially
    populated database keeps its data while gaining any missing tables.
    """
    from investment_dashboard.db import (  # noqa: PLC0415
        get_cache_engine,
        get_config_engine,
        get_ledger_engine,
    )
    from investment_dashboard.models.base import (  # noqa: PLC0415
        CacheBase,
        ConfigBase,
        LedgerBase,
    )

    LedgerBase.metadata.create_all(get_ledger_engine())
    ConfigBase.metadata.create_all(get_config_engine())
    CacheBase.metadata.create_all(get_cache_engine())
    log.info("Database schema ensured via create_all (Alembic migrations unavailable)")


def _run_cache_janitor() -> None:
    """Drop cache rows whose instrument is gone from the ledger."""
    try:
        from investment_dashboard.db import (  # noqa: PLC0415
            cache_session_scope,
            ledger_session_scope,
        )
        from investment_dashboard.services.cache_janitor import (  # noqa: PLC0415
            cleanup_orphan_cache_rows,
        )

        with ledger_session_scope() as ledger, cache_session_scope() as cache:
            cleanup_orphan_cache_rows(ledger, cache)
    except Exception:
        log.warning("cache-orphan janitor failed; continuing", exc_info=True)


def _refresh_fx() -> None:
    try:
        from investment_dashboard.db import cache_session_scope  # noqa: PLC0415
        from investment_dashboard.services.fx_service import refresh_fx_history  # noqa: PLC0415

        earliest = _earliest_needed_date()
        with cache_session_scope() as session:
            refresh_fx_history(session, earliest_needed=earliest)
        log.info("FX rates refreshed (floor=%s)", earliest)
    except Exception:
        log.warning("FX refresh failed; continuing with cached rates", exc_info=True)


def _refresh_prices() -> None:
    try:
        from investment_dashboard.db import (  # noqa: PLC0415
            cache_session_scope,
            ledger_session_scope,
        )
        from investment_dashboard.services.prices_service import refresh_prices  # noqa: PLC0415

        earliest = _earliest_needed_date()
        with ledger_session_scope() as ledger, cache_session_scope() as cache:
            refresh_prices(ledger, cache, earliest_needed=earliest)
        log.info("Prices refreshed (floor=%s)", earliest)
    except Exception:
        log.warning("Price refresh failed; continuing with cached prices", exc_info=True)


def run_boot_sequence(*, skip_network: bool = False) -> None:
    """Run all startup steps.

    Args:
        skip_network: if ``True``, skip FX/price refresh (useful for tests
            and offline development). :func:`main.run` passes ``True`` and
            instead runs :func:`run_deferred_network_refresh` on a
            background thread so the UI opens immediately.
    """
    _apply_encryption()
    _apply_resolved_layout()
    _check_sidecars()
    _acquire_writer_lock()
    _integrity_check_tiers()
    _rolling_backup()
    _run_migrations()
    register_plotly_template()
    _run_cache_janitor()
    if skip_network:
        log.info("skip_network=True — not refreshing FX or prices")
        return
    _refresh_fx()
    _refresh_prices()


def run_deferred_network_refresh() -> None:
    """Best-effort FX + price refresh meant to run *after* the server starts.

    Pulling fresh FX rates and market prices is the slowest part of boot and
    needs the network, which previously blocked the browser from opening: the
    user stared at the console while the refresh ran. ``main.run`` now runs the
    fast, offline portion of the boot sequence synchronously, opens the UI
    immediately, and calls this helper on a background daemon thread. The page
    renders straight away from cached data and quietly updates once the refresh
    lands (the periodic live-refresh timer keeps it current thereafter).

    Like the in-sequence refresh it is best-effort: every failure is logged and
    swallowed so an offline machine still gets a working dashboard.
    """
    _refresh_fx()
    _refresh_prices()
