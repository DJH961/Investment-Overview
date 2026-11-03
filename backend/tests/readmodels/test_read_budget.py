"""Read-path budget tripwires: wall time per build and "load the ledger once".

The time budget is deliberately generous (the real server DB is slower than this
in-memory-sized ledger); it only trips on an order-of-magnitude regression.
"""

from __future__ import annotations

import time
from collections import Counter
from typing import Any

import pytest

from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import positions_service

from ._read_harness import BUILDS, read_ledger, run_build  # noqa: F401

BUDGET_SECONDS = 0.5


@pytest.mark.parametrize("name", sorted(BUILDS))
@pytest.mark.usefixtures("read_ledger")
def test_build_within_time_budget(name: str) -> None:
    run_build(name)  # warm-up: imports, SQLite page cache
    best = min(_timed(name) for _ in range(3))
    assert best < BUDGET_SECONDS, f"{name} took {best * 1000:.0f} ms (budget 500 ms)"


def _timed(name: str) -> float:
    started = time.perf_counter()
    run_build(name)
    return time.perf_counter() - started


@pytest.mark.parametrize("name", ["overview_eur", "overview_usd"])
@pytest.mark.usefixtures("read_ledger")
def test_ledger_queried_once_per_distinct_request(
    name: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    list_calls: Counter[tuple[Any, ...]] = Counter()
    position_calls: Counter[Any] = Counter()
    real_query = transactions_repo._query_transactions
    real_positions = positions_service._compute_positions

    def counting_query(session: Any, **kw: Any) -> Any:
        list_calls[tuple(sorted((k, str(v)) for k, v in kw.items()))] += 1
        return real_query(session, **kw)

    def counting_positions(session: Any, **kw: Any) -> Any:
        if kw.get("transactions") is None:  # explicit-ledger calls never re-query
            position_calls[str(kw.get("as_of"))] += 1
        return real_positions(session, **kw)

    monkeypatch.setattr(transactions_repo, "_query_transactions", counting_query)
    monkeypatch.setattr(positions_service, "_compute_positions", counting_positions)
    run_build(name)
    assert list_calls, "overview should read the ledger"
    assert max(list_calls.values()) == 1, list_calls
    assert max(position_calls.values()) == 1, position_calls
