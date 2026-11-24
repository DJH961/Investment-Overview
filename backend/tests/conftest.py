"""Shared pytest fixtures."""

from __future__ import annotations

import logging
import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, ClassVar

import pytest
from hypothesis import settings as hypothesis_settings
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

# Force an in-memory DB before app modules read settings.
os.environ.setdefault("INV_DASHBOARD_DB_PATH", ":memory:")
# Never read or write the OS keychain (on the owner's laptop it holds the real
# passphrase and Tiingo token): every lookup raises NoKeyringError, which the app
# treats as "no keychain". Tests of keyring handling patch ``keyring`` themselves.
os.environ["PYTHON_KEYRING_BACKEND"] = "keyring.backends.fail.Keyring"

from investment_dashboard.models import ALL_METADATAS, Base  # noqa: F401

# --- Hypothesis profiles ---------------------------------------------------
#
# ``dev`` (the local default) caps every property test at ``_DEV_MAX_EXAMPLES``
# examples, including tests that ask for more with ``@settings(max_examples=...)``
# (see ``_cap_hypothesis_examples``). ``ci`` keeps each test's own count; CI sets
# ``HYPOTHESIS_PROFILE=ci``. Run ``HYPOTHESIS_PROFILE=ci uv run pytest ...`` locally
# for the full counts after changing money maths.
_DEV_MAX_EXAMPLES = 30
hypothesis_settings.register_profile("ci", deadline=None, print_blob=True)
hypothesis_settings.register_profile("dev", max_examples=_DEV_MAX_EXAMPLES, deadline=None)
_HYPOTHESIS_PROFILE = os.environ.get("HYPOTHESIS_PROFILE", "dev")
hypothesis_settings.load_profile(_HYPOTHESIS_PROFILE)

#: Test modules that check real SQLite durability, journal modes, WAL sidecars or
#: backups. They keep the production pragmas (see ``_fast_sqlite``); a single test
#: elsewhere opts out with ``@pytest.mark.durable_sqlite``.
_DURABLE_SQLITE_MODULES = (
    "tests/test_db_tiers.py",
    "tests/storage/",
    "tests/services/test_backup_service.py",
    "tests/services/test_backup_settings.py",
    "tests/tools/test_restore_db.py",
    "tests/tools/test_upload_db.py",
    "tests/api/test_ops.py",
)


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--run-network",
        action="store_true",
        default=False,
        help="Also run tests marked @pytest.mark.network that hit real external APIs.",
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    root = config.rootpath
    for item in items:
        rel = item.path.relative_to(root).as_posix() if item.path.is_relative_to(root) else ""
        if rel.startswith(_DURABLE_SQLITE_MODULES):
            item.add_marker(pytest.mark.durable_sqlite)
        _cap_hypothesis_examples(item)
    if config.getoption("--run-network"):
        return
    skip_network = pytest.mark.skip(reason="needs --run-network to run")
    for item in items:
        if "network" in item.keywords:
            item.add_marker(skip_network)


def _cap_hypothesis_examples(item: pytest.Item) -> None:
    """Under the ``dev`` profile, cap explicit ``@settings(max_examples=N)`` too.

    An explicit ``max_examples`` beats any profile, so without this the 150-300
    example property tests would run at full size on every local run. Hypothesis
    reads the settings from the wrapped test when it runs, so a capped copy set
    here takes effect. Only the ``dev`` profile caps; ``ci`` runs the full counts.
    """
    if _HYPOTHESIS_PROFILE != "dev":
        return
    func = getattr(item, "function", None)
    if func is None or not getattr(func, "is_hypothesis_test", False):
        return
    current = getattr(func, "_hypothesis_internal_use_settings", None)
    if isinstance(current, hypothesis_settings) and current.max_examples > _DEV_MAX_EXAMPLES:
        func._hypothesis_internal_use_settings = hypothesis_settings(  # type: ignore[attr-defined]
            current, max_examples=_DEV_MAX_EXAMPLES
        )


