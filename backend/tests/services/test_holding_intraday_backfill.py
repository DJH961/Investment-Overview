"""Per-holding 1W intraday bar backfill, coverage diagnostics, and repair wiring."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.errors import NotFoundError, ValidationError
from investment_dashboard.models import Transaction
from investment_dashboard.readmodels import diagnostics as diagnostics_rm
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instruments_repo,
    intraday_repo,
    prices_repo,
    symbol_prices_repo,
)
from investment_dashboard.services import diagnostics_service, provider_status
from investment_dashboard.services import intraday_snapshots_service as iss

D = Decimal
_NOW_AFTER_CLOSE = datetime(2024, 6, 3, 21, 0, tzinfo=UTC)  # 17:00 ET Monday


def _five_minute_bars(day: date, price: Decimal | None = None) -> dict[datetime, Decimal]:
    base = price if price is not None else D("100")
    open_at = datetime(day.year, day.month, day.day, 13, 30)
    return {open_at + timedelta(minutes=5 * i): base + D(i % 5) for i in range(79)}


def _fake_bars_fetcher(sessions: list[date], *, with_noise: bool = False):  # type: ignore[no-untyped-def]
    def fake_fetch(symbols: list[str], start_day: date, end_day: date, *, interval: str):  # type: ignore[no-untyped-def]
        out: dict[str, dict[datetime, Decimal]] = {}
        for sym in symbols:
            bars: dict[datetime, Decimal] = {}
            day = start_day
            while day <= end_day:
                if day in sessions:
                    day_bars = _five_minute_bars(day, D("100") if sym == "ACME" else D("50"))
                    if with_noise:
                        first_ts = next(iter(day_bars))
                        day_bars[first_ts] = D("0")
                        day_bars[datetime(day.year, day.month, day.day, 21, 0)] = D("999")
                    bars.update(day_bars)
                day += timedelta(days=1)
            out[sym] = bars
        return out

    return fake_fetch


def _seed_portfolio(session: Session) -> tuple[int, int, int]:
    """Seed two ETFs (ACME, BETA) and one mutual fund (FUNDX) held across the 1W window."""
    acct = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="USD",
        native_currency="USD",
        account_type="brokerage",
    )
    acme = instruments_repo.get_or_create(session, symbol="ACME", asset_class="etf")
    beta = instruments_repo.get_or_create(session, symbol="BETA", asset_class="etf")
    fund = instruments_repo.get_or_create(session, symbol="FUNDX", asset_class="mutual_fund")
    sessions = iss.recent_trading_sessions(_NOW_AFTER_CLOSE)
    buy_day = sessions[0] - timedelta(days=5)
    for instr, px in ((acme, D("100")), (beta, D("50")), (fund, D("200"))):
        session.add(
            Transaction(
                account_id=acct.id,
                instrument_id=instr.id,
                date=buy_day,
                kind="buy",
                quantity=D("10"),
                price_native=px,
                net_native=-D("10") * px,
                source="manual",
            )
        )
        prices_repo.upsert_closes(session, instr.id, {d: px for d in sessions})
    fx_repo.upsert_rates(session, {d: D("1.10") for d in sessions})
    session.flush()
    return acme.id, beta.id, fund.id


def _seed_full_portfolio_curve(session: Session, now: datetime = _NOW_AFTER_CLOSE) -> list[date]:
    sessions = iss.recent_trading_sessions(now)
    for day in sessions:
        for at in _five_minute_bars(day):
            intraday_repo.insert_sample(session, at, D("1500"), Decimal("1.10"), D("1650"))
    session.flush()
    return sessions


def test_missing_holding_bars_detected_and_backfilled_without_touching_portfolio_curve(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider_status.reset()
    _seed_portfolio(session)
    sessions = _seed_full_portfolio_curve(session)
    # Seed a twin row to verify kind="twin" rows are never modified or pruned.
    twin_ts = datetime(sessions[0].year, sessions[0].month, sessions[0].day, 15, 0)
    symbol_prices_repo.upsert_prices(session, "TWN", {twin_ts: D("99")})
    # Seed a stale holding row older than the rolling week window to verify pruning.
    stale_ts = iss.week_window_start_utc(_NOW_AFTER_CLOSE) - timedelta(days=2)
    symbol_prices_repo.upsert_prices(
        session, "ACME", {stale_ts: D("80")}, kind=symbol_prices_repo.KIND_HOLDING
    )
    session.flush()

    # Portfolio graph coverage is already complete across all 5 sessions.
    assert not iss.assess_graph_coverage(session, now=_NOW_AFTER_CLOSE).has_gaps

    # Per-holding coverage detects both held ETFs missing on all 5 finished sessions (not FUNDX).
    cov = iss.assess_holding_intraday_coverage(session, now=_NOW_AFTER_CLOSE)
    assert cov.has_gaps
    assert cov.missing_symbols == ("ACME", "BETA")
    assert cov.missing_days_by_symbol == {
        "ACME": tuple(sessions),
        "BETA": tuple(sessions),
    }

    # Health check surfaces holding_intraday_graph warning with Backfill 1W holding bars action.
    orig_assess = iss.assess_holding_intraday_coverage
    monkeypatch.setattr(
        iss,
        "assess_holding_intraday_coverage",
        lambda s, *, now=_NOW_AFTER_CLOSE: orig_assess(s, now=now),
    )
    monkeypatch.setattr(
        diagnostics_service,
        "_check_fx_live",
        lambda _s, **_kw: diagnostics_service.HealthItem(
            key="fx_live", title="Live EUR/USD rate", severity="ok", count=0, detail="ok"
        ),
    )
    built = diagnostics_rm.build(session)
    check = next(c for c in built["checks"] if c["id"] == "holding_intraday_graph")
    assert check["severity"] == "warning"
    assert check["count"] == 2
    assert check["examples"] == ["ACME", "BETA"]
    assert check["actions"][0]["id"] == "graphs.backfill_holdings"
    assert check["actions"][0]["params"] == {"force": False}

    # Snapshot original portfolio intraday_value rows.
    week_start = iss.week_window_start_utc(_NOW_AFTER_CLOSE)
    before_portfolio = [
        (r.captured_at, r.market_value_eur, r.fx_eur_usd, r.market_value_usd)
        for r in intraday_repo.list_in_range(
            session, week_start, _NOW_AFTER_CLOSE.replace(tzinfo=None)
        )
    ]

    # Mocked fetcher includes an invalid <=0 bar and an after-hours bar that must be filtered out.
    result = iss.backfill_holding_intraday_prices(
        session, now=_NOW_AFTER_CLOSE, fetcher=_fake_bars_fetcher(sessions, with_noise=True)
    )
    assert result["symbols"] == 2
    assert result["days"] == len(sessions)
    assert result["rows_written"] == 2 * len(sessions) * 78  # 79 minus 1 non-positive
    assert result["missing"] == []

    # Portfolio intraday_value is completely untouched.
    after_portfolio = [
        (r.captured_at, r.market_value_eur, r.fx_eur_usd, r.market_value_usd)
        for r in intraday_repo.list_in_range(
            session, week_start, _NOW_AFTER_CLOSE.replace(tzinfo=None)
        )
    ]
    assert after_portfolio == before_portfolio

    # Stale holding price was pruned, twin row was kept, after-hours/non-positive filtered out.
    acme_rows = symbol_prices_repo.prices_in_range(
        session,
        ["ACME"],
        stale_ts - timedelta(days=1),
        _NOW_AFTER_CLOSE.replace(tzinfo=None),
        kind=symbol_prices_repo.KIND_HOLDING,
    )["ACME"]
    assert stale_ts not in acme_rows
    assert all(
        px > 0
        and iss._session_open_utc(iss.session_date_of(t))
        <= t
        <= iss._session_close_utc(iss.session_date_of(t))
        for t, px in acme_rows.items()
    )
    assert symbol_prices_repo.prices_in_range(
        session, ["TWN"], twin_ts, twin_ts, kind=symbol_prices_repo.KIND_TWIN
    ) == {"TWN": {twin_ts: D("99")}}

    # Coverage is now clean -> health check turns ok.
    assert not orig_assess(session, now=_NOW_AFTER_CLOSE).has_gaps
    item = next(
        i
        for i in diagnostics_service.check_health(session).items
        if i.key == "holding_intraday_graph"
    )
    assert item.severity == "ok"
    assert item.count == 0


def test_single_instrument_backfill_and_nav_validation(session: Session) -> None:
    acme_id, _beta_id, fund_id = _seed_portfolio(session)
    sessions = _seed_full_portfolio_curve(session)

    with pytest.raises(NotFoundError):
        iss.backfill_holding_intraday_prices(session, now=_NOW_AFTER_CLOSE, instrument_id=999999)
    with pytest.raises(ValidationError, match="NAV or cash"):
        iss.backfill_holding_intraday_prices(session, now=_NOW_AFTER_CLOSE, instrument_id=fund_id)

    asked: list[list[str]] = []

    def fake_fetch(symbols: list[str], start_day: date, end_day: date, *, interval: str):  # type: ignore[no-untyped-def]
        asked.append(list(symbols))
        bars: dict[datetime, Decimal] = {}
        day = start_day
        while day <= end_day:
            if day in sessions:
                bars.update(_five_minute_bars(day, D("100")))
            day += timedelta(days=1)
        return {sym: dict(bars) for sym in symbols}

    res = iss.backfill_holding_intraday_prices(
        session, now=_NOW_AFTER_CLOSE, instrument_id=acme_id, fetcher=fake_fetch
    )
    assert res == {
        "symbols": 1,
        "days": len(sessions),
        "rows_written": len(sessions) * 79,
        "missing": [],
    }
    assert asked == [["ACME"]]
    # BETA is still missing because only ACME was targeted.
    cov = iss.assess_holding_intraday_coverage(session, now=_NOW_AFTER_CLOSE)
    assert cov.missing_symbols == ("BETA",)

    # Second non-force run for ACME does zero work; force=True re-downloads ACME.
    assert iss.backfill_holding_intraday_prices(
        session, now=_NOW_AFTER_CLOSE, instrument_id=acme_id, force=False, fetcher=fake_fetch
    ) == {"symbols": 0, "days": 0, "rows_written": 0, "missing": []}
    assert len(asked) == 1
    forced = iss.backfill_holding_intraday_prices(
        session, now=_NOW_AFTER_CLOSE, instrument_id=acme_id, force=True, fetcher=fake_fetch
    )
    assert forced["symbols"] == 1
    assert forced["rows_written"] == len(sessions) * 79
    assert len(asked) == 2


def test_open_session_with_portfolio_samples_requires_holding_row(session: Session) -> None:
    _seed_portfolio(session)
    now_open = datetime(2024, 6, 3, 15, 0, tzinfo=UTC)  # 11:00 ET Monday (open)
    sessions = iss.recent_trading_sessions(now_open)
    # Seed finished prior sessions for both portfolio & holdings.
    for day in sessions[:-1]:
        bars = _five_minute_bars(day)
        for at in bars:
            intraday_repo.insert_sample(session, at, D("1500"), D("1.10"), D("1650"))
        for sym in ("ACME", "BETA"):
            symbol_prices_repo.upsert_prices(
                session, sym, bars, kind=symbol_prices_repo.KIND_HOLDING
            )
    # Today's open session already has 2 portfolio samples, but only ACME has a holding row.
    anchor = sessions[-1]
    t1, t2 = (
        datetime(anchor.year, anchor.month, anchor.day, 13, 35),
        datetime(anchor.year, anchor.month, anchor.day, 14, 0),
    )
    intraday_repo.insert_sample(session, t1, D("1500"), D("1.10"), D("1650"))
    intraday_repo.insert_sample(session, t2, D("1505"), D("1.10"), D("1655"))
    symbol_prices_repo.upsert_prices(
        session, "ACME", {t1: D("101")}, kind=symbol_prices_repo.KIND_HOLDING
    )
    session.flush()

    cov = iss.assess_holding_intraday_coverage(session, now=now_open)
    assert cov.missing_symbols == ("BETA",)
    assert cov.missing_days_by_symbol == {"BETA": (anchor,)}


def test_reload_week_graph_tops_up_missing_holding_bars_when_portfolio_curve_cached(
    session: Session,
) -> None:
    _seed_portfolio(session)
    sessions = _seed_full_portfolio_curve(session)
    # Missing all holding bars while intraday_value is already completely full.
    assert iss.assess_holding_intraday_coverage(session, now=_NOW_AFTER_CLOSE).missing_symbols == (
        "ACME",
        "BETA",
    )

    def fake_fetch(symbols: list[str], start_day: date, end_day: date, *, interval: str):  # type: ignore[no-untyped-def]
        bars: dict[datetime, Decimal] = {}
        day = start_day
        while day <= end_day:
            if day in sessions:
                bars.update(_five_minute_bars(day, D("100")))
            day += timedelta(days=1)
        return {sym: dict(bars) for sym in symbols}

    iss.reload_week_graph(session, now=_NOW_AFTER_CLOSE, fetcher=fake_fetch)
    assert not iss.assess_holding_intraday_coverage(session, now=_NOW_AFTER_CLOSE).has_gaps
