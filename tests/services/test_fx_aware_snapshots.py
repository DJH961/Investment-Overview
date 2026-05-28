"""Tests for the v2.2 multi-quote / per-currency snapshot helpers."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.adapters.frankfurter_client import FxRateRecord
from investment_dashboard.repositories import fx_repo, snapshots_repo
from investment_dashboard.services import fx_service, snapshots_service


def test_refresh_fx_history_default_targets_usd_and_dkk(session: Session) -> None:
    """``refresh_fx_history`` with no quote args backfills DEFAULT_QUOTES.

    Each quote is fetched independently so a Frankfurter outage on one
    leg doesn't poison the other. We assert both per-quote calls go
    out and both write rows.
    """
    fake_records = {
        "USD": [FxRateRecord(date=date(2026, 5, 1), base="EUR", quote="USD", rate=Decimal("1.10"))],
        "DKK": [FxRateRecord(date=date(2026, 5, 1), base="EUR", quote="DKK", rate=Decimal("7.45"))],
    }

    seen: list[tuple[str, str]] = []

    def _fake_fetch(start, end, *, base, quote):  # type: ignore[no-untyped-def]
        seen.append((base, quote))
        return fake_records[quote]

    with patch.object(fx_service, "fetch_rates", side_effect=_fake_fetch):
        written = fx_service.refresh_fx_history(
            session,
            earliest_needed=date(2026, 5, 1),
            today=date(2026, 5, 1),
        )

    assert written == 2
    assert ("EUR", "USD") in seen
    assert ("EUR", "DKK") in seen
    assert fx_repo.get_rates(session, base="EUR", quote="USD") == {
        date(2026, 5, 1): Decimal("1.10"),
    }
    assert fx_repo.get_rates(session, base="EUR", quote="DKK") == {
        date(2026, 5, 1): Decimal("7.45"),
    }


def test_refresh_fx_history_rejects_both_quote_and_quotes(session: Session) -> None:
    with pytest.raises(ValueError, match="pass either 'quote' or 'quotes'"):
        fx_service.refresh_fx_history(
            session,
            earliest_needed=date(2026, 1, 1),
            quote="USD",
            quotes=("DKK",),
        )


def test_get_or_compute_in_currency_uses_per_date_fx(session: Session) -> None:
    """USD snapshot reflects the FX rate on the snapshot's *own* date.

    Seed an EUR snapshot worth €1000 on 2024-01-15 and store two
    EUR→USD rates: 1.10 on 2024-01-15 and 1.50 today. The legacy code
    would convert via today's spot (giving $1500); the per-date helper
    must return $1100 — what the portfolio was actually worth in USD
    on that date.
    """
    snapshot_date = date(2024, 1, 15)
    snapshots_repo.upsert_snapshot(session, snapshot_date, Decimal("1000"))
    fx_repo.upsert_rates(
        session,
        {
            snapshot_date: Decimal("1.10"),
            date.today(): Decimal("1.50"),
        },
        base="EUR",
        quote="USD",
    )
    session.flush()

    value = snapshots_service.get_or_compute_in_currency(session, snapshot_date, "USD")
    assert value == Decimal("1100.00")


def test_get_or_compute_in_currency_eur_passthrough(session: Session) -> None:
    snapshot_date = date(2024, 6, 1)
    snapshots_repo.upsert_snapshot(session, snapshot_date, Decimal("777.50"))
    session.flush()
    assert snapshots_service.get_or_compute_in_currency(session, snapshot_date, "EUR") == Decimal(
        "777.50"
    )


def test_get_or_compute_in_currency_dkk_forward_fills(session: Session) -> None:
    """If the snapshot date has no DKK rate, the prior business-day rate wins."""
    snapshot_date = date(2024, 3, 4)  # Monday
    snapshots_repo.upsert_snapshot(session, snapshot_date, Decimal("500"))
    # Only a Friday rate exists; forward-fill must pick it up.
    fx_repo.upsert_rates(
        session,
        {date(2024, 3, 1): Decimal("7.45")},
        base="EUR",
        quote="DKK",
    )
    session.flush()

    value = snapshots_service.get_or_compute_in_currency(session, snapshot_date, "DKK")
    assert value == Decimal("3725.00")  # 500 * 7.45


def test_get_or_compute_in_currency_no_rate_returns_eur(session: Session) -> None:
    """With no FX history at all, fall through to the raw EUR value."""
    snapshot_date = date(2024, 7, 1)
    snapshots_repo.upsert_snapshot(session, snapshot_date, Decimal("123.45"))
    session.flush()
    assert snapshots_service.get_or_compute_in_currency(session, snapshot_date, "USD") == Decimal(
        "123.45"
    )
