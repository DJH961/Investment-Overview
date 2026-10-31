"""Tests for the live 1D/1W graph springboard export (``readmodels.live_graphs``).

These verify that the desktop's already-captured intraday session is serialised
into the mobile blob as whole-book points in both currencies, with the per-minute
FX divergence preserved (USD booked / FX-free, EUR derived) and the session
metadata the web needs to decide whether the export is fresh enough to springboard.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

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


def test_live_graphs_v3_backbone_market_series_is_fx_free_and_aligned(session: Session) -> None:
    _seed_usd_holding_with_intraday(session)

    out = live_graphs.build(session, context=build_context(session, as_of=_SESSION_DAY), now=_NOW)

    assert out is not None
    # Inner schema bumped to 3; the backbone + grid + window are present.
    assert out["schema_version"] == 3
    assert out["grid"] == "30m"
    assert out["session_dates"][-1] == "2024-06-03"
    series = out["market_series"]
    times, native, fx = series["times"], series["value_native"], series["fx_eur_usd"]
    # Columnar + aligned: one cell per instant across all three arrays.
    assert len(times) == len(native) == len(fx) >= 2
    assert all(t.endswith("Z") for t in times)
    # value_native is the FX-free booked (USD) sleeve, recovered as EUR pivot ×
    # that instant's own rate: 909.09 × 1.10 ≈ 1000 and 892.86 × 1.12 ≈ 1000.
    assert native[0] is not None
    assert abs(Decimal(native[0]) - Decimal("1000")) < Decimal("0.01")
    assert native[1] is not None
    assert abs(Decimal(native[1]) - Decimal("1000")) < Decimal("0.05")
    # The per-instant rate is shipped alongside so either currency is recoverable.
    assert [Decimal(f) for f in fx] == [Decimal("1.10"), Decimal("1.12")]


def test_live_graphs_v3_daily_close_native_is_the_settled_sleeve_close(session: Session) -> None:
    _seed_usd_holding_with_intraday(session)

    out = live_graphs.build(session, context=build_context(session, as_of=_SESSION_DAY), now=_NOW)

    assert out is not None
    closes = out["daily_close_native"]
    # The settled sleeve close for the session = its last sample's native value.
    assert _is_decimal_string(closes["2024-06-03"])
    assert abs(Decimal(closes["2024-06-03"]) - Decimal("1000")) < Decimal("0.05")


def test_live_graphs_v3_nav_prices_present_for_nav_holdings(session: Session) -> None:
    _seed_usd_holding_with_intraday(session)

    out = live_graphs.build(session, context=build_context(session, as_of=_SESSION_DAY), now=_NOW)

    assert out is not None
    nav = out["nav_prices"]
    # The non-intraday (NAV/cash) holding rides here, per-day; the intraday ETF
    # never appears (it lives in the backbone instead).
    assert "TG-CASH" in nav
    assert "ACME" not in nav
    assert nav["TG-CASH"] == [["2024-06-03", "500.000000"]]


def _add_vmfxx(session: Session) -> None:
    """A VMFXX money-market settlement leg: 5000 shares bought on the session day."""
    acct = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="Vanguard Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    vmfxx = instruments_repo.get_or_create(
        session, symbol="VMFXX", asset_class="mutual_fund", native_currency="USD"
    )
    session.add(
        Transaction(
            account_id=acct.id,
            instrument_id=vmfxx.id,
            date=_SESSION_DAY,
            kind="buy",
            quantity=Decimal("5000"),
            price_native=Decimal("1"),
            net_native=Decimal("-5000.00"),
            net_eur=Decimal("-4545.45"),
            net_usd=Decimal("-5000.00"),
            source="manual",
        )
    )
    session.flush()


def test_live_graphs_v3_mm_value_native_ships_per_day_par_value(session: Session) -> None:
    _seed_usd_holding_with_intraday(session)
    _add_vmfxx(session)

    out = live_graphs.build(session, context=build_context(session, as_of=_SESSION_DAY), now=_NOW)

    assert out is not None
    mm = out["mm_value_native"]
    # The money-market fund ships its value-as-of each session date (shares × $1
    # par), so the latest settled close is the 5000-share balance.
    assert "VMFXX" in mm
    assert mm["VMFXX"][-1][0] == "2024-06-03"
    assert Decimal(mm["VMFXX"][-1][1]) == Decimal("5000")


def test_live_graphs_v3_mm_value_native_absent_without_money_market(session: Session) -> None:
    _seed_usd_holding_with_intraday(session)

    out = live_graphs.build(session, context=build_context(session, as_of=_SESSION_DAY), now=_NOW)

    assert out is not None
    assert "mm_value_native" not in out


def test_live_graphs_v3_trail_is_downsampled_and_display_only(session: Session) -> None:
    _seed_usd_holding_with_intraday(session)

    out = live_graphs.build(session, context=build_context(session, as_of=_SESSION_DAY), now=_NOW)

    assert out is not None
    trail = out["trail"]
    assert trail["display_only"] is True
    assert 2 <= len(trail["points"]) <= live_graphs.MAX_DAY_POINTS
    for p in trail["points"]:
        assert _is_decimal_string(p["value_eur"])
        assert _is_decimal_string(p["value_usd"])


def test_live_graphs_v3_round_trip_reconstructs_sleeve_value(session: Session) -> None:
    _seed_usd_holding_with_intraday(session)

    out = live_graphs.build(session, context=build_context(session, as_of=_SESSION_DAY), now=_NOW)

    assert out is not None
    series = out["market_series"]
    # Recover the EUR sleeve pivot from the shipped FX-free native value + the
    # per-instant rate and assert it matches the desktop's stored EUR samples
    # within the money precision target (1e-6).
    expected_eur = [Decimal("909.09"), Decimal("892.86")]
    for native, fx, want in zip(
        series["value_native"], series["fx_eur_usd"], expected_eur, strict=True
    ):
        recovered_eur = Decimal(native) / Decimal(fx)
        assert abs(recovered_eur - want) < Decimal("1e-6")


def test_cap_backbone_coarsens_oldest_days_first() -> None:
    # Three sessions of four 30-min samples each (12 cells); cap at 6 should
    # collapse the two oldest days to a single close apiece and keep the newest
    # day's full detail.
    samples: list[tuple[datetime, Decimal, Decimal | None]] = []
    for day in (date(2024, 5, 30), date(2024, 5, 31), date(2024, 6, 3)):
        for hour in (14, 15, 16, 17):
            samples.append(
                (datetime(day.year, day.month, day.day, hour, 0), Decimal(hour), Decimal("1.1"))
            )
    capped = live_graphs._cap_backbone(samples, 6)
    assert len(capped) <= 6
    days = [live_graphs.intraday_snapshots_service.session_date_of(s[0]) for s in capped]
    # Newest day keeps all four; older days collapse to one close each.
    assert days.count(date(2024, 6, 3)) == 4
    assert days.count(date(2024, 5, 31)) == 1
    assert days.count(date(2024, 5, 30)) == 1
    # The kept older-day cell is that day's *close* (last/largest instant).
    kept_530 = next(s for s in capped if s[0].date() == date(2024, 5, 30))
    assert kept_530[0].hour == 17


def test_cap_backbone_passthrough_when_within_cap() -> None:
    samples: list[tuple[datetime, Decimal, Decimal | None]] = [
        (datetime(2024, 6, 3, 14, 0), Decimal("1"), None),
        (datetime(2024, 6, 3, 15, 0), Decimal("2"), None),
    ]
    assert live_graphs._cap_backbone(samples, 80) == samples


def test_resolve_grid_reads_config_and_defaults(session: Session) -> None:
    from investment_dashboard.repositories import app_config_repo

    assert live_graphs.resolve_grid(session) == "30m"
    app_config_repo.set_value(session, "live_graphs_grid", "15m")
    assert live_graphs.resolve_grid(session) == "15m"
    # An unrecognised value falls back to the safe default.
    app_config_repo.set_value(session, "live_graphs_grid", "1m")
    assert live_graphs.resolve_grid(session) == "30m"


def test_market_series_threads_grid_to_week_fetch(session: Session, monkeypatch) -> None:
    _seed_usd_holding_with_intraday(session)
    from investment_dashboard.repositories import app_config_repo

    app_config_repo.set_value(session, "live_graphs_grid", "15m")
    captured: dict[str, str] = {}

    real = live_graphs.intraday_snapshots_service.week_series_with_fx

    def spy(*args: Any, **kwargs: Any) -> list[tuple[datetime, Decimal, Decimal | None]]:
        captured["interval"] = kwargs.get("interval", "")
        return real(*args, **kwargs)

    monkeypatch.setattr(live_graphs.intraday_snapshots_service, "week_series_with_fx", spy)
    out = live_graphs.build(session, context=build_context(session, as_of=_SESSION_DAY), now=_NOW)

    assert out is not None
    assert out["grid"] == "15m"
    assert captured["interval"] == "15m"


def test_live_graphs_v3_is_absent_tolerant_for_legacy_readers(session: Session) -> None:
    # A reader that only knows v1/v2 reads `day`/`week` and ignores the rest; the
    # v3 export must still carry those legacy curves unchanged.
    _seed_usd_holding_with_intraday(session)

    out = live_graphs.build(session, context=build_context(session, as_of=_SESSION_DAY), now=_NOW)

    assert out is not None
    assert out["day"]["session_date"] == "2024-06-03"
    assert out["week"]["end_date"] == "2024-06-03"
    assert len(out["day"]["points"]) >= 2


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
