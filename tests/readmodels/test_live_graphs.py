"""Tests for the live 1D/1W graph springboard export (``readmodels.live_graphs``).

These verify that the desktop's already-captured intraday session is serialised
into the mobile blob as whole-book points in both currencies, with the per-minute
FX divergence preserved (USD booked / FX-free, EUR derived) and the session
metadata the web needs to decide whether the export is fresh enough to springboard.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.readmodels import live_graphs
from investment_dashboard.readmodels._context import build_context
from investment_dashboard.readmodels.mobile_export import build_mobile_export
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instruments_repo,
    intraday_repo,
    prices_repo,
)

# A fixed Monday session so weekday/holiday logic is deterministic; 16:00 ET, closed.
_SESSION_DAY = date(2024, 6, 3)
_NOW = datetime(2024, 6, 3, 20, 0, tzinfo=UTC)


def _seed_usd_holding_with_intraday(session: Session) -> None:
    """A USD-native ETF plus an EUR cash base and two FX-divergent intraday samples."""
    brokerage = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="USD Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    savings = accounts_repo.create_account(
        session,
        broker="savings_bank",
        account_label="Tagesgeld",
        native_currency="EUR",
        account_type="savings",
    )
    acme = instruments_repo.get_or_create(
        session, symbol="ACME", asset_class="etf", native_currency="USD"
    )
    cash = instruments_repo.get_or_create(
        session, symbol="TG-CASH", asset_class="savings", native_currency="EUR"
    )
    prices_repo.upsert_closes(session, acme.id, {_SESSION_DAY: Decimal("100.00")})
    prices_repo.upsert_closes(session, cash.id, {_SESSION_DAY: Decimal("500.00")})
    # Seed FX early *and* on the real "today" so the USD base conversion (which
    # reads today's spot) resolves rather than falling back to the EUR view.
    fx_repo.upsert_rates(
        session,
        {
            date(2024, 1, 1): Decimal("1.10"),
            _SESSION_DAY: Decimal("1.10"),
            date.today(): Decimal("1.10"),
        },
    )
    session.add_all(
        [
            Transaction(
                account_id=brokerage.id,
                instrument_id=acme.id,
                date=_SESSION_DAY,
                kind="buy",
                quantity=Decimal("10"),
                price_native=Decimal("100"),
                net_native=Decimal("-1000.00"),
                net_eur=Decimal("-909.09"),
                net_usd=Decimal("-1000.00"),
                source="manual",
            ),
            Transaction(
                account_id=savings.id,
                instrument_id=cash.id,
                date=_SESSION_DAY,
                kind="buy",
                quantity=Decimal("1"),
                price_native=Decimal("500"),
                net_native=Decimal("-500.00"),
                net_eur=Decimal("-500.00"),
                net_usd=Decimal("-550.00"),
                source="manual",
            ),
        ]
    )
    # Two intraday market-component samples at *different* per-minute FX rates, so
    # the EUR line must move between them even though the USD (booked) line is flat.
    intraday_repo.insert_sample(
        session, datetime(2024, 6, 3, 14, 0), Decimal("909.09"), Decimal("1.10")
    )
    intraday_repo.insert_sample(
        session, datetime(2024, 6, 3, 15, 0), Decimal("892.86"), Decimal("1.12")
    )
    session.flush()


def _is_decimal_string(value: object) -> bool:
    if not isinstance(value, str):
        return False
    Decimal(value)
    return True


def test_live_graphs_exports_day_session_in_both_currencies(session: Session) -> None:
    _seed_usd_holding_with_intraday(session)

    context = build_context(session, as_of=_SESSION_DAY)
    out = live_graphs.build(session, context=context, now=_NOW)

    assert out is not None
    assert isinstance(out["captured_at"], str)
    # Stamped from the injected `now` (not wall-clock) and `Z`-suffixed UTC.
    assert out["captured_at"] == "2024-06-03T20:00:00Z"
    day = out["day"]
    assert day["session_date"] == "2024-06-03"
    assert day["market_open"] is False  # 16:00 ET → closed
    points = day["points"]
    assert len(points) >= 2
    for p in points:
        assert p["t"].endswith("Z")  # unambiguous UTC instant
        assert _is_decimal_string(p["value_eur"])
        assert _is_decimal_string(p["value_usd"])
    # USD is booked / FX-free; EUR carries each point's own rate, so the two lines
    # genuinely diverge (never a uniform rescale).
    assert points[0]["value_eur"] != points[0]["value_usd"]


def test_live_graphs_caps_day_points_and_keeps_endpoints() -> None:
    pts = [{"t": str(i), "value_eur": str(i), "value_usd": str(i)} for i in range(500)]
    capped = live_graphs._downsample(pts, live_graphs.MAX_DAY_POINTS)
    assert len(capped) <= live_graphs.MAX_DAY_POINTS
    assert capped[0] == pts[0]
    assert capped[-1] == pts[-1]


def test_mobile_export_includes_live_graphs_when_intraday_present(session: Session) -> None:
    _seed_usd_holding_with_intraday(session)

    export = build_mobile_export(session, as_of=_SESSION_DAY, now=_NOW)

    assert "live_graphs" in export
    assert export["meta"]["schema_version"] == 2
    assert export["live_graphs"]["day"]["session_date"] == "2024-06-03"


def test_live_graphs_absent_without_intraday_history(session: Session) -> None:
    # No intraday samples captured → nothing worth springboarding → section omitted.
    brokerage = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="USD Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    acme = instruments_repo.get_or_create(
        session, symbol="ACME", asset_class="etf", native_currency="USD"
    )
    prices_repo.upsert_closes(session, acme.id, {_SESSION_DAY: Decimal("100.00")})
    fx_repo.upsert_rates(session, {_SESSION_DAY: Decimal("1.10")})
    session.add(
        Transaction(
            account_id=brokerage.id,
            instrument_id=acme.id,
            date=_SESSION_DAY,
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("100"),
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-909.09"),
            net_usd=Decimal("-1000.00"),
            source="manual",
        )
    )
    session.flush()

    out = live_graphs.build(session, context=build_context(session, as_of=_SESSION_DAY), now=_NOW)
    assert out is None or "day" not in out
