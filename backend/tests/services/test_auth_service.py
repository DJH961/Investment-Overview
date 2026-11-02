# ruff: noqa: PT018
"""Unit tests for the auth service (hashing, sessions, rate limiter, challenges)."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any

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
    svc.reset_limiters()
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
    # global cap = max(10*limit, 50); a valid session may bypass it
    for i in range(50):
        rl.record_failure(f"ip{i}")
    assert rl.retry_after("fresh", 3) is not None
    assert rl.retry_after("fresh", 3, bypass_global=True) is None


def test_rate_limiter_sweeps_stale_keys(clock: Clock, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(svc, "MAX_RATE_KEYS", 5)
    rl = svc.RateLimiter()
    for i in range(10):
        rl.record_failure(f"ip{i}")
    clock.advance(seconds=61)
    rl.record_failure("new")
    assert list(rl._per_key) == ["new"]


def test_client_key_groups_ipv6_by_64() -> None:
    assert svc.client_key("203.0.113.9") == "203.0.113.9"
    assert svc.client_key("2001:db8:1:2:aaaa::1") == svc.client_key("2001:db8:1:2:bbbb::2")
    assert svc.client_key("2001:db8:1:2::1") != svc.client_key("2001:db8:1:3::1")
    assert svc.client_key("::ffff:203.0.113.9") == "203.0.113.9"
    assert svc.client_key(None) == "unknown"


def test_challenge_store_capped_and_purged(clock: Clock, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(svc, "MAX_CHALLENGES", 3)
    keys = [svc.challenges.put("login", bytes([i])) for i in range(5)]
    assert len(svc.challenges._items) == 3
    assert svc.challenges.pop(keys[0], "login") is None  # oldest evicted
    assert svc.challenges.pop(keys[4], "login") == (bytes([4]), None)
    clock.advance(seconds=svc.CHALLENGE_TTL_SECONDS + 1)
    svc.challenges.put("login", b"x")
    assert len(svc.challenges._items) == 1


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


def test_peek_session_does_not_slide_idle_timeout(
    db: Session, settings: Settings, clock: Clock
) -> None:
    token = svc.create_session(db, settings, None)
    for _ in range(2):  # peeking at 20 min intervals never extends the session
        clock.advance(minutes=20)
        assert svc.peek_session(db, settings, token) is (clock.t - T0 < timedelta(minutes=30))
    assert svc.peek_session(db, settings, token) is False
    assert svc.peek_session(db, settings, "bogus") is False
    assert svc.peek_session(db, settings, "") is False


# --------------------------------------------------------------------------- hardening


def test_reserve_counts_before_the_check_and_refund_takes_it_back(clock: Clock) -> None:
    lim = svc.RateLimiter(global_factor=None)
    first = lim.reserve("a", 2)
    lim.reserve("a", 2)
    with pytest.raises(svc.RateLimitedError) as exc:
        lim.reserve("a", 2)
    assert exc.value.retry_after >= 1
    first.refund()
    first.refund()  # idempotent
    lim.reserve("a", 2)  # the refunded slot is free again
    with pytest.raises(svc.RateLimitedError):
        lim.reserve("a", 2)


def test_reserve_is_atomic_under_concurrency(clock: Clock) -> None:
    lim = svc.RateLimiter(global_factor=None)
    barrier = threading.Barrier(5)
    results: list[bool] = []
    lock = threading.Lock()

    def attempt() -> None:
        barrier.wait()
        try:
            lim.reserve("ip", 2)
            ok = True
        except svc.RateLimitedError:
            ok = False
        with lock:
            results.append(ok)

    threads = [threading.Thread(target=attempt) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == [False, False, False, True, True]


def test_refund_also_frees_the_global_window(clock: Clock) -> None:
    lim = svc.RateLimiter(global_factor=1, global_min=2)
    slot = lim.reserve("a", 1)  # global cap: max(1 * 1, 2) == 2
    lim.reserve("b", 1)
    with pytest.raises(svc.RateLimitedError):
        lim.reserve("c", 1)
    slot.refund()
    lim.reserve("c", 1)


def test_passkey_and_token_limiters_have_no_global_cap(clock: Clock) -> None:
    for i in range(500):
        svc.passkey_limiter.record_failure(f"ip{i}")
        svc.token_limiter.record_failure(f"ip{i}")
    assert svc.passkey_limiter.retry_after("fresh-ip", 5) is None
    assert svc.token_limiter.retry_after("fresh-ip", 5) is None
    assert svc.rate_limiter.retry_after("fresh-ip", 5) is None  # untouched


def test_verify_password_refuses_when_slots_are_full(
    db: Session, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    svc.set_password(db, "a-good-long-password")
    entered = threading.Barrier(3)
    release = threading.Event()

    def slow_verify(stored: str, password: str) -> bool:
        entered.wait(timeout=5)
        release.wait(timeout=5)
        return True

    monkeypatch.setattr(svc, "_hasher", SimpleNamespace(verify=slow_verify))
    results: list[Any] = []

    def run() -> None:
        results.append(svc.verify_password(db, "a-good-long-password", max_concurrent=2))

    workers = [threading.Thread(target=run) for _ in range(2)]
    for w in workers:
        w.start()
    entered.wait(timeout=5)  # both slots are now taken
    with pytest.raises(svc.VerifierBusyError):
        svc.verify_password(db, "a-good-long-password", max_concurrent=2)
    release.set()
    for w in workers:
        w.join()
    assert results == [True, True]
    monkeypatch.setattr(svc, "_hasher", SimpleNamespace(verify=lambda stored, password: True))
    assert svc.verify_password(db, "a-good-long-password", max_concurrent=2)  # slots freed


def test_session_is_fresh_window(db: Session, clock: Clock) -> None:
    settings = Settings(fresh_session_minutes=10)
    token = svc.create_session(db, settings, None)
    sid = svc.validate_session(db, settings, token)
    assert sid is not None
    assert svc.session_is_fresh(db, settings, sid)
    clock.advance(minutes=9)
    svc.validate_session(db, settings, token)  # activity does not refresh "fresh"
    assert svc.session_is_fresh(db, settings, sid)
    clock.advance(minutes=2)
    assert not svc.session_is_fresh(db, settings, sid)
    assert not svc.session_is_fresh(db, settings, "unknown")
