"""Shared pytest fixtures."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

# Force an in-memory DB before app modules read settings.
os.environ.setdefault("INV_DASHBOARD_DB_PATH", ":memory:")

from investment_dashboard.models import Base


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--run-network",
        action="store_true",
        default=False,
        help="Also run tests marked @pytest.mark.network that hit real external APIs.",
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if config.getoption("--run-network"):
        return
    skip_network = pytest.mark.skip(reason="needs --run-network to run")
    for item in items:
        if "network" in item.keywords:
            item.add_marker(skip_network)


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

    Base.metadata.create_all(eng)
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
