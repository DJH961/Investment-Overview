"""Fidelity parser integration test against a sample CSV fixture."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from investment_dashboard.adapters.fidelity.parser import parse_fidelity_csv
from investment_dashboard.adapters.importer_types import UnknownActionError

FIXTURE = Path(__file__).parents[1] / "fixtures" / "fidelity_sample.csv"


@pytest.fixture
def sample_rows() -> list:  # type: ignore[type-arg]
    return list(parse_fidelity_csv(FIXTURE.read_text()))


def test_row_count(sample_rows: list) -> None:  # type: ignore[type-arg]
    # 6 real transactions; the trailing blank line is ignored.
    assert len(sample_rows) == 6


def test_buy_row(sample_rows: list) -> None:  # type: ignore[type-arg]
    buy = sample_rows[0]
    assert buy.kind == "buy"
    assert buy.date == date(2024, 1, 5)
    assert buy.settlement_date == date(2024, 1, 7)
    assert buy.symbol == "VTI"
    assert buy.quantity == Decimal("10.00000")
    assert buy.net_native == Decimal("-2205.00")
    # Price recomputed as |amount-fees| / |qty| = 2205/10 = 220.5
    assert buy.price_native == Decimal("220.5")


def test_dividend_cash_row(sample_rows: list) -> None:  # type: ignore[type-arg]
    div = sample_rows[1]
    assert div.kind == "dividend_cash"
    assert div.net_native == Decimal("15.50")


def test_reinvestment_row(sample_rows: list) -> None:  # type: ignore[type-arg]
    reinv = sample_rows[2]
    assert reinv.kind == "dividend_reinvest"
    assert reinv.quantity == Decimal("0.07000")


def test_deposit_row(sample_rows: list) -> None:  # type: ignore[type-arg]
    dep = sample_rows[3]
    assert dep.kind == "deposit"
    assert dep.symbol is None
    assert dep.net_native == Decimal("1000.00")


def test_external_ids_unique(sample_rows: list) -> None:  # type: ignore[type-arg]
    ids = [r.external_id for r in sample_rows]
    assert len(set(ids)) == len(ids)


def test_parser_skips_disclaimer_preamble() -> None:
    """Lines before the header are ignored."""
    content = '"some preamble"\n\nRun Date,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date\n01/05/2024,INTEREST EARNED,,,Cash,,,,,,5.00,5.00,01/05/2024\n'
    rows = list(parse_fidelity_csv(content))
    assert len(rows) == 1
    assert rows[0].kind == "interest"


def test_unknown_action_raises() -> None:
    content = "Run Date,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date\n01/05/2024,MERGER FOOBAR,,,Cash,,,,,,0,0,01/05/2024\n"
    with pytest.raises(UnknownActionError):
        list(parse_fidelity_csv(content))
