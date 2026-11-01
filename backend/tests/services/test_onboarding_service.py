"""Tests for the onboarding seed service introduced in v1.3."""

from __future__ import annotations

from sqlalchemy.orm import Session

from investment_dashboard.repositories import accounts_repo, instruments_repo
from investment_dashboard.services import onboarding_service


def test_is_onboarded_false_on_fresh_db(session: Session) -> None:
    assert onboarding_service.is_onboarded(session) is False


def test_seed_creates_defaults(session: Session) -> None:
    result = onboarding_service.seed_default_setup(session)
    assert result.accounts_created == len(onboarding_service.DEFAULT_ACCOUNTS)
    assert result.instruments_created == len(onboarding_service.DEFAULT_INSTRUMENTS)
    assert onboarding_service.is_onboarded(session) is True
    accounts = list(accounts_repo.list_accounts(session))
    instruments = list(instruments_repo.list_instruments(session))
    assert len(accounts) == len(onboarding_service.DEFAULT_ACCOUNTS)
    assert len(instruments) == len(onboarding_service.DEFAULT_INSTRUMENTS)


def test_seed_is_idempotent(session: Session) -> None:
    onboarding_service.seed_default_setup(session)
    again = onboarding_service.seed_default_setup(session)
    assert again.accounts_created == 0
    assert again.instruments_created == 0
