"""Ledger completeness (v7 P7): split and share-count hints, table-driven."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from investment_dashboard.domain import ledger_completeness as lc

D = Decimal


def _buy(day: date, qty: str = "10", account: int = 1) -> lc.LedgerEvent:
    return lc.LedgerEvent(date=day, kind="buy", quantity=D(qty), account_id=account)


def _split(day: date, added: str, account: int = 1) -> lc.LedgerEvent:
    return lc.LedgerEvent(date=day, kind="split", quantity=D(added), account_id=account)


def test_ledger_split_row_becomes_a_ratio() -> None:
    events = [_buy(date(2024, 1, 2)), _split(date(2024, 6, 10), "30")]
    assert lc.ledger_splits(events) == [lc.LedgerSplit(date(2024, 6, 10), D("4"))]


def test_same_split_in_two_accounts_collapses() -> None:
    events = [
        _buy(date(2024, 1, 2), "10", 1),
        _buy(date(2024, 1, 2), "20", 2),
        _split(date(2024, 6, 10), "10", 1),
        _split(date(2024, 6, 10), "20", 2),
    ]
    assert lc.ledger_splits(events) == [lc.LedgerSplit(date(2024, 6, 10), D("2"))]


PROVIDER = [(date(2024, 6, 10), D("4"))]


@pytest.mark.parametrize(
    ("events", "expected_missing"),
    [
        # held, no ledger split row: reported
        ([_buy(date(2024, 1, 2))], 1),
        # exact match: clear
        ([_buy(date(2024, 1, 2)), _split(date(2024, 6, 10), "30")], 0),
        # ledger split three days late: still a match
        ([_buy(date(2024, 1, 2)), _split(date(2024, 6, 13), "30")], 0),
        # four days late: no match
        ([_buy(date(2024, 1, 2)), _split(date(2024, 6, 14), "30")], 1),
        # right date, wrong ratio (2-for-1 instead of 4-for-1)
        ([_buy(date(2024, 1, 2)), _split(date(2024, 6, 10), "10")], 1),
        # nothing held on the split date (bought afterwards)
        ([_buy(date(2024, 7, 1))], 0),
        # sold out before the split
        ([_buy(date(2024, 1, 2)), lc.LedgerEvent(date(2024, 3, 1), "sell", D("-10"), 1)], 0),
    ],
)
def test_missing_splits_table(events: list[lc.LedgerEvent], expected_missing: int) -> None:
    assert len(lc.find_missing_splits(PROVIDER, events)) == expected_missing


def test_missing_split_reports_shares_held() -> None:
    out = lc.find_missing_splits(PROVIDER, [_buy(date(2024, 1, 2), "7")])
    assert out == [lc.MissingSplit(date(2024, 6, 10), D("4"), D("7"))]


def test_unit_ratio_provider_split_is_ignored() -> None:
    assert lc.find_missing_splits([(date(2024, 6, 10), D("1"))], [_buy(date(2024, 1, 2))]) == []


def test_ledger_split_without_provider_split_is_a_soft_hint() -> None:
    events = [_buy(date(2024, 1, 2)), _split(date(2024, 6, 10), "30")]
    assert lc.find_unmatched_ledger_splits([], events) == [
        lc.LedgerSplit(date(2024, 6, 10), D("4"))
    ]
    assert lc.find_unmatched_ledger_splits(PROVIDER, events) == []


@pytest.mark.parametrize(
    ("typed", "expected"),
    [
        ("12.5", 0),
        ("12.5001", 0),  # inside the 0.0001 tolerance
        ("12.50011", 1),
        ("13", 1),
        ("0", 1),
    ],
)
def test_share_count_tolerance(typed: str, expected: int) -> None:
    totals = lc.ledger_share_totals({7: [_buy(date(2024, 1, 2), "12.5", account=3)]})
    assert totals == {(3, 7): D("12.5")}
    assert len(lc.find_share_count_mismatches(totals, {(3, 7): D(typed)})) == expected


def test_typed_count_with_no_ledger_rows_compares_against_zero() -> None:
    out = lc.find_share_count_mismatches({}, {(1, 2): D("5")})
    assert out == [lc.ShareCountMismatch(1, 2, D("0"), D("5"))]


def test_nothing_typed_means_nothing_to_report() -> None:
    assert lc.find_share_count_mismatches({(1, 2): D("5")}, {}) == []