@pytest.fixture(autouse=True)
def _fast_sqlite(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    """Skip fsync on the app's SQLite engines while tests run.

    Production engines use ``synchronous=FULL`` (NORMAL for the cache) so a crash
    cannot lose a commit; a test database is thrown away, and on Windows the fsyncs
    are most of the cost of a DB-backed test. The journal mode, busy timeout and
    foreign keys stay as in production, so locking behaves the same. Tests marked
    ``durable_sqlite`` (durability, journal, WAL and backup checks) keep the real
    pragmas.
    """
    if request.node.get_closest_marker("durable_sqlite") is not None:
        return
    from investment_dashboard import db as db_mod

    real = db_mod._install_sqlite_pragmas

    def fast(
        engine: Engine, db_path: Path | None, encryption: Any, *, durable: bool = True
    ) -> None:
        real(engine, db_path, encryption, durable=durable)

        @event.listens_for(engine, "connect")
        def _no_fsync(dbapi_conn, _record):  # type: ignore[no-untyped-def]
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA synchronous=OFF")
            cur.close()

    monkeypatch.setattr(db_mod, "_install_sqlite_pragmas", fast)


@pytest.fixture
def engine() -> Iterator[Engine]:
    """Fresh in-memory SQLite engine with FKs enabled, per test."""
    eng = create_engine(
        "sqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def _fk_on(dbapi_conn, _record):  # type: ignore[no-untyped-def]
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    for md in ALL_METADATAS:
        md.create_all(eng)
    try:
        yield eng
    finally:
        eng.dispose()


@pytest.fixture
def session(engine: Engine) -> Iterator[Session]:
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    s = factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def tmp_db_path(tmp_path: Path) -> Path:
    """Path to a fresh on-disk SQLite file (useful for Alembic tests)."""
    return tmp_path / "test.sqlite"


@pytest.fixture(autouse=True)
def _loggers_enabled() -> None:
    """Undo Alembic's ``fileConfig(disable_existing_loggers=True)`` between tests.

    Any migration test switches off every logger that already exists, so a later
    test that checks log output (``caplog``) sees nothing. Serial runs hid this by
    file order; under ``pytest -n`` the order differs per worker.
    """
    for logger in logging.root.manager.loggerDict.values():
        if isinstance(logger, logging.Logger):
            logger.disabled = False


@pytest.fixture(autouse=True)
def _fresh_read_cache() -> Iterator[None]:
    """The API read cache is process-wide: never let one test see another's answers."""
    from investment_dashboard.services import read_cache

    read_cache.invalidate()
    yield
    read_cache.invalidate()


@pytest.fixture(autouse=True)
def _isolate_scheduler_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """The scheduler's persisted ``last_eod_session`` must not leak between tests.

    Tests that exercise the persistence override this fixture by name.
    """
    from investment_dashboard.services.scheduler import Scheduler

    monkeypatch.setattr(Scheduler, "_load_eod_session", lambda self: None)
    monkeypatch.setattr(Scheduler, "_save_eod_session", lambda self, session_date: None)


@pytest.fixture(autouse=True)
def snapshot_fill_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[Any, Any]]:
    """Readers must not start a real snapshot-fill thread against the test database.

    The calls are recorded instead; a test can request this fixture by name to read
    them.
    """
    from investment_dashboard.services import snapshots_service

    calls: list[tuple[Any, Any]] = []
    monkeypatch.setattr(
        snapshots_service,
        "fill_missing_in_background",
        lambda start, end: calls.append((start, end)) or True,
    )
    return calls


class MarketClock:
    """Pins the backend's "now" (``domain.clock.now``) to a named market moment.

    Call it with a moment name or an aware datetime: ``market_clock("open")``.
    Names (New York time, on the latest ordinary trading day up to today):
    ``preopen`` 08:00, ``open`` 11:00, ``preclose`` 15:45, ``closing`` 16:05,
    ``closed`` 22:00, and ``weekend`` (Saturday 12:00 of the latest weekend).
    Returns the pinned instant (aware UTC). Call again to move the clock.
    """

    MOMENTS: ClassVar[dict[str, tuple[int, int]]] = {
        "preopen": (8, 0),
        "open": (11, 0),
        "preclose": (15, 45),
        "closing": (16, 5),
        "closed": (22, 0),
        "weekend": (12, 0),
    }

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._monkeypatch = monkeypatch
        self.now: datetime | None = None

    def __call__(self, moment: str | datetime) -> datetime:
        from investment_dashboard.domain import clock, market_hours

        if isinstance(moment, datetime):
            if moment.tzinfo is None:
                raise ValueError("market_clock needs an aware datetime")
            pinned = moment.astimezone(UTC)
        else:
            if moment not in self.MOMENTS:
                raise ValueError(f"unknown market moment {moment!r}; use {list(self.MOMENTS)}")
            day = datetime.now(UTC).astimezone(market_hours.MARKET_TZ).date()
            if moment == "weekend":
                while day.weekday() != 5:
                    day -= timedelta(days=1)
            else:
                while not market_hours.is_trading_day(day) or market_hours.is_early_close_day(day):
                    day -= timedelta(days=1)
            hour, minute = self.MOMENTS[moment]
            pinned = datetime(
                day.year, day.month, day.day, hour, minute, tzinfo=market_hours.MARKET_TZ
            ).astimezone(UTC)
        self.now = pinned
        self._monkeypatch.setattr(clock, "now", lambda: pinned)
        return pinned


@pytest.fixture
def market_clock(monkeypatch: pytest.MonkeyPatch) -> MarketClock:
    """Pin "now" for market-time-sensitive code: ``market_clock("open")``.

    Moves ``domain.clock.now`` (used by the read models, ``market_hours`` defaults and
    ``live_bus.market_state``). Code reading ``datetime.now`` elsewhere (scheduler,
    services) is not affected.
    """
    return MarketClock(monkeypatch)


@pytest.fixture(autouse=True)
def _fresh_feed_stall() -> Iterator[None]:
    """The frozen-feed detector is process-wide: start every test with a clean one."""
    from investment_dashboard.services import feed_stall_service

    feed_stall_service.reset()
    yield
    feed_stall_service.reset()
