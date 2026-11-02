"""Module constants follow their settings once one is set (S5/S6 wiring)."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.domain.instruments import is_money_market_effective
from investment_dashboard.domain.money_market import is_money_market
from investment_dashboard.domain.settings_schema import dump
from investment_dashboard.repositories import app_config_repo
from investment_dashboard.services import (
    diagnostics_service,
    fx_service,
    import_staging,
    prices_service,
    scheduler,
    settings_registry,
    settings_service,
)


def _set(session: Session, key: str, value: object) -> None:
    defn = settings_registry.BY_KEY[key]
    app_config_repo.set_value(session, key, dump(defn, value))  # type: ignore[arg-type]
    session.flush()


def test_get_or_prefers_the_constant_until_set(session: Session) -> None:
    assert settings_service.get_or("risk.var_alpha", Decimal("0.01"), session) == Decimal("0.01")
    _set(session, "risk.var_alpha", Decimal("0.1"))
    assert settings_service.get_or("risk.var_alpha", Decimal("0.01"), session) == Decimal("0.1")


def test_price_ttls(session: Session) -> None:
    assert prices_service.ttl_seconds_by_class(session)["etf"] == 120
    _set(session, "prices.ttl_seconds.etf", 600)
    ttls = prices_service.ttl_seconds_by_class(session)
    assert ttls["etf"] == 600
    assert ttls["default"] == 24 * 3600


def test_tracked_fx_quotes(session: Session) -> None:
    assert fx_service.tracked_quotes(session) == ("USD",)
    _set(session, "fx.tracked_quotes", ("USD", "GBP"))
    assert fx_service.tracked_quotes(session) == ("USD", "GBP")


def test_import_limits_follow_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    values = {"import.max_upload_mb": 2, "import.staging_ttl_minutes": 5}
    monkeypatch.setattr(settings_service, "get_or", lambda k, f, s=None: values.get(k, f))
    assert import_staging.max_upload_bytes() == 2 * 1024 * 1024
    assert import_staging.staging_ttl() == timedelta(minutes=5)
    monkeypatch.setattr(settings_service, "get_or", lambda _k, f, s=None: f)
    assert import_staging.max_upload_bytes() == import_staging.MAX_UPLOAD_BYTES


def test_scheduler_fx_interval(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings_service, "get_or", lambda _k, f, s=None: 12)
    assert scheduler.default_fx_interval() == timedelta(minutes=12)
    monkeypatch.setattr(settings_service, "get_or", lambda _k, f, s=None: f)
    assert scheduler.default_fx_interval() == scheduler.FX_INTERVAL


def test_frozen_leg_tolerance_parameter() -> None:
    assert diagnostics_service._leg_differs(Decimal("100"), Decimal("100.6"))
    assert not diagnostics_service._leg_differs(Decimal("100"), Decimal("100.6"), Decimal("0.01"))


def test_money_market_extra_symbols() -> None:
    assert not is_money_market("ABCXX")
    assert is_money_market("abcxx", extra_symbols=("ABCXX",))

    class _I:
        symbol = "ABCXX"
        asset_class = "mutual_fund"
        name = "Fund"

    assert is_money_market_effective(_I(), None, extra_symbols=frozenset({"ABCXX"}))
