"""Boot-sequence tests — verify skip_network short-circuit + nav coverage."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import suppress
from pathlib import Path

import pytest
import sqlalchemy as sa

from investment_dashboard import boot
from investment_dashboard.boot import run_boot_sequence


def _release_held_writer_lock() -> None:
    """Close and forget the writer-lock handle stored in the boot global.

    ``run_boot_sequence`` stashes the acquired lock in a module-global; if it
    is not released the ``<ledger>.lock`` file handle leaks until garbage
    collection, surfacing as a ``ResourceWarning``.
    """
    lock = boot._boot_state.get("held_lock")
    if lock is not None:
        with suppress(Exception):
            lock.release()  # type: ignore[attr-defined]
    boot._boot_state["held_lock"] = None


@pytest.fixture(autouse=True)
def _release_boot_writer_lock() -> Iterator[None]:
    """Release any writer lock a boot test acquired, and reset boot state.

    We reset the handle directly rather than calling ``release_writer_lock``,
    which would flip the global to read-only and leak that state into the
    next test.
    """
    yield
    _release_held_writer_lock()
    boot._boot_state["read_only"] = False


def test_skip_network_does_not_raise() -> None:
    """Calling boot in offline mode must not raise even with no DB seeded."""
    run_boot_sequence(skip_network=True)


def test_integrity_check_cadence_gates_to_one_run_per_day(tmp_path: Path) -> None:
    """The daily integrity-check marker suppresses repeat runs on the same day."""
    from datetime import date

    from investment_dashboard.boot import (
        _integrity_check_due,
        _record_integrity_check,
    )

    marker = tmp_path / ".integrity_check"
    today = date(2026, 6, 21)
    # No marker yet → due.
    assert _integrity_check_due(marker, today=today) is True
    _record_integrity_check(marker, today=today)
    # Same day → not due.
    assert _integrity_check_due(marker, today=today) is False
    # Next day → due again.
    assert _integrity_check_due(marker, today=date(2026, 6, 22)) is True


def test_integrity_check_due_when_marker_is_none() -> None:
    """In-memory layouts (no marker path) always run the check."""
    from investment_dashboard.boot import _integrity_check_due

    assert _integrity_check_due(None) is True


def test_boot_creates_db_parent_for_migrations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fresh double-click startup should create the app data folder."""
    from investment_dashboard.config import get_settings

    db_path = tmp_path / "nested" / "fresh.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    get_settings.cache_clear()
    try:
        run_boot_sequence(skip_network=True)
    finally:
        get_settings.cache_clear()

    assert db_path.exists()


