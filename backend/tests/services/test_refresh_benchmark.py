"""Synthetic benchmark of the per-minute live tick (7.3.1 phase 4).

Runs the scheduler's real ``default_tick_job`` (``auto_refresh.tick_refresh`` plus the
tick payload) end to end on a synthetic on-disk ledger, with yfinance replaced by a
fake that sleeps a fixed latency per request and the clock frozen inside a US
session. No real data, no network.

The default latencies are scaled down so the test stays fast. To read realistic
numbers, run it with ``INV_BENCH_LATENCY_SCALE=1`` (one yfinance request ~250 ms, one
``Ticker.info`` ~350 ms) and ``-s`` to see the step timings it prints::

    INV_BENCH_LATENCY_SCALE=1 uv run pytest tests/services/test_refresh_benchmark.py -s
"""

from __future__ import annotations

import os
import sys
import threading
import time
from collections import Counter
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, timedelta
from datetime import date as real_date
from datetime import datetime as real_datetime
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pandas as pd
import pytest

from investment_dashboard.config import get_settings
from investment_dashboard.db import dispose_engines, get_ledger_engine, ledger_session_scope
from investment_dashboard.models import ALL_METADATAS, Transaction
from investment_dashboard.models.transaction import TransactionSource

D = Decimal
SCALE = float(os.environ.get("INV_BENCH_LATENCY_SCALE", "0.02"))
#: One yfinance chart request (a daily or intraday window for one symbol).
HISTORY_LATENCY = 0.25 * SCALE
#: One ``Ticker.info`` (quoteSummary) request.
INFO_LATENCY = 0.35 * SCALE

#: Monday 23 Nov 2026, 10:30 New York: the US session and the FX market are open.
FROZEN_START = real_datetime(2026, 11, 23, 15, 30, tzinfo=UTC)
TODAY = real_date(2026, 11, 23)
STOCKS = ("AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH")
FUNDS = {"FUNDA": "TWNA", "FUNDB": "TWNB"}
NAV_SYMBOLS = frozenset(FUNDS)


# --- frozen clock ------------------------------------------------------------------


class _Clock:
    now = FROZEN_START


class _DateTimeMeta(type):
    def __instancecheck__(cls, obj: object) -> bool:
        return isinstance(obj, real_datetime)


class _DateMeta(type):
    def __instancecheck__(cls, obj: object) -> bool:
        return isinstance(obj, real_date)


class FrozenDateTime(real_datetime, metaclass=_DateTimeMeta):
    @classmethod
    def now(cls, tz: Any = None) -> real_datetime:  # type: ignore[override]
        at = _Clock.now
        return at.astimezone(tz) if tz is not None else at.replace(tzinfo=None)

    @classmethod
    def utcnow(cls) -> real_datetime:  # type: ignore[override]
        return _Clock.now.replace(tzinfo=None)


class FrozenDate(real_date, metaclass=_DateMeta):
    @classmethod
    def today(cls) -> real_date:  # type: ignore[override]
        return _Clock.now.date()


