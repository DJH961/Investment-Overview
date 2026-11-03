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

The implementation lives in :mod:`investment_dashboard.db` (outside the layered
packages) so ``repositories`` can memoize too without importing ``services``;
this module keeps the public API.
"""

from __future__ import annotations

from investment_dashboard.db import clear_memo as clear
from investment_dashboard.db import memo

__all__ = ["clear", "memo"]
