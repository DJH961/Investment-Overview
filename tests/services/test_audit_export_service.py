"""Tests for the developer audit-export service."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.config import get_settings
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import accounts_repo, instruments_repo, prices_repo
from investment_dashboard.services import audit_export_service


@pytest.fixture
def seeded(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    vti = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    prices_repo.upsert_closes(session, vti.id, {date.today(): Decimal("230.00")})
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 1, 5),
            kind="buy",
            instrument_id=vti.id,
            quantity=Decimal("10"),
            price_native=Decimal("220"),
            net_native=Decimal("-2200"),
            source=TransactionSource.MANUAL,
        )
    )
    session.flush()


def test_build_audit_export_has_all_dashboard_sections(session: Session, seeded: None) -> None:
    export = audit_export_service.build_audit_export(session)
    assert set(export) == {
        "meta",
        "overview",
        "deposits",
        "transactions",
        "monthly",
        "yearly",
        "analytics",
        "calculator",
    }


def test_build_audit_export_json_is_valid_json(session: Session, seeded: None) -> None:
    payload = audit_export_service.build_audit_export_json(session)
    parsed = json.loads(payload)
    assert parsed["overview"]["metrics"]["as_of"]
    # Raw ledger rows ride along for reconciliation.
    assert parsed["transactions"]["rows"]


def test_audit_export_filename_is_dated() -> None:
    name = audit_export_service.audit_export_filename(date(2024, 3, 2))
    assert name == "audit-export-2024-03-02.json"


def test_dev_password_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INV_DASHBOARD_DEV_PASSWORD", "s3cret")
    get_settings.cache_clear()
    try:
        assert audit_export_service.dev_password_configured() is True
        assert audit_export_service.verify_dev_password("s3cret") is True
        assert audit_export_service.verify_dev_password("nope") is False
        assert audit_export_service.verify_dev_password("") is False
        assert audit_export_service.verify_dev_password(None) is False
    finally:
        get_settings.cache_clear()


def test_dev_password_unset_is_ungated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INV_DASHBOARD_DEV_PASSWORD", raising=False)
    get_settings.cache_clear()
    try:
        assert audit_export_service.dev_password_configured() is False
        # Nothing matches an unconfigured gate, including an empty string.
        assert audit_export_service.verify_dev_password("anything") is False
        assert audit_export_service.verify_dev_password("") is False
    finally:
        get_settings.cache_clear()