def _freeze(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, module in list(sys.modules.items()):
        if not name.startswith("investment_dashboard") or module is None:
            continue
        if getattr(module, "datetime", None) is real_datetime:
            monkeypatch.setattr(module, "datetime", FrozenDateTime)
        if getattr(module, "date", None) is real_date:
            monkeypatch.setattr(module, "date", FrozenDate)


# --- fake yfinance ------------------------------------------------------------------


def _price(symbol: str, day: real_date, minute: int = 0) -> float:
    if symbol == "EURUSD=X":
        return round(1.16 + minute * 0.00001, 6)
    base = 50 + sum(map(ord, symbol)) % 150
    return round(base + (day.toordinal() % 7) * 0.5 + minute * 0.01, 4)


def _weekdays(start: real_date, end: real_date) -> list[real_date]:
    days = []
    d = start
    while d < end:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    return days


def _symbol_frame(symbol: str, start: str, end: str, interval: str) -> pd.DataFrame:
    now = _Clock.now
    s, e = real_date.fromisoformat(start), real_date.fromisoformat(end)
    rows: dict[Any, float] = {}
    if interval == "1d":
        for d in _weekdays(s, e):
            if d > now.date():
                continue
            if d == now.date() and (symbol in NAV_SYMBOLS or now.hour < 14):
                continue
            rows[pd.Timestamp(d)] = _price(symbol, d)
    else:
        if symbol in NAV_SYMBOLS:
            return pd.DataFrame()
        step = int(interval.rstrip("m"))
        for d in _weekdays(s, e):
            at = real_datetime(d.year, d.month, d.day, 14, 30, tzinfo=UTC)
            close = real_datetime(d.year, d.month, d.day, 21, 0, tzinfo=UTC)
            minute = 0
            while at < min(close, now):
                rows[pd.Timestamp(at)] = _price(symbol, d, minute)
                at += timedelta(minutes=step)
                minute += step
    if not rows:
        return pd.DataFrame()
    return pd.DataFrame({"Close": list(rows.values())}, index=pd.DatetimeIndex(list(rows)))


class FakeYF:
    """Stand-in for the ``yfinance`` module: sleeps per request and counts calls."""

    def __init__(self) -> None:
        self.calls: Counter[str] = Counter()
        self._lock = threading.Lock()

    def _count(self, kind: str) -> None:
        with self._lock:
            self.calls[kind] += 1

    def _one(self, symbol: str, start: str, end: str, interval: str) -> pd.DataFrame:
        self._count(f"chart:{interval}")
        time.sleep(HISTORY_LATENCY)
        return _symbol_frame(symbol, start, end, interval)

    def download(
        self,
        *,
        tickers: list[str],
        start: str,
        end: str,
        interval: str = "1d",
        threads: bool = False,
        **_: Any,
    ) -> pd.DataFrame:
        self._count("download")
        if threads:
            with ThreadPoolExecutor(max_workers=8) as pool:
                frames = list(pool.map(lambda s: self._one(s, start, end, interval), tickers))
        else:
            frames = [self._one(s, start, end, interval) for s in tickers]
        parts = {s: f for s, f in zip(tickers, frames, strict=True) if not f.empty}
        if not parts:
            return pd.DataFrame()
        return pd.concat(parts, axis=1)

    def Ticker(self, symbol: str) -> Any:
        fake = self

        class _Ticker:
            def __init__(self) -> None:
                self._price_history: Any = None

            @property
            def info(self) -> dict[str, Any]:
                fake._count("info")
                time.sleep(INFO_LATENCY)
                return {"regularMarketTime": int(_Clock.now.timestamp()) - 30}

            def history(
                self, *, start: str, end: str, interval: str = "1d", **_: Any
            ) -> pd.DataFrame:
                frame = fake._one(symbol, start, end, interval)
                meta = {"regularMarketTime": int(_Clock.now.timestamp()) - 30}
                self._price_history = SimpleNamespace(_history_metadata=meta)
                if not frame.empty and interval == "1d":
                    frame.index = frame.index.tz_localize("America/New_York")
                return frame

        return _Ticker()


# --- synthetic ledger -------------------------------------------------------------


def _seed() -> None:
    from investment_dashboard.repositories import (
        accounts_repo,
        fx_repo,
        instrument_overrides_repo,
        instruments_repo,
        prices_repo,
    )

    first = real_date(2025, 1, 2)
    with ledger_session_scope() as session:
        account = accounts_repo.create_account(
            session,
            broker="fidelity",
            account_label="Brokerage",
            native_currency="USD",
            account_type="brokerage",
        )
        history = _weekdays(TODAY - timedelta(days=21), TODAY)
        txns = [
            Transaction(
                account_id=account.id,
                date=first,
                kind="deposit",
                source=TransactionSource.MANUAL,
                net_native=D("100000"),
                net_usd=D("100000"),
                net_eur=D("90000"),
                fx_rate_to_eur=D("1.11"),
            )
        ]
        symbols = [(s, "stock") for s in STOCKS] + [(f, "mutual_fund") for f in FUNDS]
        for symbol, asset_class in symbols:
            instr = instruments_repo.get_or_create(session, symbol=symbol, asset_class=asset_class)
            if symbol in FUNDS:
                instrument_overrides_repo.upsert(session, instr.id, intraday_twin=FUNDS[symbol])
            prices_repo.upsert_closes(
                session,
                instr.id,
                {first: D("50")} | {d: D(repr(_price(symbol, d))) for d in history},
            )
            txns.append(
                Transaction(
                    account_id=account.id,
                    date=first + timedelta(days=3),
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    instrument_id=instr.id,
                    quantity=D("10"),
                    price_native=D("50"),
                    net_native=D("-500"),
                    net_usd=D("-500"),
                    net_eur=D("-450"),
                    fx_rate_to_eur=D("1.11"),
                )
            )
        fx_repo.upsert_rates(
            session, {first - timedelta(days=1): D("1.11")} | {d: D("1.16") for d in history}
        )
        session.add_all(txns)


@pytest.fixture
def bench(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeYF]:
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(tmp_path / "bench.sqlite"))
    for tier in ("LEDGER", "CONFIG", "CACHE"):
        monkeypatch.delenv(f"INV_DASHBOARD_{tier}_PATH", raising=False)
    monkeypatch.delenv("INV_DASHBOARD_TIINGO_TOKEN", raising=False)
    get_settings.cache_clear()
    dispose_engines()
    engine = get_ledger_engine()
    for metadata in ALL_METADATAS:
        metadata.create_all(engine)

    # Import everything the tick touches before freezing so their names get patched.
    from investment_dashboard.adapters import yfinance_client
    from investment_dashboard.services import (  # noqa: F401
        auto_refresh,
        fx_service,
        intraday_snapshots_service,
        metrics_service,
        positions_service,
        prices_service,
        scheduler,
    )

    fake = FakeYF()
    monkeypatch.setattr(yfinance_client, "yf", fake)
    monkeypatch.setattr(prices_service, "_resolve_tiingo_token", lambda: None)
    _Clock.now = FROZEN_START
    auto_refresh.reset_backfill_gate()
    _freeze(monkeypatch)
    _seed()
    try:
        yield fake
    finally:
        auto_refresh.reset_backfill_gate()
        dispose_engines()
        get_settings.cache_clear()


