"""Golden test: the per-session read memo must not change any report.

Every build runs once with the memo active and once with it switched off (each
memoizing module gets a pass-through), on the same ledger; the outputs must be
identical. Covers overview (EUR + USD), holdings, graphs 1d/1m, periods and
allocations.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal
from typing import Any

import pytest

from investment_dashboard.repositories import fx_repo, prices_repo, transactions_repo
from investment_dashboard.services import positions_service

from ._read_harness import BUILDS, read_ledger, run_build  # noqa: F401


def _no_memo(_session: Any, _key: Any, fn: Any) -> Any:
    return fn()


_TIMESTAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:\+00:00|Z)?")


_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


def _normalise(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _normalise(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_normalise(v) for v in value]
    if isinstance(value, Decimal) or (isinstance(value, str) and _NUMBER.fullmatch(value)):
        return format(Decimal(value).normalize(), "f")  # "0.000000" == "0"
    return value


def _canonical(value: Any) -> str:
    """Stable text of a build; freshness timestamps are masked, numbers compared by value."""
    text = json.dumps(_normalise(value), default=str, sort_keys=True)
    return _TIMESTAMP.sub("<ts>", text)


@pytest.mark.parametrize("name", sorted(BUILDS))
@pytest.mark.usefixtures("read_ledger")
def test_memo_does_not_change_output(name: str, monkeypatch: pytest.MonkeyPatch) -> None:
    with monkeypatch.context() as patch:
        for module in (transactions_repo, fx_repo, prices_repo, positions_service):
            patch.setattr(module, "memo", _no_memo)
        without_memo = _canonical(run_build(name))
    with_memo = _canonical(run_build(name))
    assert with_memo == without_memo
