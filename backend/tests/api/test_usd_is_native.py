"""GUARD: a USD figure is NEVER a EUR figure converted back to dollars.

An all-USD ledger (USD deposits, an ETF, a mutual fund, USD cash) is built twice:
once with every EUR/USD rate (ECB daily rows and intraday samples) at 1.10 and once
with wildly varying rates (0.8-1.6 by day and by minute). Everything USD must come out
IDENTICAL: no dollar amount may depend on the EUR/USD rate when every holding, cash
balance and cashflow is native USD.

Compared payloads are the read models behind each USD-capable endpoint (called
directly with a pinned ``now`` so the read caches and the wall clock cannot interfere):
overview, holdings, graphs 1D / 1W / every longer range, analytics, and the scheduler's
tick builders. Keys that are *about* the rate (fx, spot, EUR, secondary line, the
currency block) are excluded: those legitimately move with the rate.

Periods, allocations and the calculator have their own test below; projection and the
mobile export are covered by tests/readmodels/test_usd_rate_independence.py.

Limit: a round trip at the *same* rate (eur = usd / r, then eur * r) cancels exactly for
an all-USD book, so it cannot be caught here. Different-rate leaks (ECB vs live vs the
close sample) - the kind that produced wrong numbers - are caught.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from investment_dashboard.config import get_settings
from investment_dashboard.db import dispose_engines, get_ledger_engine, ledger_session_scope
from investment_dashboard.models import ALL_METADATAS, Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import (
    allocations,
    analytics,
    calculator,
    live_graphs,
    periods,
)
from investment_dashboard.readmodels import holdings as holdings_rm
from investment_dashboard.readmodels.overview import build_overview
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instruments_repo,
    intraday_repo,
    prices_repo,
)
from investment_dashboard.services import positions_service, scheduler

D = Decimal
ET = ZoneInfo("America/New_York")
START = date(2026, 8, 28)
LAST_SESSION = date(2026, 11, 13)  # a Friday
TODAY = date(2026, 11, 15)  # the Sunday the test "runs" on
SESSIONS = [date(2026, 11, d) for d in (9, 10, 11, 12, 13)]

#: Keys about the rate / the other currency: they legitimately differ between runs.
_RATE_KEY = re.compile(
    r"(?i)(^|_)(fx|rate|spot|eur|secondary|currency|regime|reopen|observed|investing|"
    r"breakeven|repatriation|rate_move)(_|$)|eur$"
)


def _price(base: str, step: str, i: int) -> Decimal:
    return D(base) + D(step) * i


def _ecb_rate(variant: str, i: int) -> Decimal:
    if variant == "const":
        return D("1.10")
    return D("0.8") + D("0.8") * D((i * 37) % 100) / D(100)  # 0.80 .. 1.59


def _minute_rate(variant: str, k: int) -> Decimal:
    if variant == "const":
        return D("1.10")
    return D("0.8") + D("0.8") * D((k * 53) % 100) / D(100)


def _days() -> list[date]:
    return [START + timedelta(days=i) for i in range((TODAY - START).days + 1)]


def _seed(variant: str) -> None:
    days = _days()
    with ledger_session_scope() as s:
        brokerage = accounts_repo.create_account(
            s,
            broker="fidelity",
            account_label="Main",
            native_currency="USD",
            account_type="brokerage",
        )
        cash = accounts_repo.create_account(
            s, broker="fidelity", account_label="Cash", native_currency="USD", account_type="cash"
        )
        etf = instruments_repo.get_or_create(s, symbol="VTI", asset_class="etf")
        fund = instruments_repo.get_or_create(s, symbol="FXAIX", asset_class="mutual_fund")
        trading = [d for d in days if d.weekday() < 5]
        prices_repo.upsert_closes(
            s, etf.id, {d: _price("100", "0.35", i) for i, d in enumerate(trading)}
        )
        prices_repo.upsert_closes(
            s, fund.id, {d: _price("50", "0.12", i) for i, d in enumerate(trading)}
        )
        fx_repo.upsert_rates(s, {d: _ecb_rate(variant, i) for i, d in enumerate(days)})

        def legs(usd: str, day: date) -> dict[str, Decimal]:
            rate = _ecb_rate(variant, (day - START).days)
            return {
                "net_native": D(usd),
                "net_usd": D(usd),
                "net_eur": (D(usd) / rate).quantize(D("0.01")),
                "fx_rate_to_eur": rate,
            }

        d1, d2, d3 = date(2026, 8, 31), date(2026, 9, 1), date(2026, 10, 15)
        rows = [
            Transaction(
                account_id=brokerage.id,
                date=d1,
                kind="deposit",
                source=TransactionSource.MANUAL,
                **legs("10000", d1),
            ),
            Transaction(
                account_id=cash.id,
                date=d1,
                kind="deposit",
                source=TransactionSource.MANUAL,
                **legs("500", d1),
            ),
            Transaction(
                account_id=brokerage.id,
                date=d2,
                kind="buy",
                source=TransactionSource.MANUAL,
                instrument_id=etf.id,
                quantity=D("20"),
                price_native=_price("100", "0.35", 1),
                **legs(str(-20 * _price("100", "0.35", 1)), d2),
            ),
            Transaction(
                account_id=brokerage.id,
                date=d2,
                kind="buy",
                source=TransactionSource.MANUAL,
                instrument_id=fund.id,
                quantity=D("30"),
                price_native=_price("50", "0.12", 1),
                **legs(str(-30 * _price("50", "0.12", 1)), d2),
            ),
            Transaction(
                account_id=brokerage.id,
                date=d3,
                kind="deposit",
                source=TransactionSource.MANUAL,
                **legs("2000", d3),
            ),
        ]
        s.add_all(rows)
        # Intraday samples for the last five sessions, one every 5 minutes.
        k = 0
        for session_day in SESSIONS:
            open_utc = datetime(
                session_day.year, session_day.month, session_day.day, 9, 30, tzinfo=ET
            ).astimezone(UTC)
            idx = trading.index(session_day)
            base = _price("100", "0.35", idx)
            for j in range(78):
                at = (open_utc + timedelta(minutes=5 * j)).replace(tzinfo=None)
                price_t = base * (D(1) + D("0.0004") * D((j * 7) % 11 - 5))
                fx_t = _minute_rate(variant, k)
                usd = 20 * price_t
                intraday_repo.insert_sample(s, at, usd / fx_t, fx_t, usd)
                k += 1


@contextmanager
def _fresh_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str) -> Iterator[None]:
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(tmp_path / f"{name}.sqlite"))
    for tier in ("LEDGER", "CONFIG", "CACHE"):
        monkeypatch.delenv(f"INV_DASHBOARD_{tier}_PATH", raising=False)
    monkeypatch.setenv("INV_DASHBOARD_SERVER_MODE", "true")
    get_settings.cache_clear()
    dispose_engines()
    engine = get_ledger_engine()
    for metadata in ALL_METADATAS:
        metadata.create_all(engine)
    try:
        yield
    finally:
        from investment_dashboard.services import fx_service

        fx_service.clear_live_spot()  # the guard sets a live spot: never leak it
        dispose_engines()
        get_settings.cache_clear()


def _flatten(value: Any, path: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(value, dict):
        for key, item in value.items():
            if _RATE_KEY.search(str(key)):
                continue
            out.update(_flatten(item, f"{path}.{key}"))
    elif isinstance(value, list):
        for i, item in enumerate(value):
            out.update(_flatten(item, f"{path}[{i}]"))
    else:
        out[path] = value
    return out


def _after_close() -> datetime:
    return datetime(2026, 11, 13, 18, 0, tzinfo=ET).astimezone(UTC)


def _during() -> datetime:
    return datetime(2026, 11, 13, 11, 0, tzinfo=ET).astimezone(UTC)


def _usd_surfaces(variant: str) -> dict[str, dict[str, Any]]:
    """Every USD payload we guard, keyed by a readable name (one DB, one variant)."""
    out: dict[str, dict[str, Any]] = {}
    live_rate = _minute_rate(variant, 999)
    # A live spot unlike the daily ECB rows, so any EUR -> USD round trip across the
    # two rates shows up as a difference between the runs.
    from investment_dashboard.domain.market_hours import exchange_today
    from investment_dashboard.services import fx_service

    fx_service.clear_live_spot()
    fx_service.set_live_spot("USD", live_rate, observed_on=exchange_today())
    with ledger_session_scope() as s:
        for label, now in (("closed", _after_close()), ("open", _during())):
            out[f"overview/{label}"] = build_overview(s, ccy="USD", as_of=LAST_SESSION, now=now)
            out[f"holdings/{label}"] = holdings_rm.build(
                s, ccy="USD", as_of=LAST_SESSION, now=now, group_by="asset_class"
            )
            for rng in ("1d", "1w"):
                out[f"graph/{rng}/{label}"] = live_graphs.build_graph(
                    s, range_key=rng, ccy="USD", compare=False, now=now
                )
        for rng in ("1m", "3m", "6m", "ytd", "1y", "all"):
            out[f"graph/{rng}"] = live_graphs.build_graph(
                s, range_key=rng, ccy="USD", compare=False, now=_after_close()
            )
        out["analytics"] = analytics.build_for_ccy(s, ccy="USD", lookback_days=0)
        # Tick payload builders: the native total, the point and the now point.
        total_usd = positions_service.total_portfolio_value_usd(s, as_of=LAST_SESSION)
        total_eur = positions_service.total_portfolio_value(s, as_of=LAST_SESSION)
        out["tick/total"] = {"usd": str(total_usd)}
        out["tick/estimates"] = scheduler._tick_estimates(
            s, total_eur, live_rate, now=_during(), total_usd=total_usd
        )
        out["tick/now_point"] = {
            "usd": (scheduler._tick_now_point(s, live_rate, _after_close()) or {}).get("USD")
        }
    return out


def _lane_surfaces(variant: str) -> dict[str, Callable[[Any], dict[str, Any]]]:
    return {
        "periods/monthly": lambda s: periods.build_for_ccy(s, monthly=True, ccy="USD"),
        "periods/yearly": lambda s: periods.build_for_ccy(s, monthly=False, ccy="USD"),
        "allocations": lambda s: allocations.build(s, ccy="USD", as_of=LAST_SESSION),
        "calculator/inputs": lambda s: calculator.build_inputs(s, ccy="USD"),
    }


def _lane_values(variant: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    with ledger_session_scope() as s:
        for name, fn in _lane_surfaces(variant).items():
            out[name] = fn(s)
    return out


def _normalise(payload: Any) -> dict[str, Any]:
    flat = _flatten(payload)
    # Round to the cent-ish: only the rate dependence matters, not Decimal noise (1e-20).
    out: dict[str, Any] = {}
    for key, value in flat.items():
        if isinstance(value, str):
            try:
                out[key] = str(round(D(value), 6))
                continue
            except Exception:
                pass
        out[key] = value
    return out


def _run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, variant: str, fn: Callable[[str], Any]
) -> Any:
    with _fresh_db(tmp_path, monkeypatch, variant):
        _seed(variant)
        return fn(variant)


def _diff(a: dict[str, Any], b: dict[str, Any]) -> list[str]:
    keys = sorted(set(a) | set(b))
    return [f"{k}: {a.get(k)!r} != {b.get(k)!r}" for k in keys if a.get(k) != b.get(k)]


def test_usd_surfaces_do_not_depend_on_the_eur_usd_rate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    constant = _run(tmp_path, monkeypatch, "const", _usd_surfaces)
    wild = _run(tmp_path, monkeypatch, "wild", _usd_surfaces)
    assert set(constant) == set(wild)
    problems: list[str] = []
    for name in constant:
        left, right = _normalise(constant[name]), _normalise(wild[name])
        assert left, f"{name} produced no USD numbers to compare"
        problems += [f"[{name}] {line}" for line in _diff(left, right)]
    assert not problems, "\n".join(problems[:40])


def test_periods_allocations_calculator_usd_do_not_depend_on_the_eur_usd_rate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    constant = _run(tmp_path, monkeypatch, "const", _lane_values)
    wild = _run(tmp_path, monkeypatch, "wild", _lane_values)
    problems: list[str] = []
    for name in constant:
        problems += [
            f"[{name}] {line}" for line in _diff(_normalise(constant[name]), _normalise(wild[name]))
        ]
    assert not problems, "\n".join(problems[:40])


def test_snapshot_usd_backfill_is_native_and_leaves_eur_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pre-0017 snapshot rows (no USD) are filled from native positions, never EUR x rate."""
    from investment_dashboard.db import cache_write_session
    from investment_dashboard.repositories import snapshots_repo
    from investment_dashboard.services import snapshots_service

    day = date(2026, 10, 20)
    results = {}
    for variant in ("const", "wild"):
        with _fresh_db(tmp_path, monkeypatch, f"bf-{variant}"):
            _seed(variant)
            with ledger_session_scope() as s:
                with cache_write_session(s) as cache:
                    snapshots_repo.upsert_snapshot(cache, day, D("12345.67"))
                assert snapshots_service.missing_usd_count(s) == 1
                assert snapshots_service.backfill_missing_usd(s) == 1
                assert snapshots_service.missing_usd_count(s) == 0
                native = positions_service.total_portfolio_value_usd(s, as_of=day)
                stored = snapshots_service.stored_usd_in_range(s, day, day)[day]
                assert stored == native
                with cache_write_session(s) as cache:
                    row = snapshots_repo.get_snapshot(cache, day)
                    assert row is not None
                    assert row.total_value_eur == D("12345.67")  # EUR column untouched
                results[variant] = stored
    assert results["const"] == results["wild"]
