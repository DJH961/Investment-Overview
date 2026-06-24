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
from collections.abc import Callable
from datetime import date, timedelta
from pathlib import Path
from typing import Any

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


def holds_writer_lock() -> bool:
    """True when this instance currently owns the single-writer lock."""
    return _boot_state["held_lock"] is not None


def release_writer_lock() -> bool:
    """Release the writer lock held by this instance, if any. Idempotent.

    After a successful release the instance is flipped to *read-only* so it
    stops writing to the (now unlocked) shared database — another instance
    can immediately acquire the lock and take over writes. Returns ``True``
    only if a lock was actually released, so callers can give accurate
    feedback ("handed off" vs "nothing to release").

    Safe to call from a NiceGUI ``app.on_shutdown`` hook or a UI button.
    """
    lock = _boot_state["held_lock"]
    _boot_state["held_lock"] = None
    if lock is None:
        return False
    try:
        lock.release()  # type: ignore[attr-defined]
    except Exception:  # pragma: no cover - defensive; release already suppresses
        log.warning("failed to release writer lock cleanly", exc_info=True)
        return False
    _boot_state["read_only"] = True
    log.info("writer lock released; instance is now read-only")
    return True


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


def _integrity_marker_path() -> Path | None:
    """Path of the per-install daily integrity-check marker, or ``None``.

    Lives next to the ledger (falling back to the config tier). Returns
    ``None`` for in-memory / unset layouts so tests always run the check.
    """
    settings = get_settings()
    for path in (settings.ledger_path, settings.config_path):
        if path is not None and path.as_posix() != ":memory:":
            return path.parent / ".integrity_check"
    return None


def _integrity_check_due(marker: Path | None, *, today: date | None = None) -> bool:
    """Whether the daily integrity check should run for ``today``.

    The whole-database ``PRAGMA integrity_check`` is expensive and ran on every
    cold start; gating it to once per calendar day keeps the safety net without
    paying the scan on every relaunch. ``None`` marker (in-memory layout) is
    always due.
    """
    if marker is None:
        return True
    today = today or date.today()
    try:
        return marker.read_text(encoding="utf-8").strip() != today.isoformat()
    except OSError:
        return True


def _record_integrity_check(marker: Path | None, *, today: date | None = None) -> None:
    """Stamp the marker so the integrity check is skipped until tomorrow."""
    if marker is None:
        return
    today = today or date.today()
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(today.isoformat(), encoding="utf-8")
    except OSError:  # pragma: no cover - best-effort, never block boot
        log.warning("could not write integrity-check marker %s", marker, exc_info=True)


def _integrity_check_tiers() -> None:
    import sqlite3  # noqa: PLC0415

    from investment_dashboard.db import get_active_encryption  # noqa: PLC0415
    from investment_dashboard.storage.integrity import (  # noqa: PLC0415
        IntegrityCheckFailed,
        integrity_check,
    )

    # When another instance owns the writer lock this process runs in
    # read-only mode (e.g. a second instance pointed at the same
    # OneDrive-synced ledger). The active writer is responsible for
    # validating integrity; opening the cloud-synced file here only races
    # the writer/sync client and surfaces as a fatal
    # ``sqlite3.OperationalError: disk I/O error``. Skip the check.
    if is_read_only():
        log.info("read-only mode; skipping integrity check (writer owns validation)")
        return

    # Run the whole-database scan at most once per calendar day rather than on
    # every cold start — it is a heavyweight synchronous step on the path
    # before the UI opens.
    marker = _integrity_marker_path()
    if not _integrity_check_due(marker):
        log.info("integrity check already ran today; skipping (daily cadence)")
        return

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
        except sqlite3.OperationalError:
            # A transient access error (e.g. a OneDrive "disk I/O error"
            # while the cloud client touches the file) is *not* corruption.
            # Don't crash boot over it — log and let the app start.
            log.warning(
                "integrity check could not run for %s at %s; continuing",
                label,
                path,
                exc_info=True,
            )
    # Only stamp once every tier validated cleanly (a raised
    # ``IntegrityCheckFailed`` above never reaches here, so a corrupt DB is
    # re-checked on the next launch).
    _record_integrity_check(marker)


