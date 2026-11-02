"""Settings schema: parse/dump round trips, bounds, choices."""

from __future__ import annotations

from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain.settings_schema import (
    SettingDef,
    SettingError,
    SettingType,
    bounded,
    check_catalogue,
    coerce,
    dump,
    parse,
    to_json,
)

INT = SettingDef("x.int", SettingType.INT, 5, "s", "Int", min=Decimal(1), max=Decimal(100))
DEC = SettingDef(
    "x.dec",
    SettingType.PERCENT,
    Decimal("0.05"),
    "s",
    "Dec",
    min=Decimal("0.01"),
    max=Decimal("0.2"),
)
BOOL = SettingDef("x.bool", SettingType.BOOL, False, "s", "Bool")
ENUM = SettingDef("x.enum", SettingType.ENUM, "a", "s", "Enum", choices=("a", "b"))
SYMS = SettingDef("x.syms", SettingType.SYMBOL_LIST, (), "s", "Syms")
RATES = SettingDef(
    "x.rates",
    SettingType.PERCENT_LIST,
    (Decimal("0.04"),),
    "s",
    "R",
    min=Decimal("-0.5"),
    max=Decimal("0.4"),
)
MAP = SettingDef("x.map", SettingType.JSON_MAP, {}, "s", "Map")
NULLABLE = SettingDef("x.null", SettingType.PERCENT, None, "s", "N", nullable=True)


@given(st.integers(min_value=1, max_value=100))
def test_int_round_trip(value: int) -> None:
    assert parse(INT, dump(INT, coerce(INT, value))) == value


@given(st.decimals(min_value=Decimal("0.01"), max_value=Decimal("0.2"), places=6))
def test_decimal_round_trip_is_exact(value: Decimal) -> None:
    typed = coerce(DEC, format(value, "f"))
    assert isinstance(typed, Decimal)
    assert parse(DEC, dump(DEC, typed)) == value
    assert to_json(typed) == format(value, "f")


@given(st.integers().filter(lambda v: v < 1 or v > 100))
def test_int_bounds(value: int) -> None:
    with pytest.raises(SettingError):
        coerce(INT, value)


@given(st.lists(st.from_regex(r"[A-Z]{1,5}", fullmatch=True), max_size=10))
def test_symbol_list_round_trip(symbols: list[str]) -> None:
    typed = coerce(SYMS, symbols)
    assert parse(SYMS, dump(SYMS, typed)) == typed


def test_bool_formats_match_legacy_rows() -> None:
    assert dump(BOOL, True) == "1"
    assert parse(BOOL, "0") is False
    assert coerce(BOOL, "true") is True
    with pytest.raises(SettingError):
        coerce(BOOL, "maybe")


def test_floats_are_refused() -> None:
    with pytest.raises(SettingError):
        coerce(DEC, 0.05)


def test_enum_and_strings() -> None:
    assert coerce(ENUM, "b") == "b"
    with pytest.raises(SettingError):
        coerce(ENUM, "c")
    with pytest.raises(SettingError):
        coerce(INT, "1.5")


def test_lists_maps_and_nullables() -> None:
    assert coerce(SYMS, "vti, vxus,VTI") == ("VTI", "VXUS")
    assert coerce(RATES, ["0.04", "0.07"]) == (Decimal("0.04"), Decimal("0.07"))
    with pytest.raises(SettingError):
        coerce(RATES, ["0.9"])
    with pytest.raises(SettingError):
        coerce(RATES, [])
    assert coerce(MAP, '{"Buy":"buy"}') == {"Buy": "buy"}
    assert dump(MAP, {"b": "1", "a": "2"}) == '{"a":"2","b":"1"}'
    assert coerce(NULLABLE, None) is None
    assert coerce(NULLABLE, "") is None
    with pytest.raises(SettingError):
        coerce(INT, None)


def test_env_bound_only_tightens() -> None:
    ceiling = SettingDef("x.c", SettingType.INT, 30, "s", "C", env_bound="ceiling")
    floor = SettingDef("x.f", SettingType.INT, 30, "s", "F", env_bound="floor")
    assert bounded(ceiling, 60, 30) == 30
    assert bounded(ceiling, 10, 30) == 10
    assert bounded(floor, 10, 30) == 30
    assert bounded(INT, 60, 30) == 60


def test_check_catalogue_flags_problems() -> None:
    bad = SettingDef("x.bad", SettingType.INT, 500, "nope", "Bad", max=Decimal(10))
    problems = check_catalogue({"x.bad": bad}, frozenset({"s"}))
    assert any("unknown section" in p for p in problems)
    assert any("default invalid" in p for p in problems)
    assert check_catalogue({"x.int": INT}, frozenset({"s"})) == []
