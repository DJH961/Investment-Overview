"""Per-session memo for the hot ledger reads ("load the ledger once").

One Overview build used to call ``list_transactions`` 14 times and
``compute_positions`` 7 times on the same session (docs/v6_speed_plan.md §3,
"Rerun"). Wrapping those reads in :func:`memo` makes every repeat within one
session a dictionary lookup, without changing the signatures of the ~24 callers.

Rules:

* Keys must include every argument that changes the result (the caller builds
  the key, e.g. ``("list_transactions", account_id, as_of)``).
* Read paths only. Any flush, commit or rollback on the session clears the memo,
  so a write in the same session is never followed by a stale read.
* Callers must treat memoized results as read-only (they are shared).
"""

from __future__ import annotations

from collections.abc import Callable, Hashable
from typing import Any, TypeVar

from sqlalchemy import event
from sqlalchemy.orm import Session

T = TypeVar("T")

_INFO_KEY = "investment_dashboard.session_memo"


def memo(session: Session, key: tuple[Hashable, ...], fn: Callable[[], T]) -> T:
    """Return ``fn()``, computed at most once per ``key`` until the session changes."""
    store: dict[tuple[Hashable, ...], Any] = session.info.setdefault(_INFO_KEY, {})
    if key in store:
        return store[key]  # type: ignore[no-any-return]
    value = fn()
    store[key] = value
    return value


def clear(session: Session) -> None:
    """Forget everything memoized on ``session``."""
    session.info.pop(_INFO_KEY, None)


@event.listens_for(Session, "after_flush")
def _after_flush(session: Session, _flush_context: object) -> None:
    clear(session)


@event.listens_for(Session, "after_commit")
def _after_commit(session: Session) -> None:
    clear(session)


@event.listens_for(Session, "after_rollback")
def _after_rollback(session: Session) -> None:
    clear(session)