def _rolling_backup() -> None:
    from investment_dashboard.db import get_active_encryption  # noqa: PLC0415
    from investment_dashboard.storage.backup import snapshot  # noqa: PLC0415

    # A read-only secondary instance must not write backups of a ledger
    # owned by the active writer; reading the concurrently-written,
    # cloud-synced file would also risk a "disk I/O error".
    if is_read_only():
        log.info("read-only mode; skipping rolling backup (writer owns backups)")
        return

    settings = get_settings()
    encryption = get_active_encryption()
    # The backup is a full decrypt+re-encrypt copy through SQLCipher and runs
    # synchronously on the cold-start path. Skip it when a backup was already
    # taken within the last hour so frequent relaunches don't repeatedly pay
    # that cost; the rolling retention/cadence is unaffected.
    min_interval = timedelta(hours=1)
    for label, path in (
        ("ledger", settings.ledger_path),
        ("config", settings.config_path),
    ):
        if path is None or path.as_posix() == ":memory:":
            continue
        try:
            out = snapshot(path, encryption=encryption, min_interval=min_interval)
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
    # In read-only mode another instance owns the writer lock and has
    # already migrated the shared (cloud-synced) database. Running Alembic
    # or ``create_all`` here would attempt to write the locked file and
    # crash with a "disk I/O error"; the writer keeps the schema current.
    if is_read_only():
        log.info("read-only mode; skipping migrations (writer owns schema)")
        return
    if not _run_alembic_upgrade():
        _ensure_schema_present()
    else:
        # Alembic only migrates the ledger tier (see ``_run_alembic_upgrade``).
        # In a split-DB layout the config and cache databases are *separate*
        # files that Alembic never touched, so their tables would never be
        # created — leaving the background FX/price refresh writing into a
        # schemaless cache DB (every write silently fails) and every read
        # resolving to 0. Create the secondary tiers' schema directly;
        # ``create_all`` is idempotent and a no-op in single-file mode.
        _ensure_secondary_tier_schema()
    # Reconcile the pure-cache ``intraday_value`` table on every writable boot,
    # regardless of which path above ran: its v3.9.3 column rename
    # (``total_value_eur`` → ``market_value_eur``) is applied by neither
    # ``create_all`` (which never renames an existing table, so a split-DB /
    # packaged cache file keeps the legacy column and every Overview "1 Day"
    # query fails with ``no such column: intraday_value.market_value_eur``) nor a
    # single-file Alembic ``head`` for the ``fx_eur_usd`` rate column (migration
    # 0014 recreates the table without it). See
    # :func:`_ensure_intraday_value_schema`.
    _reconcile_intraday_value_schema()


def _load_alembic_config() -> tuple[Any, Any] | None:
    """Return ``(alembic.command, Config)`` or ``None`` when unavailable.

    Centralises the "is Alembic importable and is ``alembic.ini`` on disk?"
    probe shared by the ledger upgrade and the per-tier version-table
    stamping, so both degrade identically in the packaged bundle.
    """
    try:
        from alembic import command  # noqa: PLC0415
        from alembic.config import Config  # noqa: PLC0415
    except ImportError:
        log.warning("alembic not installed; will create schema directly")
        return None

    # Locate alembic.ini at the repo root (three levels up from this file).
    pkg_root = Path(__file__).resolve().parent
    candidates = [
        pkg_root.parent.parent.parent / "alembic.ini",  # editable install
        Path.cwd() / "alembic.ini",
    ]
    ini_path = next((p for p in candidates if p.exists()), None)
    if ini_path is None:
        log.warning("alembic.ini not found; will create schema directly")
        return None
    return command, Config(str(ini_path))


