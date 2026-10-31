# ruff: noqa: PT018
"""Unit tests for the auth service (hashing, sessions, rate limiter, challenges)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from investment_dashboard.config import Settings
from investment_dashboard.models.auth import AuthCredential, AuthSession
from investment_dashboard.models.base import ConfigBase
from investment_dashboard.services import auth_service as svc

T0 = datetime(2026, 1, 1, 12, 0, 0)


class Clock:
    def __init__(self) -> None:
        self.t = T0

    def __call__(self) -> datetime:
        return self.t

    def advance(self, **kw: float) -> None:
        self.t += timedelta(**kw)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    c = Clock()
    monkeypatch.setattr(svc, "_clock", c)
    svc.rate_limiter.reset()
    svc.challenges.reset()
    return c


@pytest.fixture
def db() -> Iterator[Session]:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    ConfigBase.metadata.create_all(engine)
    with sessionmaker(engine)() as s:
        yield s


@pytest.fixture
def settings() -> Settings:
    return Settings(session_idle_minutes=30, session_max_age_days=2)


def test_set_and_verify_password(db: Session, clock: Clock) -> None:
    assert not svc.has_password(db)
    assert not svc.verify_password(db, "anything-at-all-123")
    svc.set_password(db, "correct horse battery")
    assert svc.verify_password(db, "correct horse battery")
    assert not svc.verify_password(db, "wrong horse battery!")
    stored = db.get(AuthCredential, 1)
    assert stored is not None and stored.password_hash.startswith("$argon2id$")


def test_short_password_rejected(db: Session, clock: Clock) -> None:
    with pytest.raises(svc.WeakPasswordError):
        svc.set_password(db, "short")
    assert not svc.has_password(db)


def test_set_password_revokes_sessions(db: Session, settings: Settings, clock: Clock) -> None:
    svc.create_session(db, settings, "ua")
    svc.set_password(db, "correct horse battery")
    assert db.scalars(select(AuthSession)).all() == []


def test_session_stored_hashed(db: Session, settings: Settings, clock: Clock) -> None:
    token = svc.create_session(db, settings, "ua")
    row = db.scalars(select(AuthSession)).one()
    assert row.id != token and len(row.id) == 64
    assert svc.validate_session(db, settings, token) == row.id
    assert svc.validate_session(db, settings, "bogus") is None
    assert svc.validate_session(db, settings, "") is None


def test_idle_timeout_slides(db: Session, settings: Settings, clock: Clock) -> None:
    token = svc.create_session(db, settings, None)
    for _ in range(4):  # 4 x 20min > 30min idle, but activity keeps sliding it
        clock.advance(minutes=20)
        assert svc.validate_session(db, settings, token) is not None
    clock.advance(minutes=31)
    assert svc.validate_session(db, settings, token) is None
    assert db.scalars(select(AuthSession)).all() == []


def test_absolute_timeout(db: Session, settings: Settings, clock: Clock) -> None:
    token = svc.create_session(db, settings, None)
    while clock.t < T0 + timedelta(days=2) - timedelta(minutes=20):
        clock.advance(minutes=20)
        assert svc.validate_session(db, settings, token) is not None
    clock.advance(minutes=21)  # still within idle of last touch, but past the cap
    assert svc.validate_session(db, settings, token) is None


def test_rate_limiter_window_and_global(clock: Clock) -> None:
    rl = svc.rate_limiter
    assert rl.retry_after("a", 3) is None
    for _ in range(3):
        rl.record_failure("a")
    wait = rl.retry_after("a", 3)
    assert wait is not None and 1 <= wait <= 61
    assert rl.retry_after("b", 3) is None
    clock.advance(seconds=61)
    assert rl.retry_after("a", 3) is None
    # global cap = max(4*limit, 20)
    for i in range(20):
        rl.record_failure(f"ip{i}")
    assert rl.retry_after("fresh", 3) is not None


def test_challenges_single_use_and_ttl(clock: Clock) -> None:
    key = svc.challenges.put("login", b"abc")
    assert svc.challenges.pop(key, "register") is None  # wrong purpose consumes it
    assert svc.challenges.pop(key, "login") is None
    key = svc.challenges.put("login", b"abc")
    assert svc.challenges.pop(key, "login") == (b"abc", None)
    assert svc.challenges.pop(key, "login") is None
    key = svc.challenges.put("login", b"abc")
    clock.advance(seconds=svc.CHALLENGE_TTL_SECONDS + 1)
    assert svc.challenges.pop(key, "login") is None
    assert svc.challenges.pop(None, "login") is None
