"""B-013: the `/both` builds share one currency-independent pass; results are unchanged.

Overview and graph payloads built for both currencies from one shared pass must
equal the independent single-currency builds exactly (same `now`, same ledger).
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.readmodels import live_graphs, overview

from ._read_harness import read_ledger  # noqa: F401

NOW = datetime(2026, 10, 30, 21, 0, tzinfo=UTC)


def test_overview_both_equals_the_single_builds(read_ledger: None) -> None:  # noqa: F811
    with ledger_session_scope() as session:
        both = overview.build_overview_both(session, now=NOW)
    for ccy in ("EUR", "USD"):
        with ledger_session_scope() as session:
            single = overview.build_overview(session, ccy=ccy, now=NOW)
        assert both[ccy] == single


@pytest.mark.parametrize("range_key", ["1d", "1m", "1y"])
def test_graph_both_with_a_shared_memo_equals_the_single_builds(
    read_ledger: None,  # noqa: F811
    range_key: str,
) -> None:
    memo: dict[object, object] = {}
    with ledger_session_scope() as session:
        both = {
            c: live_graphs.build_graph(
                session, range_key=range_key, ccy=c, compare=True, now=NOW, memo=memo
            )
            for c in ("EUR", "USD")
        }
    for ccy in ("EUR", "USD"):
        with ledger_session_scope() as session:
            single = live_graphs.build_graph(
                session, range_key=range_key, ccy=ccy, compare=True, now=NOW
            )
        assert both[ccy] == single


def test_shared_graph_memo_builds_each_series_once(
    read_ledger: None,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    real = live_graphs._graph_points

    def counting(*args: object, **kwargs: object) -> object:
        calls.append(str(kwargs["ccy"]))
        return real(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(live_graphs, "_graph_points", counting)
    memo: dict[object, object] = {}
    with ledger_session_scope() as session:
        for c in ("EUR", "USD"):
            live_graphs.build_graph(session, range_key="1m", ccy=c, now=NOW, memo=memo)
    assert sorted(calls) == ["EUR", "USD"]  # before: EUR, USD, USD, EUR