def _run_alembic_upgrade() -> bool:
    """Run ``alembic upgrade head``. Returns ``True`` only if it actually ran.

    Returns ``False`` (without raising) when Alembic is not importable or
    when ``alembic.ini`` cannot be located — the two situations that occur
    in the packaged installer/portable bundle, where the caller falls back
    to :func:`_ensure_schema_present`.
    """
    loaded = _load_alembic_config()
    if loaded is None:
        return False
    command, cfg = loaded

    settings = get_settings()
    settings.ledger_path.parent.mkdir(parents=True, exist_ok=True)  # type: ignore[union-attr]
    cfg.set_main_option("sqlalchemy.url", settings.ledger_url)
    # Tell env.py this upgrade is driven by the app (not the CLI) so it leaves
    # logging alone — the app already configured logging, and Alembic's
    # ``fileConfig`` would otherwise dump migration INFO lines onto stderr where
    # they surface as bogus "Recent errors" in Data Health.
    cfg.attributes["embedded"] = True
    command.upgrade(cfg, "head")
    log.info("Alembic upgrade head applied")
    return True


def _stamp_secondary_tiers() -> None:
    """Stamp the config + cache databases with their own ``alembic_version``.

    Alembic's migration scripts describe the *ledger* metadata, so we must
    not run them against the secondary tiers (that would try to create
    ledger tables there). Instead, after their schema is materialised by
    ``create_all``, we ``alembic stamp head`` each tier so every storage
    database carries its own version table pinned to the current head —
    giving each tier an independent migration baseline for the future.
    Best-effort: a stamping failure must never block boot, since the schema
    itself is already present.
    """
    settings = get_settings()
    if not settings.is_split_db:
        return
    loaded = _load_alembic_config()
    if loaded is None:
        return
    command, cfg = loaded
    for tier, url in (("config", settings.config_url), ("cache", settings.cache_url)):
        try:
            cfg.set_main_option("sqlalchemy.url", url)
            command.stamp(cfg, "head")
            log.info("Alembic stamped %s tier to head", tier)
        except Exception:  # pragma: no cover - defensive: schema already exists
            log.warning("could not stamp %s tier alembic_version", tier, exc_info=True)


def _ensure_secondary_tier_schema() -> None:
    """Create the config + cache tier schema after an Alembic (ledger) upgrade.

    Alembic runs against the ledger URL only (per-tier version tables are a
    Phase 2 follow-up), so in a split-DB layout the config and cache databases
    are never migrated. ``create_all`` is idempotent — it only emits
    ``CREATE TABLE`` for missing tables — so this is a safe no-op in single-file
    mode (where every tier already shares the ledger DB that Alembic just
    migrated) and only does real work when the tiers live in separate files.
    """
    settings = get_settings()
    if not settings.is_split_db:
        return
    from investment_dashboard.db import (  # noqa: PLC0415
        get_cache_engine,
        get_config_engine,
    )
    from investment_dashboard.models.base import (  # noqa: PLC0415
        CacheBase,
        ConfigBase,
    )

    ConfigBase.metadata.create_all(get_config_engine())
    CacheBase.metadata.create_all(get_cache_engine())
    # Alembic migrated the ledger tier only; add post-creation columns the
    # config + cache tiers gained later (v3.5.3 target settings, v3.6.3 price
    # market time) to their separate split-DB files. No-op in single-file mode.
    _ensure_added_columns(get_config_engine())
    _ensure_added_columns(get_cache_engine())
    log.info("split-DB: ensured config + cache tier schema after Alembic upgrade")
    # Give each secondary tier its own alembic_version baseline.
    _stamp_secondary_tiers()


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
        ALL_METADATAS,
        CacheBase,
        ConfigBase,
    )

    ledger_engine = get_ledger_engine()
    # Mirror Alembic migration 0001, which builds the *entire* schema (every
    # tier's tables) on the ledger URL. The back-compat ``session_scope`` is a
    # ledger-tier session, and config-tier reads such as ``app_config`` (the
    # benchmark symbol, display currency, persisted storage paths) still run on
    # it — so the ledger DB must carry those tables too. Creating only
    # ``LedgerBase`` here left a split-DB packaged install (the portable bundle,
    # which ships no Alembic) with an ``app_config``-less ledger DB, so the very
    # first page render crashed with ``no such table: app_config``. ``create_all``
    # is idempotent, so this stays a safe no-op once the schema exists.
    for metadata in ALL_METADATAS:
        metadata.create_all(ledger_engine)
    # In split-DB mode the config and cache tiers live in their own files; give
    # them their schema too (a no-op in single-file mode where the engines alias
    # the ledger DB just populated above).
    ConfigBase.metadata.create_all(get_config_engine())
    CacheBase.metadata.create_all(get_cache_engine())
    _ensure_added_columns(ledger_engine)
    # The ``target_allocation*`` columns added in v3.5.3 live in the config
    # tier; in split-DB mode that's a separate file the ledger guard never
    # touches. Run the guard against the config engine too (a harmless repeat in
    # single-file mode where it aliases the ledger DB).
    _ensure_added_columns(get_config_engine())
    # ``price_cache_metadata.price_market_time`` (v3.6.3) lives in the cache
    # tier — a third separate file in split-DB mode — so guard that engine too.
    _ensure_added_columns(get_cache_engine())
    log.info("Database schema ensured via create_all (Alembic migrations unavailable)")


