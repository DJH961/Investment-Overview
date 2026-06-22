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


def test_stderr_tee_skips_benign_alembic_info_lines() -> None:
    """Benign INFO/DEBUG library chatter (e.g. Alembic migration logs) is
    forwarded to the stream but never recorded as a 'Recent error'."""
    import io

    sink = io.StringIO()
    tee = error_reporting._StderrTee(sink)
    line = "INFO  [alembic.runtime.migration] Will assume non-transactional DDL.\n"
    tee.write(line)
    # Forwarded to the wrapped stream unchanged...
    assert sink.getvalue() == line
    # ...but not recorded as an error.
    assert runtime_status.sequence() == 0


def test_stderr_tee_records_real_error_mixed_with_info() -> None:
    """A chunk that mixes a genuine error with INFO noise is still recorded."""
    import io

    tee = error_reporting._StderrTee(io.StringIO())
    tee.write("INFO  [alembic] context\nTraceback (most recent call last):\n")
    latest = runtime_status.latest()
    assert latest is not None
    assert latest.source == "stderr"


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


def test_unraisablehook_records_unraisable_exception() -> None:
    class _Unraisable:
        exc_type = ValueError
        exc_value = ValueError("during __del__")
        exc_traceback = None
        object = "some-object"
        err_msg = None

    error_reporting._unraisablehook(_Unraisable())
    latest = runtime_status.latest()
    assert latest is not None
    assert latest.source == "Unraisable error"
    assert "ValueError: during __del__" in latest.message


def test_unraisablehook_ignores_missing_exc_value() -> None:
    class _Unraisable:
        exc_type = None
        exc_value = None
        exc_traceback = None
        object = None
        err_msg = None

    before = runtime_status.sequence()
    error_reporting._unraisablehook(_Unraisable())
    assert runtime_status.sequence() == before


def test_loop_exception_handler_without_exception_records_message() -> None:
    # The else branch: no exception object, only a message string.
    error_reporting.loop_exception_handler(loop=None, context={"message": "socket closed"})
    latest = runtime_status.latest()
    assert latest is not None
    assert latest.source == "Async task"
    assert latest.message == "socket closed"


def test_loop_exception_handler_defaults_message() -> None:
    error_reporting.loop_exception_handler(loop=None, context={})
    latest = runtime_status.latest()
    assert latest is not None
    assert latest.message == "event loop error"


def test_install_asyncio_handler_without_loop_is_noop() -> None:
    # No running event loop -> silently no-ops (does not raise).
    error_reporting.install_asyncio_handler()


def test_install_asyncio_handler_attaches_to_running_loop() -> None:
    import asyncio

    async def _run() -> object:
        error_reporting.install_asyncio_handler()
        return asyncio.get_running_loop().get_exception_handler()

    handler = asyncio.run(_run())
    assert handler is error_reporting.loop_exception_handler
