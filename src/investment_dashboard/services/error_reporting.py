"""Catch failures that never reach :mod:`logging`, and surface them in-app.

The logging handler in :mod:`investment_dashboard.logging` already mirrors every
``WARNING``/``ERROR`` log record into
:mod:`investment_dashboard.services.runtime_status` (toast + Data Health). That
covers anything that goes through ``logging`` — but some failures don't:

* an **uncaught exception** on the main thread (``sys.excepthook``), a worker
  thread (``threading.excepthook``), or an unretrieved object's finalizer
  (``sys.unraisablehook``);
* an **exception inside the asyncio event loop** that NiceGUI/uvicorn runs;
* a library that writes a **bare traceback or message straight to ``stderr``**
  instead of logging it.

:func:`install` wires all of these into the same tracker so they show up in the
browser too, while still being written to the log (so the on-disk record and the
support bundle stay complete). It is idempotent and reversible
(:func:`uninstall`) so tests can opt in and clean up.

Avoiding double-reporting: the hooks log with ``extra={"runtime_status_skip"}``
so the logging handler doesn't *also* record them, and the ``stderr`` tee wraps
the stream *after* :func:`configure_logging` has bound its ``StreamHandler`` to
the original stream — so normal log output bypasses the tee entirely and only
genuinely stray writes are captured.
"""

from __future__ import annotations

import logging
import sys
import threading
from types import TracebackType
from typing import Any, TextIO

log = logging.getLogger(__name__)

#: Skip marker so our own log calls aren't re-recorded by the logging handler.
_SKIP = {"runtime_status_skip": True}

_install_lock = threading.Lock()
_state: dict[str, Any] = {"installed": False}

#: Saved originals, restored by :func:`uninstall`. Boxed in a dict so the
#: install/uninstall helpers need no ``global`` statements.
_saved: dict[str, Any] = {}


def _record(source: str, message: str) -> None:
    """Best-effort push into the in-app tracker; never raise."""
    try:
        from investment_dashboard.services import runtime_status  # noqa: PLC0415

        runtime_status.record_error(source, message)
    except Exception:  # pragma: no cover - reporting must never crash a hook
        pass


def _describe(exc: BaseException) -> str:
    text = str(exc).strip()
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


def _handle_uncaught(
    source: str,
    exc_type: type[BaseException],
    exc_value: BaseException | None,
    exc_tb: TracebackType | None,
) -> None:
    """Log (to file + stderr) and record one uncaught exception."""
    if exc_value is None:
        return
    # Let KeyboardInterrupt fall through to the default behaviour untouched.
    if issubclass(exc_type, KeyboardInterrupt):
        orig = _saved.get("excepthook")
        if orig is not None:
            orig(exc_type, exc_value, exc_tb)
        return
    log.error(
        "Uncaught exception (%s)",
        source,
        exc_info=(exc_type, exc_value, exc_tb),
        extra=_SKIP,
    )
    _record(source, _describe(exc_value))


def _excepthook(
    exc_type: type[BaseException],
    exc_value: BaseException,
    exc_tb: TracebackType | None,
) -> None:
    _handle_uncaught("Unexpected error", exc_type, exc_value, exc_tb)


def _threading_excepthook(args: threading.ExceptHookArgs) -> None:
    if args.exc_value is None:
        return
    thread_name = args.thread.name if args.thread is not None else "thread"
    _handle_uncaught(
        f"Background thread ({thread_name})",
        args.exc_type,
        args.exc_value,
        args.exc_traceback,
    )


def _unraisablehook(unraisable: Any) -> None:
    exc_value = unraisable.exc_value
    if exc_value is None:
        return
    where = getattr(unraisable, "object", None)
    log.error(
        "Unraisable exception in %r",
        where,
        exc_info=(unraisable.exc_type, exc_value, unraisable.exc_traceback),
        extra=_SKIP,
    )
    _record("Unraisable error", _describe(exc_value))


def loop_exception_handler(loop: Any, context: dict[str, Any]) -> None:
    """asyncio loop handler: log the failure and record it for the UI.

    Mirrors asyncio's default behaviour (which logs at ``ERROR``) but tags the
    log record so the logging handler doesn't double-record, and pushes a
    friendly ``Async task`` entry into the tracker itself.
    """
    exc = context.get("exception")
    message = context.get("message") or "event loop error"
    if isinstance(exc, BaseException):
        log.error("asyncio: %s", message, exc_info=exc, extra=_SKIP)
        _record("Async task", _describe(exc))
    else:
        log.error("asyncio: %s", message, extra=_SKIP)
        _record("Async task", str(message))


def install_asyncio_handler() -> None:
    """Attach :func:`loop_exception_handler` to the running event loop.

    Call this from within the loop (e.g. a NiceGUI ``app.on_startup`` hook) so a
    running loop exists. Safe to call when no loop is running (it no-ops).
    """
    import asyncio  # noqa: PLC0415

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover - no running loop (e.g. at shutdown)
        return
    loop.set_exception_handler(loop_exception_handler)


class _StderrTee:
    """Wrap ``stderr`` to record genuinely stray writes while forwarding them.

    Normal ``logging`` output never reaches here (its ``StreamHandler`` keeps a
    reference to the *original* stream captured before this wrapper is
    installed), so what's left is bare ``print``/traceback writes from libraries.
    Writes are buffered until a newline and each complete chunk is recorded as a
    single ``stderr`` entry, so a multi-line traceback is one event rather than
    dozens; identical chunks are de-duplicated by the tracker itself.
    """

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream
        self._buffer = ""
        self._lock = threading.Lock()

    def write(self, data: str) -> int:
        # Always forward first so the launcher's log tee / console are unaffected.
        written = self._stream.write(data)
        try:
            with self._lock:
                self._buffer += data
                if "\n" in self._buffer:
                    head, _, tail = self._buffer.rpartition("\n")
                    self._buffer = tail
                    chunk = head.strip()
            if "\n" in data and chunk:
                _record("stderr", chunk)
        except Exception:  # pragma: no cover - never break a write
            pass
        return written

    def flush(self) -> None:
        self._stream.flush()

    def __getattr__(self, name: str) -> Any:
        # Delegate isatty/fileno/encoding/etc. to the wrapped stream.
        return getattr(self._stream, name)


def install() -> None:
    """Route uncaught exceptions and stray ``stderr`` writes into the tracker.

    Idempotent. Call once, *after* :func:`configure_logging`, so the ``stderr``
    tee doesn't capture normal log output.
    """
    with _install_lock:
        if _state["installed"]:
            return
        _saved["excepthook"] = sys.excepthook
        _saved["threading_excepthook"] = threading.excepthook
        _saved["unraisablehook"] = sys.unraisablehook
        sys.excepthook = _excepthook
        threading.excepthook = _threading_excepthook
        sys.unraisablehook = _unraisablehook
        if sys.stderr is not None and not isinstance(sys.stderr, _StderrTee):
            _saved["stderr"] = sys.stderr
            sys.stderr = _StderrTee(sys.stderr)
        _state["installed"] = True


def uninstall() -> None:
    """Restore the original hooks/stream. Mainly for tests."""
    with _install_lock:
        if not _state["installed"]:
            return
        if "excepthook" in _saved:
            sys.excepthook = _saved["excepthook"]
        if "threading_excepthook" in _saved:
            threading.excepthook = _saved["threading_excepthook"]
        if "unraisablehook" in _saved:
            sys.unraisablehook = _saved["unraisablehook"]
        if "stderr" in _saved and isinstance(sys.stderr, _StderrTee):
            sys.stderr = _saved["stderr"]
        _saved.clear()
        _state["installed"] = False