def test_boot_migrates_active_ledger_path_in_split_layout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fresh split-path startup must create ledger tables in the ledger DB."""
    from investment_dashboard.config import get_settings
    from investment_dashboard.db import dispose_engines

    ledger_path = tmp_path / "ledger.sqlite"
    monkeypatch.delenv("INV_DASHBOARD_DB_PATH", raising=False)
    monkeypatch.setenv("INV_DASHBOARD_LEDGER_PATH", str(ledger_path))
    monkeypatch.setenv("INV_DASHBOARD_CONFIG_PATH", str(tmp_path / "config.sqlite"))
    monkeypatch.setenv("INV_DASHBOARD_CACHE_PATH", str(tmp_path / "cache.sqlite"))
    get_settings.cache_clear()
    dispose_engines()
    try:
        run_boot_sequence(skip_network=True)
    finally:
        dispose_engines()
        get_settings.cache_clear()

    engine = sa.create_engine(f"sqlite:///{ledger_path.as_posix()}", future=True)
    try:
        with engine.connect() as conn:
            tables = {
                row[0]
                for row in conn.execute(
                    sa.text("SELECT name FROM sqlite_master WHERE type='table'")
                )
            }
    finally:
        engine.dispose()

    assert "transactions" in tables


def test_boot_creates_cache_and_config_schema_in_split_layout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Split startup must also build the cache + config tier schemas.

    Alembic only migrates the ledger tier, so without an explicit step the
    cache DB (prices/FX/snapshots) and config DB stayed schemaless — the
    background refresh then wrote into nothing and every value read as 0.
    """
    from investment_dashboard.config import get_settings
    from investment_dashboard.db import dispose_engines

    cache_path = tmp_path / "cache.sqlite"
    config_path = tmp_path / "config.sqlite"
    monkeypatch.delenv("INV_DASHBOARD_DB_PATH", raising=False)
    monkeypatch.setenv("INV_DASHBOARD_LEDGER_PATH", str(tmp_path / "ledger.sqlite"))
    monkeypatch.setenv("INV_DASHBOARD_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("INV_DASHBOARD_CACHE_PATH", str(cache_path))
    get_settings.cache_clear()
    dispose_engines()
    try:
        run_boot_sequence(skip_network=True)
    finally:
        dispose_engines()
        get_settings.cache_clear()

    def _tables(path: Path) -> set[str]:
        engine = sa.create_engine(f"sqlite:///{path.as_posix()}", future=True)
        try:
            with engine.connect() as conn:
                return {
                    row[0]
                    for row in conn.execute(
                        sa.text("SELECT name FROM sqlite_master WHERE type='table'")
                    )
                }
        finally:
            engine.dispose()

    cache_tables = _tables(cache_path)
    assert "price_history" in cache_tables
    assert "position_snapshots" in cache_tables
    assert "fx_history" in cache_tables
    assert "instrument_overrides" in _tables(config_path)
    # §3.1.1 — every storage tier carries its own Alembic version baseline.
    assert "alembic_version" in cache_tables
    assert "alembic_version" in _tables(config_path)


def test_boot_creates_schema_without_alembic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Installed wheel scenario: no alembic.ini, schema must still be created.

    Regression test for the release flow never working end-to-end: the
    packaged installer ships only the wheel (no ``alembic.ini`` / migrations
    tree), so boot must fall back to ``create_all`` and produce a complete
    schema. Without it every page failed with ``no such table``.
    """
    from investment_dashboard import boot
    from investment_dashboard.config import get_settings
    from investment_dashboard.db import dispose_engines

    db_path = tmp_path / "installed.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    # Simulate the packaged environment where Alembic cannot run.
    monkeypatch.setattr(boot, "_run_alembic_upgrade", lambda: False)
    get_settings.cache_clear()
    dispose_engines()
    try:
        run_boot_sequence(skip_network=True)
    finally:
        dispose_engines()
        get_settings.cache_clear()

    engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}", future=True)
    try:
        with engine.connect() as conn:
            tables = {
                row[0]
                for row in conn.execute(
                    sa.text("SELECT name FROM sqlite_master WHERE type='table'")
                )
            }
    finally:
        engine.dispose()

    # Every ORM table — across all storage tiers — must exist.
    assert {"transactions", "instruments", "accounts", "instrument_overrides"} <= tables


def test_split_layout_without_alembic_reads_app_config_via_ledger_session(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Portable-bundle first start must not crash reading ``app_config``.

    The portable bundle ships no Alembic, and a fresh install resolves to a
    split-DB layout (separate ledger/config/cache files). Config-tier reads
    such as the benchmark symbol still run on the back-compat ledger session,
    so the ledger DB must carry the ``app_config`` table. Regression test for
    the first-start ``no such table: app_config`` 500 error: building only the
    ledger metadata left that table out of the ledger DB.
    """
    from investment_dashboard import boot
    from investment_dashboard.config import get_settings
    from investment_dashboard.db import dispose_engines, session_scope
    from investment_dashboard.services import benchmark_service

    monkeypatch.delenv("INV_DASHBOARD_DB_PATH", raising=False)
    monkeypatch.setenv("INV_DASHBOARD_LEDGER_PATH", str(tmp_path / "ledger.sqlite"))
    monkeypatch.setenv("INV_DASHBOARD_CONFIG_PATH", str(tmp_path / "config.sqlite"))
    monkeypatch.setenv("INV_DASHBOARD_CACHE_PATH", str(tmp_path / "cache.sqlite"))
    # Simulate the packaged environment where Alembic cannot run.
    monkeypatch.setattr(boot, "_run_alembic_upgrade", lambda: False)
    get_settings.cache_clear()
    dispose_engines()
    try:
        run_boot_sequence(skip_network=True)
        with session_scope() as session:
            symbol = benchmark_service.get_symbol(session)
    finally:
        dispose_engines()
        get_settings.cache_clear()

    assert symbol == benchmark_service.DEFAULT_SYMBOL


def test_read_only_mode_skips_writer_maintenance(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A read-only secondary instance must not run writer-side boot steps.

    Regression test for the ``sqlite3.OperationalError: disk I/O error``
    boot crash: when another instance owns the writer lock (e.g. a second
    instance pointed at the same OneDrive-synced ledger), boot continues in
    read-only mode and must skip integrity check, rolling backup, and
    migrations — all of which open/modify the cloud-synced file and crash.
    """
    from investment_dashboard import boot
    from investment_dashboard.config import get_settings
    from investment_dashboard.db import dispose_engines

    db_path = tmp_path / "shared.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))

    # Force the read-only path as if the writer lock were already held.
    def _lose_lock() -> None:
        boot._boot_state["read_only"] = True

    monkeypatch.setattr(boot, "_acquire_writer_lock", _lose_lock)

    def _boom(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("writer-side maintenance must be skipped in read-only mode")

    monkeypatch.setattr("investment_dashboard.storage.integrity.integrity_check", _boom)
    monkeypatch.setattr("investment_dashboard.storage.backup.snapshot", _boom)
    monkeypatch.setattr(boot, "_run_alembic_upgrade", _boom)
    monkeypatch.setattr(boot, "_ensure_schema_present", _boom)

    saved = dict(boot._boot_state)
    get_settings.cache_clear()
    dispose_engines()
    try:
        # Must not raise despite every writer-side step being booby-trapped.
        run_boot_sequence(skip_network=True)
        assert boot.is_read_only() is True
    finally:
        boot._boot_state.update(saved)
        dispose_engines()
        get_settings.cache_clear()


def test_integrity_check_tolerates_transient_disk_io_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A transient ``OperationalError`` (e.g. cloud "disk I/O error") is not corruption.

    Even on the writer path, an access hiccup from the cloud sync client
    must not crash boot — only a genuine ``IntegrityCheckFailed`` should.
    """
    import sqlite3

    from investment_dashboard import boot
    from investment_dashboard.config import get_settings
    from investment_dashboard.db import dispose_engines

    db_path = tmp_path / "flaky.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))

    def _disk_io(*_args: object, **_kwargs: object) -> str:
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr("investment_dashboard.storage.integrity.integrity_check", _disk_io)

    saved = dict(boot._boot_state)
    boot._boot_state["read_only"] = False
    get_settings.cache_clear()
    dispose_engines()
    try:
        run_boot_sequence(skip_network=True)
    finally:
        _release_held_writer_lock()
        boot._boot_state.update(saved)
        dispose_engines()
        get_settings.cache_clear()


def test_nav_items_cover_all_pages() -> None:
    from investment_dashboard.ui.layout import NAV_ITEMS

    paths = {item.path for item in NAV_ITEMS}
    assert paths == {
        "/overview",
        "/holdings",
        "/deposits",
        "/transactions",
        "/monthly",
        "/yearly",
        "/projection",
        "/analytics",
        "/calculator",
        "/diagnostics",
        "/settings",
    }


def test_warm_snapshots_populates_cache_for_seeded_ledger(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``_warm_snapshots`` precomputes the daily cache off the request thread.

    Seeds a transaction, then verifies the background warm step writes a
    snapshot row for the period so the first ``/overview`` render reads cached
    values instead of rebuilding the curve day by day.
    """
    from datetime import date, timedelta
    from decimal import Decimal

    from investment_dashboard import boot
    from investment_dashboard.config import get_settings
    from investment_dashboard.db import dispose_engines, ledger_session_scope
    from investment_dashboard.models import Transaction
    from investment_dashboard.repositories import accounts_repo, snapshots_repo

    db_path = tmp_path / "warm.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    get_settings.cache_clear()
    dispose_engines()
    try:
        run_boot_sequence(skip_network=True)
        recent = date.today() - timedelta(days=3)
        with ledger_session_scope() as session:
            acct = accounts_repo.create_account(
                session,
                broker="vanguard",
                account_label="Brokerage",
                native_currency="EUR",
                account_type="brokerage",
            )
            session.add(
                Transaction(
                    account_id=acct.id,
                    instrument_id=None,
                    date=recent,
                    kind="deposit",
                    net_native=Decimal("1000.00"),
                    net_eur=Decimal("1000.00"),
                    source="manual",
                )
            )

        boot._warm_snapshots()

        with ledger_session_scope() as session:
            assert snapshots_repo.get_snapshot(session, recent) is not None
            assert snapshots_repo.get_snapshot(session, date.today()) is not None
    finally:
        dispose_engines()
        get_settings.cache_clear()
