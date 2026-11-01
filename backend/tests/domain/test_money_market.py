"""Tests for ``domain.money_market``."""

from __future__ import annotations

import pytest
from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain.money_market import (
    MONEY_MARKET_NAV,
    MONEY_MARKET_SYMBOLS,
    SETTLEMENT_EXTERNAL_ID_SUFFIX,
    is_money_market,
    is_settlement_external_id,
    settlement_external_id_for,
)


def test_nav_is_par() -> None:
    assert MONEY_MARKET_NAV == 1


@pytest.mark.parametrize("sym", sorted(MONEY_MARKET_SYMBOLS))
def test_known_symbols_detected_case_and_space_insensitive(sym: str) -> None:
    assert is_money_market(sym)
    assert is_money_market(f"  {sym.lower()} ")


@pytest.mark.parametrize("sym", ["VTI", "AAPL", "", None])
def test_ordinary_symbols_not_money_market(sym: str | None) -> None:
    assert not is_money_market(sym)


def test_name_detection_and_asset_class_ignored() -> None:
    assert is_money_market("XYZ", name="Acme Money Market Fund")
    assert not is_money_market("XYZ", asset_class="mutual_fund", name="Acme Growth Fund")
    assert not is_money_market(None, name=None)


def test_settlement_id_golden() -> None:
    assert settlement_external_id_for("abc-1") == "abc-1:vmfxx"
    assert is_settlement_external_id("abc-1:vmfxx")
    assert not is_settlement_external_id("abc-1")
    assert not is_settlement_external_id(None)


@given(st.text())
def test_settlement_id_round_trip(parent: str) -> None:
    leg = settlement_external_id_for(parent)
    assert is_settlement_external_id(leg)
    assert leg.endswith(SETTLEMENT_EXTERNAL_ID_SUFFIX)
    assert leg.removesuffix(SETTLEMENT_EXTERNAL_ID_SUFFIX) == parent