def _run_tick(fake: FakeYF) -> tuple[float, Counter[str]]:
    from investment_dashboard.services import scheduler

    fake.calls.clear()
    started = time.perf_counter()
    payload = scheduler.default_tick_job()
    elapsed = time.perf_counter() - started
    assert payload is not None
    assert payload["total_value_eur"] is not None
    return elapsed, Counter(fake.calls)


def test_minute_tick_benchmark(bench: FakeYF, caplog: pytest.LogCaptureFixture) -> None:
    """Before 7.3.1 (latency scale 1): first tick 14.0 s, minute tick 5.7 s, with 8
    serial ``Ticker.info`` calls and every chart request in series. After: 4.4 s / 0.5 s.
    """
    caplog.set_level("INFO", logger="investment_dashboard.pull")
    cold, cold_calls = _run_tick(bench)
    _Clock.now = FROZEN_START + timedelta(seconds=60)
    caplog.clear()
    warm, warm_calls = _run_tick(bench)
    messages = [r.getMessage() for r in caplog.records]
    timings = [m for m in messages if "timings:" in m]
    print(
        f"\nrefresh benchmark (latency scale {SCALE}): first tick {cold:.2f}s "
        f"{dict(cold_calls)}; minute tick {warm:.2f}s {dict(warm_calls)}"
        + (f"\n  {timings[-1]}" if timings else "")
    )
    # The market time comes with the chart answers: no Ticker.info round trips.
    assert cold_calls["info"] == 0
    assert warm_calls["info"] == 0
    # One chart request per due stock, per twin and for the FX spot; no intraday
    # re-pull while the graphs are covered.
    assert warm_calls["chart:1d"] == len(STOCKS) + len(FUNDS) + 1
    assert not any(k.startswith("chart:") and k != "chart:1d" for k in warm_calls)
    assert any("backfill skipped" in m for m in messages)
    # Each step's time lands on the pull round's log line.
    assert timings
    assert "prices" in timings[-1]
    assert "total" in timings[-1]
    # Under 3 s at real latencies: the network part scales, ~1 s of slack for the CPU.
    assert warm < 3.0 * SCALE + 1.0
