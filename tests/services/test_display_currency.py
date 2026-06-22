"""Tests for the EUR/USD display-currency service introduced in v1.3."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo, fx_repo
from investment_dashboard.services import display_currency_service


def test_default_is_eur(session: Session) -> None:
    assert display_currency_service.get_display_currency(session) == "EUR"


def test_set_and_persist(session: Session) -> None:
    display_currency_service.set_display_currency(session, "USD")
    assert display_currency_service.get_display_currency(session) == "USD"
    display_currency_service.set_display_currency(session, "EUR")
    assert display_currency_service.get_display_currency(session) == "EUR"


def test_rejects_unknown_currency(session: Session) -> None:
    with pytest.raises(ValueError, match="Unsupported display currency"):
        display_currency_service.set_display_currency(session, "GBP")


def test_convert_from_eur_passthrough_when_eur(session: Session) -> None:
    out = display_currency_service.convert_from_eur(session, Decimal("100"), target="EUR")
    assert out == Decimal("100")


def test_convert_from_eur_uses_latest_rate(session: Session) -> None:
    fx_repo.upsert_rates(
        session,
        {
            date(2025, 1, 1): Decimal("1.10"),
            date(2025, 2, 1): Decimal("1.20"),
        },
    )
    out = display_currency_service.convert_from_eur(session, Decimal("100"), target="USD")
    assert out == Decimal("120.00")


def test_unknown_stored_value_falls_back_to_eur(session: Session) -> None:
    # A corrupted / unsupported stored currency degrades to the default.
    app_config_repo.set_value(session, "display_currency", "GBP")
    assert display_currency_service.get_display_currency(session) == "EUR"


def test_convert_from_eur_passthrough_when_no_rate(session: Session) -> None:
    # No FX rate available -> return the input unchanged (degrade gracefully).
    out = display_currency_service.convert_from_eur(session, Decimal("100"), target="USD")
    assert out == Decimal("100")
