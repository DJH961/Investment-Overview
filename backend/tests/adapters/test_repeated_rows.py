"""Identical rows in one file are distinct transactions (second-pass audit B-023)."""

from __future__ import annotations

from investment_dashboard.adapters.fidelity.parser import parse_fidelity_csv

HEADER = (
    "Run Date,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),"
    "Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date\n"
)
BUY = "01/05/2024,YOU BOUGHT FAKE FUND,FAKE1,FAKE FUND,Cash,1.00000,10.00,0.00,0.00,0.00,-10.00,5.00,01/07/2024\n"


def test_two_identical_buys_get_distinct_external_ids() -> None:
    rows = parse_fidelity_csv(HEADER + BUY + BUY).rows
    assert len(rows) == 2
    assert rows[0].external_id != rows[1].external_id


def test_first_occurrence_id_is_unchanged_and_numbering_is_stable() -> None:
    once = parse_fidelity_csv(HEADER + BUY).rows
    twice = parse_fidelity_csv(HEADER + BUY + BUY).rows
    assert twice[0].external_id == once[0].external_id  # already-imported rows still match
    assert [r.external_id for r in twice] == [
        r.external_id for r in parse_fidelity_csv(HEADER + BUY + BUY).rows
    ]
