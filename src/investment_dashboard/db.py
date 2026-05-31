"""Database engines and Session factories — split by storage tier.

The app's data is partitioned across three tiers (see the v2.0
rework plan):
  * **ledger** — accounts / instruments / transactions / targets.
  * **config** — user overrides and app config.
  * **cache** — prices / FX / snapshots (derived, rebuildable).

Each tier has its own engine and session factory. When the user keeps
the default configuration (a single file), all three engines share one
underlying SQLite file, so there is no behavioural change. When the
user splits the tiers across separate files (e.g. ledger on
OneDrive, cache local), each engine connects to its own file.

A back-compat ``session_scope()`` alias is preserved for any call site
that hasn't been migrated to a tier-specific scope; it returns a
ledger-tier session.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from investment_dashboard.config import get_settings
from investment_dashboard.storage.encryption import (
    EncryptionConfig,
    apply_sqlcipher_key,
    to_sqlcipher_url,
)
from investment_dashboard.storage.sidecar import should_use_truncate_journal


def _ensure_parent(path: Path) -> None:
    if path.as_posix() == ":memory:":
        return
    path.parent.mkdir(parents=True, exist_ok=True)


# Encryption config applied to subsequently-created engines. Boot sets
# this once after resolving the keyring/env passphrase. Tests can leave
# it at the default disabled value. Kept inside a dict so we don't
# need the `global` keyword on the setter.
_engine_state: dict[str, EncryptionConfig] = {"encryption": EncryptionConfig(enabled=False)}


def set_active_encryption(config: EncryptionConfig) -> None:
    """Configure encryption applied to future engines."""
    _engine_state["encryption"] = config


def get_active_encryption() -> EncryptionConfig:
    return _engine_state["encryption"]


def _url_path(url: str) -> Path | None:
    """Best-effort extract the on-disk path from a sqlite URL."""
    for prefix in ("sqlite+pysqlcipher:///", "sqlite:///"):
        if url.startswith(prefix):
            tail = url[len(prefix) :]
            if tail == ":memory:":
                return None
            return Path(tail)
    return None


def make_engine(
    url: str | None = None, *, encryption_config: EncryptionConfig | None = None
) -> Engine:
    """Create a SQLAlchemy engine for ``url`` (or the legacy db_url)."""
    if url is None:
        settings = get_settings()
        _ensure_parent(settings.db_path)
        url = settings.db_url
    encryption = _engine_state["encryption"] if encryption_config is None else encryption_config
    engine_url = to_sqlcipher_url(url, encryption)
    engine = create_engine(
        engine_url,
        future=True,
        echo=False,
        connect_args={"check_same_thread": False} if "sqlite" in engine_url else {},
    )
    if engine_url.startswith("sqlite"):
        _install_sqlite_pragmas(engine, _url_path(engine_url), encryption)
    return engine


def _install_sqlite_pragmas(
    engine: Engine,
    db_path: Path | None,
    encryption: EncryptionConfig,
) -> None:
    use_truncate = db_path is not None and should_use_truncate_journal(db_path)

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_conn: Any, _conn_record: Any) -> None:
        # Encryption key MUST be the first statement on the connection.
        apply_sqlcipher_key(dbapi_conn, encryption)
        cursor = dbapi_conn.cursor()
        if use_truncate:
            cursor.execute("PRAGMA journal_mode=TRUNCATE")
        else:
            cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()


# Per-tier lazy singletons. When two tiers resolve to the same URL we
# share a single engine so SQLite WAL coordination still works.
_engines_by_url: dict[str, Engine] = {}
_factories_by_url: dict[str, sessionmaker[Session]] = {}


def _get_or_create_for_url(
    url: str,
    *,
    encryption_config: EncryptionConfig | None = None,
) -> tuple[Engine, sessionmaker[Session]]:
    eng = _engines_by_url.get(url)
    if eng is None:
        eng = make_engine(url, encryption_config=encryption_config)
        _engines_by_url[url] = eng
        _factories_by_url[url] = sessionmaker(bind=eng, autoflush=False, expire_on_commit=False)
    return eng, _factories_by_url[url]


def _ensure_parent_for(path: Path) -> None:
    _ensure_parent(path)


def get_ledger_engine() -> Engine:
    settings = get_settings()
    assert settings.ledger_path is not None
    _ensure_parent_for(settings.ledger_path)
    return _get_or_create_for_url(settings.ledger_url)[0]


def get_config_engine() -> Engine:
    settings = get_settings()
    assert settings.config_path is not None
    _ensure_parent_for(settings.config_path)
    return _get_or_create_for_url(settings.config_url)[0]


def get_cache_engine() -> Engine:
    settings = get_settings()
    assert settings.cache_path is not None
    _ensure_parent_for(settings.cache_path)
    # Cache is local and unencrypted unless the user is in legacy/single-file
    # mode, where cache_url is the same physical DB as ledger/config.
    encryption = (
        _engine_state["encryption"]
        if settings.cache_url in {settings.ledger_url, settings.config_url}
        else EncryptionConfig(enabled=False)
    )
    return _get_or_create_for_url(settings.cache_url, encryption_config=encryption)[0]


def get_ledger_session_factory() -> sessionmaker[Session]:
    settings = get_settings()
    get_ledger_engine()
    return _factories_by_url[settings.ledger_url]


def get_config_session_factory() -> sessionmaker[Session]:
    settings = get_settings()
    get_config_engine()
    return _factories_by_url[settings.config_url]


def get_cache_session_factory() -> sessionmaker[Session]:
    settings = get_settings()
    get_cache_engine()
    return _factories_by_url[settings.cache_url]


# --- Back-compat single-engine API ----------------------------------


def get_engine() -> Engine:
    """Legacy: returns the ledger engine."""
    return get_ledger_engine()


def get_session_factory() -> sessionmaker[Session]:
    """Legacy: returns the ledger session factory."""
    return get_ledger_session_factory()


# --- Context managers -----------------------------------------------


@contextmanager
def _scope(factory: sessionmaker[Session]) -> Iterator[Session]:
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


@contextmanager
def ledger_session_scope() -> Iterator[Session]:
    """Transactional ledger-tier session."""
    with _scope(get_ledger_session_factory()) as s:
        yield s


@contextmanager
def config_session_scope() -> Iterator[Session]:
    """Transactional config-tier session."""
    with _scope(get_config_session_factory()) as s:
        yield s


@contextmanager
def cache_session_scope() -> Iterator[Session]:
    """Transactional cache-tier session."""
    with _scope(get_cache_session_factory()) as s:
        yield s


@contextmanager
def session_scope() -> Iterator[Session]:
    """Back-compat ledger session.

    Prefer :func:`ledger_session_scope`, :func:`config_session_scope`,
    or :func:`cache_session_scope` in new code so the storage tier is
    explicit.
    """
    with ledger_session_scope() as s:
        yield s


@contextmanager
def cache_read_session(fallback: Session) -> Iterator[Session]:
    """Yield a session that can *read* cache-tier data (prices/FX/snapshots).

    In single-file mode all three tiers share one database, so the caller's
    ``fallback`` session already sees the cache tables and is reused untouched
    (zero overhead, and tests that build their own engine keep working).

    In split-DB mode the cache tables live in a **separate** database that the
    caller's ledger/config session cannot see — querying them through the
    ledger session would hit the ledger DB's (empty) copies and silently return
    ``None`` for every price/FX lookup, zeroing all historical valuations. So a
    short-lived cache-tier session is opened here and closed afterwards. It is
    read-only; no commit is issued.
    """
    if not get_settings().is_split_db:
        yield fallback
        return
    s = get_cache_session_factory()()
    try:
        yield s
    finally:
        s.close()


@contextmanager
def cache_write_session(fallback: Session) -> Iterator[Session]:
    """Yield a session that can *write* cache-tier data (e.g. snapshots).

    Mirror of :func:`cache_read_session` for the write path. In single-file
    mode the caller's ``fallback`` session is reused and left for the caller to
    commit (preserving the legacy write-through-without-commit behaviour). In
    split-DB mode a dedicated cache-tier transaction is opened and committed so
    the row lands in the cache database the readers and the boot-time snapshot
    invalidation actually use.
    """
    if not get_settings().is_split_db:
        yield fallback
        return
    with cache_session_scope() as s:
        yield s


def dispose_engines() -> None:
    """Dispose all cached engines (used by tests and ``split_db``)."""
    for eng in _engines_by_url.values():
        eng.dispose()
    _engines_by_url.clear()
    _factories_by_url.clear()
