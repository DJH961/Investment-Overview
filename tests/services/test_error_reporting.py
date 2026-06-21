"""Tests for uncaught-exception / stray-stderr surfacing into runtime_status."""

from __future__ import annotations

import logging
import sys
import threading
from collections.abc import Iterator

import pytest

from investment_dashboard.services import error_reporting, runtime_status


@pytest.fixture(autouse=True)
def _reset_runtime_status() -> Iterator[None]:
    runtime_status.reset()
    yield
    runtime_status.reset()


@pytest.fixture
def _installed() -> Iterator[None]:
    error_reporting.install()
    try:
        yield
    finally:
        error_reporting.uninstall()


def test_install_is_idempotent_and_reversible() -> None:
    original = sys.excepthook
    error_reporting.install()
    error_reporting.install()  # second call is a no-op
    assert sys.excepthook is not original
    error_reporting.uninstall()
    assert sys.excepthook is original


@pytest.mark.usefixtures("_installed")
def test_excepthook_records_uncaught_exception() -> None:
    try:
        raise ValueError("kaboom")
    except ValueError:
        sys.excepthook(*sys.exc_info())
    latest = runtime_status.latest()
    assert latest is not None
    assert latest.source == "Unexpected error"
    assert "ValueError: kaboom" in latest.message


@pytest.mark.usefixtures("_installed")
def test_keyboard_interrupt_delegates_and_is_not_recorded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delegated: list[type[BaseException]] = []
    monkeypatch.setitem(
        error_reporting._saved,
        "excepthook",
        lambda exc_type, exc_value, exc_tb: delegated.append(exc_type),
    )
    try:
        raise KeyboardInterrupt
    except KeyboardInterrupt:
        sys.excepthook(*sys.exc_info())
    # Delegated to the original hook, recorded nothing of its own.
    assert delegated == [KeyboardInterrupt]
    assert not any(e.source == "Unexpected error" for e in runtime_status.recent())


@pytest.mark.usefixtures("_installed")
def test_threading_excepthook_records_worker_failure() -> None:
    def _boom() -> None:
        raise RuntimeError("thread blew up")

    thread = threading.Thread(target=_boom, name="worker-x")
    thread.start()
    thread.join()
    latest = runtime_status.latest()
    assert latest is not None
    assert "worker-x" in latest.source
    assert "RuntimeError: thread blew up" in latest.message


def test_stderr_tee_records_stray_writes_and_forwards() -> None:
    import io

    sink = io.StringIO()
    tee = error_reporting._StderrTee(sink)
    tee.write("a stray library complaint\n")
    # Forwarded to the wrapped stream...
    assert sink.getvalue() == "a stray library complaint\n"
    # ...and recorded as a single stderr entry.
    latest = runtime_status.latest()
    assert latest is not None
    assert latest.source == "stderr"
    assert latest.message == "a stray library complaint"


def test_stderr_tee_buffers_until_newline() -> None:
    import io

    tee = error_reporting._StderrTee(io.StringIO())
    tee.write("partial line without newline")
    assert runtime_status.sequence() == 0  # nothing recorded yet
    tee.write(" now complete\n")
    latest = runtime_status.latest()
    assert latest is not None
    assert latest.message == "partial line without newline now complete"


def test_install_wraps_stderr() -> None:
    error_reporting.install()
    try:
        assert isinstance(sys.stderr, error_reporting._StderrTee)
    finally:
        error_reporting.uninstall()
    assert not isinstance(sys.stderr, error_reporting._StderrTee)


def test_loop_exception_handler_records() -> None:
    error_reporting.loop_exception_handler(
        loop=None, context={"message": "Task exception", "exception": KeyError("k")}
    )
    latest = runtime_status.latest()
    assert latest is not None
    assert latest.source == "Async task"
    assert "KeyError" in latest.message


def test_logging_output_bypasses_stderr_tee() -> None:
    """A logged warning written to stderr by a StreamHandler must not be
    double-recorded through the stderr tee (the handler keeps the original
    stream)."""
    # Build a StreamHandler bound to the *current* (original) stderr, then
    # install the tee — mirroring configure_logging() ordering.
    handler = logging.StreamHandler(stream=sys.stderr)
    error_reporting.install()
    try:
        logger = logging.getLogger("bypass.test")
        logger.addHandler(handler)
        logger.warning("logged line that hits stderr")
        # The tee should not have captured the handler's write.
        assert all(e.source != "stderr" for e in runtime_status.recent())
    finally:
        logger.removeHandler(handler)
        error_reporting.uninstall()
