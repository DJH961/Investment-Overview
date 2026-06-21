"""Tests for the adapter retry/backoff helper."""

from __future__ import annotations

import pytest

from investment_dashboard.adapters._retry import RateLimitedError, retry_call


def test_returns_immediately_on_success() -> None:
    calls = {"n": 0}

    def _ok() -> str:
        calls["n"] += 1
        return "value"

    assert retry_call(_ok, sleep=lambda _: None) == "value"
    assert calls["n"] == 1


def test_retries_then_succeeds() -> None:
    calls = {"n": 0}
    waits: list[float] = []

    def _flaky() -> str:
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("transient")
        return "ok"

    result = retry_call(
        _flaky,
        attempts=3,
        backoff_seconds=0.5,
        sleep=waits.append,
    )
    assert result == "ok"
    assert calls["n"] == 3
    # Exponential schedule: 0.5 * 2**0, then 0.5 * 2**1.
    assert waits == [0.5, 1.0]


def test_exhausts_attempts_and_reraises_last() -> None:
    def _always_fails() -> str:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        retry_call(_always_fails, attempts=2, sleep=lambda _: None)


def test_non_retryable_exception_propagates_immediately() -> None:
    calls = {"n": 0}

    def _bad() -> str:
        calls["n"] += 1
        raise KeyError("programming error")

    with pytest.raises(KeyError):
        retry_call(_bad, attempts=3, retry_on=(ValueError,), sleep=lambda _: None)
    assert calls["n"] == 1  # not retried


def test_rate_limited_honours_retry_after_hint() -> None:
    calls = {"n": 0}
    waits: list[float] = []

    def _limited() -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RateLimitedError("429", retry_after=5.0)
        return "ok"

    result = retry_call(
        _limited,
        attempts=2,
        backoff_seconds=0.5,
        retry_on=(),  # 429 is retried regardless of retry_on
        sleep=waits.append,
    )
    assert result == "ok"
    # retry_after (5.0) overrides the smaller computed backoff (0.5).
    assert waits == [5.0]


def test_invalid_attempts_raises() -> None:
    with pytest.raises(ValueError, match="attempts"):
        retry_call(lambda: None, attempts=0)