#: Columns added to existing tables after their initial ``CREATE TABLE``.
#: ``create_all`` only emits ``CREATE TABLE`` for *missing* tables — it never
#: ``ALTER``s an existing one — so packaged installs (which have no Alembic)
#: would otherwise never gain a newly added column and every ORM query that
#: selects it would fail. Each entry is ``(table, column, DDL type)`` and is
#: applied idempotently (skipped when the column already exists).
_ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("transactions", "net_usd", "NUMERIC(18, 6)"),
    ("target_allocations", "allow_sell", "BOOLEAN NOT NULL DEFAULT 0"),
    ("target_allocations", "display_currency", "VARCHAR(3)"),
    ("target_allocation_items", "no_buy", "BOOLEAN NOT NULL DEFAULT 0"),
    ("price_cache_metadata", "price_market_time", "DATETIME"),
    ("intraday_value", "fx_eur_usd", "NUMERIC(12, 8)"),
)


def _ensure_added_columns(engine: object) -> None:
    """Idempotently add post-creation columns missing from existing tables.

    Mirrors what Alembic migration 0006 does, for the packaged-install path
    where Alembic isn't available. Safe to run on every boot: each column is
    only added when ``PRAGMA table_info`` shows it absent.
    """
    from sqlalchemy import text  # noqa: PLC0415
    from sqlalchemy.engine import Engine  # noqa: PLC0415

    if not isinstance(engine, Engine):  # pragma: no cover - defensive
        return
    try:
        with engine.begin() as conn:
            for table, column, ddl_type in _ADDED_COLUMNS:
                existing = {
                    row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
                }
                if not existing:
                    # Table doesn't exist yet (fresh DB handled by create_all
                    # of the current model, which already includes the column).
                    continue
                if column in existing:
                    continue
                conn.execute(text(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {ddl_type}'))
                log.info("Added missing column %s.%s via create_all guard", table, column)
    except Exception:  # pragma: no cover - defensive
        log.warning("Could not ensure added columns; continuing", exc_info=True)


def _reconcile_intraday_value_schema() -> None:
    """Reconcile the cache-tier ``intraday_value`` table across every backing DB.

    Runs the per-engine reconcile (:func:`_ensure_intraday_value_schema`) on both
    the ledger and cache engines so the fix lands wherever the cache table
    physically lives: the same file as the ledger in single-file mode, or a
    separate cache database in a split-DB layout. The two engines alias the same
    file in single-file mode, so the second call is a cheap no-op.
    """
    from investment_dashboard.db import (  # noqa: PLC0415
        get_cache_engine,
        get_ledger_engine,
    )

    seen: set[int] = set()
    for getter in (get_ledger_engine, get_cache_engine):
        try:
            engine = getter()
        except Exception:  # pragma: no cover - defensive: never block boot
            log.warning("Could not resolve engine for intraday_value reconcile", exc_info=True)
            continue
        if id(engine) in seen:
            continue
        seen.add(id(engine))
        _ensure_intraday_value_schema(engine)


def _ensure_intraday_value_schema(engine: object) -> None:
    """Bring an existing ``intraday_value`` table up to the current schema.

    The table is **pure cache** (regenerable, pruned to the current session), so
    a legacy copy is simply dropped and recreated on the current schema rather
    than migrated in place. Handles the two schema changes that the plain
    ``create_all`` / Alembic-head paths miss:

    * the v3.9.3 rename ``total_value_eur`` → ``market_value_eur`` —
      ``create_all`` never alters an existing table, so a split-DB / packaged
      cache file keeps the old column and every read fails with
      ``no such column: intraday_value.market_value_eur``; and
    * the per-sample ``fx_eur_usd`` rate column — a single-file Alembic ``head``
      recreates the table without it (migration 0014), so it must be added.

    Idempotent and best-effort: a current table is left untouched and any failure
    is logged and swallowed so boot never blocks on it.
    """
    from sqlalchemy import text  # noqa: PLC0415
    from sqlalchemy.engine import Engine  # noqa: PLC0415

    from investment_dashboard.models import IntradayValue  # noqa: PLC0415

    if not isinstance(engine, Engine):  # pragma: no cover - defensive
        return
    try:
        with engine.begin() as conn:
            cols = {
                row[1]
                for row in conn.exec_driver_sql("PRAGMA table_info(intraday_value)").fetchall()
            }
            if cols and "market_value_eur" not in cols:
                # Legacy v3.5.4 schema (``total_value_eur``): drop so the table is
                # rebuilt below on the current schema. Pure cache, safe to drop —
                # stale totals would otherwise be misread as market components.
                conn.execute(text("DROP TABLE intraday_value"))
                cols = set()
                log.info("Dropped legacy intraday_value cache table (pre-market_value_eur rename)")
            elif cols and "fx_eur_usd" not in cols:
                # Rename already applied but the per-sample FX rate column is
                # absent (single-file Alembic head recreates the table without it).
                conn.execute(
                    text('ALTER TABLE "intraday_value" ADD COLUMN "fx_eur_usd" NUMERIC(12, 8)')
                )
                log.info("Added missing column intraday_value.fx_eur_usd via cache reconcile")
        # Rebuild a freshly-dropped (or never-created) table from the model so it
        # carries the full current schema; a no-op when the table already exists.
        IntradayValue.__table__.create(engine, checkfirst=True)
    except Exception:  # pragma: no cover - defensive: never block boot
        log.warning("Could not reconcile intraday_value schema; continuing", exc_info=True)


def _backfill_transaction_legs() -> None:
    """Freeze any missing trade-date EUR/USD legs on the ledger.

    Runs after the FX refresh so newly fetched rates can fill rows that were
    written during an earlier FX-history gap. Cheap on a healthy ledger
    (``force=False`` only touches rows missing a leg). Best-effort: failures
    are logged and swallowed so boot never blocks on it.
    """
    try:
        from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
        from investment_dashboard.services.transaction_fx_service import (  # noqa: PLC0415
            backfill_missing_legs,
        )

        with ledger_session_scope() as session:
            result = backfill_missing_legs(session)
        if result.updated or result.incomplete:
            log.info(
                "Transaction legs backfill: %d updated, %d still incomplete",
                result.updated,
                result.incomplete,
            )
    except Exception:  # pragma: no cover - defensive
        log.warning("Transaction-legs backfill failed; continuing", exc_info=True)


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
        from investment_dashboard.services.fx_service import (  # noqa: PLC0415
            purge_legacy_yfinance_fx_history,
            refresh_fx_history,
        )

        earliest = _earliest_needed_date()
        with cache_session_scope() as session:
            # Retire any legacy yfinance end-of-day overlay rows so the ECB
            # reference rates below own the historical end-of-day marks again.
            purge_legacy_yfinance_fx_history(session)
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


def _refresh_live_fx() -> None:
    """Warm the live EUR/USD spot so the FX-aware "today" figures start live.

    Best-effort and keyless (yfinance ``EURUSD=X``): a failure just leaves the
    ECB daily rate in place. Kept separate from :func:`_refresh_fx` (which
    persists the ECB history) because the live spot is in-memory only.
    """
    try:
        from investment_dashboard.services.fx_service import refresh_live_spot  # noqa: PLC0415

        rate = refresh_live_spot()
        if rate is not None:
            log.info("Live EUR/USD spot refreshed (%s)", rate)
    except Exception:
        log.warning("Live EUR/USD refresh failed; using ECB daily rate", exc_info=True)


def _refresh_splits() -> None:
    try:
        from investment_dashboard.db import (  # noqa: PLC0415
            cache_session_scope,
            ledger_session_scope,
        )
        from investment_dashboard.services.prices_service import refresh_splits  # noqa: PLC0415

        earliest = _earliest_needed_date()
        with ledger_session_scope() as ledger, cache_session_scope() as cache:
            refresh_splits(ledger, cache, earliest_needed=earliest)
        log.info("Stock splits refreshed (floor=%s)", earliest)
    except Exception:
        log.warning("Split refresh failed; continuing with cached splits", exc_info=True)


def _refresh_benchmark() -> None:
    """Backfill the comparison-benchmark close history over the portfolio
    lifetime so the analytics overlay and the "vs market" verdict have a full
    curve to compare against (not just the trailing few days)."""
    try:
        from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
        from investment_dashboard.services import benchmark_service  # noqa: PLC0415

        start = _earliest_needed_date()
        with ledger_session_scope() as session:
            rows = benchmark_service.refresh_history(session, start=start)
        log.info("Benchmark history refreshed (floor=%s, rows=%d)", start, rows)
    except Exception:
        log.warning("Benchmark refresh failed; continuing with cached benchmark", exc_info=True)


def _invalidate_snapshots() -> None:
    """Deprecated no-op kept for backwards compatibility.

    Earlier versions dropped **every** cached daily snapshot here (a blunt
    ``invalidate_all``) before warming the cache back up. That left the snapshot
    cache completely empty on *every* startup until the warm finished, so a user
    who opened the daily-granularity ``/yearly`` chart during that window forced
    a synchronous full-history recompute onto the request thread — seconds of
    blocked event loop that tripped NiceGUI's socket-reconnect window and made
    the app appear to crash. The Monthly page only touches a handful of
    month-boundary snapshots, so it stayed under the reconnect threshold and
    looked fine.

    :func:`_warm_snapshots` now rebuilds the cache *in place* (force-recompute,
    overwriting stale values without deleting them first), so there is no longer
    an empty-cache window to guard against and nothing for this step to do.
    """
    return


def _warm_snapshots() -> None:
    """Rebuild the daily snapshot cache over the portfolio lifetime, in place.

    Once the deferred FX/price backfill lands, historical closing values that
    were cached against an empty/partial price + FX cache (e.g. the ``0``
    closing values a pre-backfill render persisted) are stale and must be
    recomputed. Rather than delete every snapshot and recompute from an empty
    cache — which briefly forces a full-history page like ``/yearly`` to rebuild
    its whole daily equity curve on the request thread — this force-rebuilds
    each day and *overwrites* the cached row in place. Readers keep seeing the
    previous (still-valid) value until the fresh one is written, so the heavy
    work stays on this background thread and the UI never blocks.

    Best-effort: a failure just leaves the lazy read-through path to recompute
    on demand.
    """
    try:
        from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
        from investment_dashboard.services.snapshots_service import warm_range  # noqa: PLC0415

        start = _earliest_needed_date()
        with ledger_session_scope() as session:
            warmed = warm_range(session, start, date.today(), force=True)
        log.info("Rebuilt %d daily snapshot(s) in place (floor=%s)", warmed, start)
    except Exception:
        log.warning("Snapshot warming failed; continuing", exc_info=True)


def _apply_persisted_log_level() -> None:
    """Apply the user's persisted logging verbosity, if any (best-effort)."""
    try:
        from investment_dashboard.services.logging_service import (  # noqa: PLC0415
            apply_persisted_log_level,
        )

        apply_persisted_log_level()
    except Exception:  # pragma: no cover - defensive: never block boot on this
        log.debug("could not apply persisted log level", exc_info=True)


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
    _apply_persisted_log_level()
    register_plotly_template()
    _run_cache_janitor()
    if skip_network:
        log.info("skip_network=True — not refreshing FX or prices")
        return
    _refresh_fx()
    _backfill_transaction_legs()
    _refresh_prices()
    _refresh_live_fx()
    _refresh_splits()
    _refresh_benchmark()
    # Rebuild the snapshot cache in place (no delete-all window — see
    # _warm_snapshots) so a full-history page like /yearly never cold-recomputes
    # its daily curve on the request thread.
    _warm_snapshots()


def run_deferred_network_refresh() -> None:
    """Best-effort FX + price refresh meant to run *after* the server starts.

    Pulling fresh FX rates and market prices is the slowest part of boot and
    needs the network, which previously blocked the browser from opening: the
    user stared at the console while the refresh ran. ``main.run`` now runs the
    fast, offline portion of the boot sequence synchronously, opens the UI
    immediately, and calls this helper on a background daemon thread. The page
    renders straight away from cached data and quietly updates once the refresh
    lands (the periodic live-refresh timer keeps it current thereafter).

    Each stage reports its progress to
    :mod:`investment_dashboard.services.refresh_status`, so the UI can paint a
    small determinate "downloading history…" bar — the same historic re-pull runs
    after a cache reset and when re-opening the app after a long absence, and in
    every case the user can see it working rather than wondering if anything is.

    Like the in-sequence refresh it is best-effort: every failure is logged and
    swallowed so an offline machine still gets a working dashboard.
    """
    import time as _time  # noqa: PLC0415

    from investment_dashboard.services import refresh_status  # noqa: PLC0415

    # Ordered stages of the full historic re-download. The labels are what the
    # progress bar shows as each one runs; keep them short and user-legible.
    steps: tuple[tuple[str, Callable[[], None]], ...] = (
        ("Exchange rates", _refresh_fx),
        ("Transaction history", _backfill_transaction_legs),
        ("Prices", _refresh_prices),
        ("Live FX", _refresh_live_fx),
        ("Stock splits", _refresh_splits),
        ("Benchmark", _refresh_benchmark),
        ("Daily snapshots", _warm_snapshots),
    )
    total = len(steps)

    started = _time.monotonic()
    log.info("deferred network refresh: starting (FX, prices, splits, benchmark, snapshots)")
    for index, (label, step) in enumerate(steps):
        # Announce the stage *before* running it so the bar names what is being
        # downloaded right now; advance the completed count after it returns.
        refresh_status.set_progress(index, total, label)
        step()
        refresh_status.set_progress(index + 1, total, label)
    log.info(
        "deferred network refresh: complete in %.1fs",
        _time.monotonic() - started,
    )


def run_full_history_refresh(source: str) -> bool:
    """Run the full historic re-download, wrapped in the activity + error cues.

    Shared by the startup deferred refresh and the post-cache-reset re-pull so
    both animate the header chip and the bottom-corner historic-download progress
    bar (via :mod:`investment_dashboard.services.refresh_status`) and surface any
    failure on the runtime-error strip. Returns ``True`` when the sequence ran to
    completion. Never raises — a failure is logged, recorded and swallowed.
    """
    from investment_dashboard.services import refresh_status, runtime_status  # noqa: PLC0415

    refresh_status.begin(source)
    ok = False
    try:
        run_deferred_network_refresh()
        ok = True
        runtime_status.resolve(source)
    except Exception as exc:
        log.warning("%s failed", source, exc_info=True, extra={"runtime_status_skip": True})
        runtime_status.record_error(source, f"{type(exc).__name__}: {exc}")
    finally:
        refresh_status.finish(source, updated=ok)
    return ok


def start_full_history_refresh(source: str) -> None:
    """Kick off :func:`run_full_history_refresh` on a daemon thread (non-blocking).

    Used by the Settings "Reset cached market data" action so the wiped price /
    FX / snapshot history is re-downloaded straight away — visibly, via the
    progress bar — instead of waiting for the next app restart.
    """
    import threading  # noqa: PLC0415

    threading.Thread(
        target=lambda: run_full_history_refresh(source),
        name="inv-dashboard-history-refresh",
        daemon=True,
    ).start()
