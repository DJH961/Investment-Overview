"""Tests for the regular-investment-amount service (services.investing_power)."""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.services import investing_power_service


def test_amount_defaults_when_unset(session: Session) -> None:
    assert (
        investing_power_service.get_amount_eur(session)
        == investing_power_service.DEFAULT_AMOUNT_EUR
    )


def test_amount_roundtrips_and_rounds_to_cents(session: Session) -> None:
    assert investing_power_service.set_amount_eur(session, Decimal("300")) == Decimal("300.00")
    assert investing_power_service.get_amount_eur(session) == Decimal("300.00")
    # Sub-cent input rounds to the cent.
    assert investing_power_service.set_amount_eur(session, Decimal("12.345")) == Decimal("12.35")


def test_amount_clamps_to_guard_rails(session: Session) -> None:
    # Below the floor clamps up.
    assert investing_power_service.set_amount_eur(session, Decimal("0.10")) == (
        investing_power_service.MIN_AMOUNT_EUR
    )
    # Above the ceiling clamps down.
    assert investing_power_service.set_amount_eur(session, Decimal("99999999")) == (
        investing_power_service.MAX_AMOUNT_EUR
    )


def test_amount_ignores_corrupt_stored_value(session: Session) -> None:
    from investment_dashboard.repositories import app_config_repo

    app_config_repo.set_value(session, "investing_power.amount_eur", "not-a-number")
    assert investing_power_service.get_amount_eur(session) == (
        investing_power_service.DEFAULT_AMOUNT_EUR
    )


def test_amount_ignores_non_positive_stored_value(session: Session) -> None:
    from investment_dashboard.repositories import app_config_repo

    app_config_repo.set_value(session, "investing_power.amount_eur", "-50")
    assert investing_power_service.get_amount_eur(session) == (
        investing_power_service.DEFAULT_AMOUNT_EUR
    )
