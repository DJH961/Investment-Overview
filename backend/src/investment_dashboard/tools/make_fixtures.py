# ruff: noqa: PLC0415, PLR0915, PLR0911
"""``make_fixtures``: frozen API answers for the frontend fixture mode.

Builds a deliberately nasty, fully synthetic ledger in a temporary database,
asks the real FastAPI app for every GET the frontend makes (so the fixtures can
never drift from the read models) and writes one JSON file per data set:

* ``full.json``  - seven-figure totals, a very long instrument name, negative
  and tiny values, a NAV fund with an ETF twin, a EUR-native instrument, a
  stale price, an empty account.
* ``empty.json`` - a ledger with nothing in it (the empty states).

The clock is frozen (2026-06-30 18:15 UTC, a Tuesday 14:15 New York, the US cash
session open, with a seeded intraday series, live quotes and FX samples) and the
output is normalised, so regenerating gives byte-identical files; CI relies on
that. The frontend shifts all dates to the browser's today when it serves them.

Run from ``backend/``::

    uv run python -m investment_dashboard.tools.make_fixtures ../frontend/src/fixtures/data

Everything here is invented: symbols are ``FAKE*``, amounts are random draws.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import json
import os
import random
import re
import socket
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterator
from decimal import Decimal
from pathlib import Path
from typing import Any

#: The frozen "now". A Tuesday, 14:15 New York time (cash session open, 13:30 UTC open).
FROZEN_NOW = _dt.datetime(2026, 6, 30, 18, 15, tzinfo=_dt.UTC)
#: The regular-session open of that Tuesday (09:30 New York = 13:30 UTC, naive UTC).
SESSION_OPEN_UTC = _dt.datetime(2026, 6, 30, 13, 30)
FIRST_DAY = _dt.date(2023, 3, 1)
SEED = 20260630

D = Decimal

#: EUR/USD (USD per EUR). Yesterday's close, today's ECB fixing, the rate when the
#: session opened (last night: the euro gained) and the live spot now (the euro gave
#: some back during the session), so the market-hours and overnight legs differ in sign.
FX_PREV_CLOSE = D("1.1620")
FX_ECB_TODAY = D("1.1650")
FX_SESSION_OPEN = D("1.1662")
FX_LIVE_NOW = D("1.1641")
#: The live rate when the owner last looked (the Brief's "since" rate): the euro
#: has gained since, so the Brief shows a currency effect in both views.
FX_LAST_VISIT = D("1.1590")
#: Today's moves per instrument (fraction of yesterday's close): blue and orange both show.
DAY_MOVES = {
    "FAKEL": D("0.0085"),
    "FAKEB": D("-0.0035"),
    "FAKEG": D("0.0240"),
    "FAKEU": D("-0.0062"),
}
#: Intraday wobble (fraction of price) around each straight line to today's last price.
DAY_VOL = {
    "FAKEL": 0.0030,
    "FAKEB": 0.0012,
    "FAKEG": 0.0075,
    "FAKEU": 0.0025,
}
SAMPLE_MINUTES = 5
_REAL_DATETIME = _dt.datetime
_REAL_DATE = _dt.date

#: Path (and query) of every GET the frontend makes, in a stable order.
GRAPH_RANGES = ("1d", "1w", "1m", "3m", "6m", "ytd", "1y", "all")
HISTORY_RANGES = ("1m", "3m", "6m", "ytd", "1y", "all")
GET_ENDPOINTS: tuple[str, ...] = (
    "/api/auth/me",
    "/api/auth/passkeys",
    "/api/health",
    "/api/diagnostics/status",
    "/api/diagnostics",
    "/api/diagnostics/share-counts",
    "/api/live?since=0",
    "/api/overview/both",
    *(f"/api/graphs/{r}/both" for r in GRAPH_RANGES),
    "/api/holdings/both",
    "/api/holdings/both?group_by=none",
    "/api/holdings/both?group_by=category",
    "/api/holdings/both?group_by=account",
    "/api/holdings/both?group_by=asset_class",
    "/api/holdings/both?group_by=currency",
    "/api/periods/monthly/both?fill_gaps=true",
    "/api/periods/yearly/both",
    "/api/allocations/both",
    "/api/analytics/both?lookback_days=365",
    "/api/analytics/both?lookback_days=90",
    "/api/calculator/both",
    "/api/deposits/both",
    "/api/deposits/dividends/both",
    "/api/currency/both",
    "/api/brief",
    "/api/accounts",
    "/api/instruments",
    "/api/transactions?limit=50&offset=0&sort=date&order=desc&hide_sweeps=true",
    "/api/transactions/all",
    "/api/fx-conversions",
    "/api/fx-conversions/pool",
    "/api/onboarding",
    "/api/refresh/status",
    "/api/settings",
    "/api/settings/schema",
    "/api/settings/values",
    "/api/settings/history",
    "/api/settings/export",
    "/api/system",
    "/api/imports/brokers",
    "/api/imports/batches?limit=20",
    "/api/maintenance/jobs",
    "/api/maintenance/scheduler",
    "/api/maintenance/backups",
    "/api/maintenance/tiingo",
    "/api/maintenance/twins",
    "/api/maintenance/prices/anomalies",
    "/api/maintenance/logs?source=main",
)

#: POST bodies the frontend sends for read-like calls.
POST_ENDPOINTS: tuple[tuple[str, dict[str, Any]], ...] = ()


# -- frozen clock ----------------------------------------------------------------


def _freeze_clock() -> Callable[[], None]:
    """Make ``datetime.now()`` / ``date.today()`` return :data:`FROZEN_NOW`.

    Every ``investment_dashboard`` module that did ``from datetime import ...`` is
    re-pointed at subclasses whose ``now``/``today`` are fixed, and whose
    ``isinstance`` checks still accept real ``date``/``datetime`` objects.
    """

    class _DateMeta(type):
        def __instancecheck__(cls, obj: object) -> bool:
            return isinstance(obj, _REAL_DATE)

        def __subclasscheck__(cls, sub: type) -> bool:
            return issubclass(sub, _REAL_DATE)

    class _DatetimeMeta(type):
        def __instancecheck__(cls, obj: object) -> bool:
            return isinstance(obj, _REAL_DATETIME)

        def __subclasscheck__(cls, sub: type) -> bool:
            return issubclass(sub, _REAL_DATETIME)

    class FrozenDate(_REAL_DATE, metaclass=_DateMeta):
        @classmethod
        def today(cls) -> _dt.date:  # type: ignore[override]
            return FROZEN_NOW.date()

    class FrozenDatetime(_REAL_DATETIME, metaclass=_DatetimeMeta):
        @classmethod
        def now(cls, tz: _dt.tzinfo | None = None) -> _dt.datetime:  # type: ignore[override]
            if tz is None:
                return FROZEN_NOW.replace(tzinfo=None)
            return FROZEN_NOW.astimezone(tz)

        @classmethod
        def utcnow(cls) -> _dt.datetime:  # type: ignore[override]
            return FROZEN_NOW.replace(tzinfo=None)

        @classmethod
        def today(cls) -> _dt.datetime:  # type: ignore[override]
            return FROZEN_NOW.replace(tzinfo=None)

    patched: list[tuple[Any, str, Any]] = []
    for name, module in list(sys.modules.items()):
        if not name.startswith("investment_dashboard") or module is None or name == __name__:
            continue
        for attr, value in list(vars(module).items()):
            if value is _REAL_DATETIME:
                patched.append((module, attr, value))
                setattr(module, attr, FrozenDatetime)
            elif value is _REAL_DATE:
                patched.append((module, attr, value))
                setattr(module, attr, FrozenDate)

    def restore() -> None:
        for module, attr, value in patched:
            setattr(module, attr, value)

    return restore


# -- hermetic run ------------------------------------------------------------------

#: Every non-loopback connection attempt seen during a build (must stay empty).
NETWORK_ATTEMPTS: list[str] = []


def _is_loopback(host: object) -> bool:
    text = str(host)
    return text in {"", "localhost", "::1"} or text.startswith("127.")


@contextlib.contextmanager
def _no_network() -> Iterator[None]:
    """Refuse every non-loopback connection and name lookup, and record the attempt.

    The TestClient talks to the app in-process; nothing here needs a real network.
    Loopback stays open because asyncio's self-pipe on Windows is a local socket pair.
    """
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_getaddrinfo = socket.getaddrinfo
    real_create = socket.create_connection

    def _deny(what: str, target: object) -> None:
        NETWORK_ATTEMPTS.append(f"{what} {target}")
        raise OSError(f"make_fixtures is hermetic: {what} {target} blocked")

    def connect(self: socket.socket, address: Any) -> None:
        host = address[0] if isinstance(address, tuple) and address else address
        if not _is_loopback(host):
            _deny("connect", address)
        return real_connect(self, address)

    def connect_ex(self: socket.socket, address: Any) -> int:
        host = address[0] if isinstance(address, tuple) and address else address
        if not _is_loopback(host):
            _deny("connect_ex", address)
        return real_connect_ex(self, address)

    def getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
        if not _is_loopback(host):
            _deny("lookup", host)
        return real_getaddrinfo(host, *args, **kwargs)

    def create_connection(address: Any, *args: Any, **kwargs: Any) -> socket.socket:
        if not _is_loopback(address[0]):
            _deny("connect", address)
        return real_create(address, *args, **kwargs)

    socket.socket.connect = connect  # type: ignore[method-assign,assignment]
    socket.socket.connect_ex = connect_ex  # type: ignore[method-assign,assignment]
    socket.getaddrinfo = getaddrinfo  # type: ignore[assignment]
    socket.create_connection = create_connection  # type: ignore[assignment]
    try:
        yield
    finally:
        socket.socket.connect = real_connect  # type: ignore[method-assign]
        socket.socket.connect_ex = real_connect_ex  # type: ignore[method-assign]
        socket.getaddrinfo = real_getaddrinfo
        socket.create_connection = real_create


@contextlib.contextmanager
def _clean_environment() -> Iterator[None]:
    """No app settings, tokens or OS keyring from the machine the generator runs on."""
    saved = dict(os.environ)
    for key in list(os.environ):
        if key.startswith("INV_DASHBOARD_") or "TIINGO" in key.upper():
            del os.environ[key]
    from investment_dashboard.storage import encryption

    real_get = encryption._keyring_get
    encryption._keyring_get = lambda _username: None  # type: ignore[assignment]
    try:
        yield
    finally:
        encryption._keyring_get = real_get  # type: ignore[assignment]
        os.environ.clear()
        os.environ.update(saved)


@contextlib.contextmanager
def _pinned_host() -> Iterator[None]:
    """Hide what differs between machines: the memory probe and the local timezone.

    * The memory probe reads ``/proc`` (Linux only) and changes on every run.
    * The ``"Local"`` display timezone follows the host's zone; pin it to UTC.
    """
    from investment_dashboard.services import diagnostics_service, timezone_service

    real_memory = diagnostics_service.memory_usage
    real_local = timezone_service._local_tzinfo
    diagnostics_service.memory_usage = lambda status_path=None: None  # type: ignore[assignment]
    timezone_service._local_tzinfo = lambda: _dt.UTC  # type: ignore[assignment]
    try:
        yield
    finally:
        diagnostics_service.memory_usage = real_memory  # type: ignore[assignment]
        timezone_service._local_tzinfo = real_local  # type: ignore[assignment]


def _import_backend_modules() -> None:
    """Import every non-UI backend module now, so the clock freeze reaches all of them.

    Some services are only imported lazily (inside a function) and would otherwise
    keep the real clock, e.g. the provider budget that resets on the real hour.
    """
    import importlib
    import pkgutil

    for package in ("domain", "adapters", "repositories", "services", "readmodels", "api"):
        pkg = importlib.import_module(f"investment_dashboard.{package}")
        for info in pkgutil.walk_packages(pkg.__path__, f"investment_dashboard.{package}."):
            importlib.import_module(info.name)


def _reset_process_state() -> None:
    """Forget everything earlier work in this process left in module-level state."""
    from investment_dashboard.adapters import provider_status
    from investment_dashboard.services import (
        feed_stall_service,
        fetch_report,
        fx_service,
        intraday_snapshots_service,
        live_state,
        read_cache,
        refresh_status,
        runtime_status,
        settings_service,
    )

    provider_status.reset()
    live_state.reset()
    feed_stall_service.reset()
    fetch_report.clear()
    refresh_status.reset()
    runtime_status.reset()
    fx_service.clear_live_spot()
    with read_cache._lock:
        read_cache._entries.clear()
        read_cache._inflight.clear()
        for dep in read_cache._gens:
            read_cache._gens[dep] = 0
    settings_service._cache.update({"version": -1, "loaded_at": 0.0, "raw": {}})
    intraday_snapshots_service._week_attempts.clear()
    intraday_snapshots_service._year_attempts.clear()


def _seed_provider_state(session: Any) -> None:
    """Pin the provider budget and last-call status to fixed values (no real call ran)."""
    from investment_dashboard.adapters import provider_status
    from investment_dashboard.repositories import tiingo_state_repo

    now = FROZEN_NOW.replace(tzinfo=None)
    state = tiingo_state_repo.TiingoDesktopState(
        hour_stamp=now, hour_used=3, day_stamp=now, day_used=41
    )
    tiingo_state_repo.save(session, state)
    for provider, message in (
        ("tiingo", "IEX FAKEL 390 intraday bar(s) 2026-06-30..2026-06-30"),
        ("yfinance", "FAKEL 5 daily bar(s)"),
        ("frankfurter", "EUR/USD 1 rate(s)"),
    ):
        event = provider_status.StatusEvent(
            provider=provider, status="ok", message=message, at=FROZEN_NOW
        )
        provider_status._latest[provider] = event
        provider_status._log.append(event)


# -- the synthetic ledger ---------------------------------------------------------


def _weekdays(start: _dt.date, end: _dt.date) -> list[_dt.date]:
    out: list[_dt.date] = []
    day = start
    while day <= end:
        if day.weekday() < 5:
            out.append(day)
        day += _dt.timedelta(days=1)
    return out


def _walk(
    rng: random.Random, days: list[_dt.date], start: Decimal, end: Decimal, vol: float
) -> dict[_dt.date, Decimal]:
    """A seeded random walk that is bridged to land exactly on ``end``."""
    steps = len(days) - 1
    value = float(start)
    raw: list[float] = [value]
    for _ in range(steps):
        value = max(value * (1 + rng.gauss(0, vol)), 0.0001)
        raw.append(value)
    out: dict[_dt.date, Decimal] = {}
    for i, day in enumerate(days):
        # Linear bridge so the last point is exactly `end` whatever the draws were.
        shift = (float(end) - raw[-1]) * (i / max(steps, 1))
        out[day] = max(D(str(round(raw[i] + shift, 6))), D("0.0001"))
    out[days[-1]] = end
    return out


def seed_full(session: Any) -> None:
    """Insert the nasty ledger (see module docstring)."""
    from investment_dashboard.models import Transaction
    from investment_dashboard.repositories import (
        accounts_repo,
        fx_repo,
        instrument_overrides_repo,
        instruments_repo,
        intraday_repo,
        prices_repo,
    )
    from investment_dashboard.services import brief_service

    rng = random.Random(SEED)
    today = FROZEN_NOW.date()
    days = _weekdays(FIRST_DAY - _dt.timedelta(days=3), today)

    fx = _walk(
        rng, _weekdays(FIRST_DAY - _dt.timedelta(days=3), today), D("1.07"), D("1.1650"), 0.002
    )
    # The last two daily fixings are pinned (they anchor the open-session story):
    # EUR/USD closed yesterday at 1.1620, today's ECB fixing is 1.1650.
    fx[today - _dt.timedelta(days=1)] = FX_PREV_CLOSE
    fx[today] = FX_ECB_TODAY
    fx_repo.upsert_rates(session, fx)

    long_name = (
        "Fakeland Total World All-Capitalisation Diversified Index Exchange Traded Fund "
        "Accumulating Class USD Hedged (Synthetic Fixture Holding With An Absurdly Long Name)"
    )
    inst = {
        "FAKEL": instruments_repo.get_or_create(
            session, symbol="FAKEL", name=long_name, asset_class="etf", expense_ratio=D("0.0003")
        ),
        "FAKEB": instruments_repo.get_or_create(
            session, symbol="FAKEB", name="Fake Aggregate Bond ETF", asset_class="etf"
        ),
        "FAKET": instruments_repo.get_or_create(
            session, symbol="FAKET", name="Fake Micro Cap Dust", asset_class="stock"
        ),
        "FAKENX": instruments_repo.get_or_create(
            session,
            symbol="FAKENX",
            name="Fake Institutional NAV Index Fund",
            asset_class="mutual_fund",
        ),
        "FAKEU": instruments_repo.get_or_create(
            session,
            symbol="FAKEU.DE",
            name="Fake Europa Dividend Aktie",
            asset_class="stock",
            native_currency="EUR",
        ),
        "FAKEG": instruments_repo.get_or_create(
            session, symbol="FAKEG", name="Fake Growth Corp", asset_class="stock"
        ),
    }
    categories = {
        "FAKEL": "Global Stocks",
        "FAKEB": "Bonds",
        "FAKET": "Speculative",
        "FAKENX": "US Stocks",
        "FAKEU": "Europe Stocks",
        "FAKEG": "US Stocks",
    }
    for sym, cat in categories.items():
        instrument_overrides_repo.set_category(session, inst[sym].id, cat)
    instrument_overrides_repo.upsert(session, inst["FAKENX"].id, intraday_twin="FAKEL")

    # Price paths: (start, end, volatility, last priced day offset from today).
    paths = {
        "FAKEL": (D("118.40"), D("262.35"), 0.009, 0),
        "FAKEB": (D("81.20"), D("62.10"), 0.004, 0),  # a loser
        "FAKET": (D("0.0450"), D("0.0213"), 0.03, 12),  # tiny and stale
        "FAKENX": (D("94.10"), D("171.82"), 0.008, 1),  # NAV: yesterday's close only
        "FAKEU": (D("31.50"), D("48.95"), 0.01, 0),
        "FAKEG": (D("27.10"), D("83.40"), 0.02, 0),
    }
    walks: dict[str, dict[_dt.date, Decimal]] = {}
    for sym, (start, end, vol, lag) in paths.items():
        last = max(d for d in days if d <= today - _dt.timedelta(days=lag))
        series_days = [d for d in days if d <= last]
        walks[sym] = _walk(rng, series_days, start, end, vol)
        prices_repo.upsert_closes(session, inst[sym].id, walks[sym])

    # The default market benchmark (not held), so "Vs market", beta and alpha have a
    # series to compare with: it follows the world fund with its own noise and a lower
    # level, like a real index ETF would. Its own generator keeps the draws above unchanged.
    benchmark = instruments_repo.get_or_create(
        session, symbol="VT", asset_class="etf", native_currency="USD"
    )
    bench_rng = random.Random(SEED + 1)
    drift = 1.0
    bench: dict[_dt.date, Decimal] = {}
    for day, close in walks["FAKEL"].items():
        drift *= 1 + bench_rng.gauss(-0.0002, 0.003)
        bench[day] = D(str(round(float(close) * 0.45 * drift, 4)))
    prices_repo.upsert_closes(session, benchmark.id, bench)

    brokerage = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Main Brokerage Account With A Rather Long Label For Overflow Testing",
        native_currency="USD",
        account_type="brokerage",
    )
    retirement = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="Retirement",
        native_currency="USD",
        account_type="brokerage",
    )
    euro = accounts_repo.create_account(
        session,
        broker="savings_bank",
        account_label="Euro Depot",
        native_currency="EUR",
        account_type="brokerage",
    )
    accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Empty Account",
        native_currency="USD",
        account_type="brokerage",
    )

    def rate_on(day: _dt.date) -> Decimal:
        while day not in fx:
            day -= _dt.timedelta(days=1)
        return fx[day]

    def legs(day: _dt.date, native: Decimal, currency: str) -> dict[str, Decimal]:
        r = rate_on(day)
        if currency == "USD":
            return {
                "net_native": native,
                "net_usd": native,
                "net_eur": (native / r).quantize(D("0.01")),
                "fx_rate_to_eur": r,
            }
        return {
            "net_native": native,
            "net_eur": native,
            "net_usd": (native * r).quantize(D("0.01")),
            "fx_rate_to_eur": D("1"),
        }

    rows: list[Transaction] = []

    def add(
        account: Any, day: _dt.date, kind: str, native: str, currency: str = "USD", **extra: object
    ) -> None:
        # An explicit stamp (the DB default would be the real clock, not the frozen one).
        extra.setdefault("created_at", _dt.datetime.combine(day, _dt.time(12, 0)))
        rows.append(
            Transaction(
                account_id=account.id,
                date=day,
                kind=kind,
                source="manual",
                **legs(day, D(native), currency),
                **extra,
            )
        )

    def px(sym: str, day: _dt.date) -> Decimal:
        return D(str(prices_repo_close(session, inst[sym].id, day)))

    def buy(account: Any, sym: str, day: _dt.date, qty: str, currency: str = "USD") -> None:
        price = px(sym, day)
        amount = (D(qty) * price).quantize(D("0.01"))
        add(
            account,
            day,
            "buy",
            f"-{amount}",
            currency,
            instrument_id=inst[sym].id,
            quantity=D(qty),
            price_native=price,
            gross_native=amount,
        )

    d0 = _dt.date(2023, 3, 1)
    add(brokerage, d0, "deposit", "900000.00")
    add(retirement, d0, "deposit", "180000.00")
    add(euro, d0, "deposit", "40000.00", "EUR")
    buy(brokerage, "FAKEL", _dt.date(2023, 3, 2), "4000")
    buy(brokerage, "FAKEL", _dt.date(2024, 1, 16), "250.5")
    buy(brokerage, "FAKEB", _dt.date(2023, 3, 6), "1500")
    buy(brokerage, "FAKEG", _dt.date(2023, 9, 12), "400")
    buy(brokerage, "FAKET", _dt.date(2024, 5, 7), "0.00031")  # tiny
    buy(retirement, "FAKENX", _dt.date(2023, 3, 3), "800")
    buy(retirement, "FAKEL", _dt.date(2023, 3, 8), "120")
    buy(euro, "FAKEU", _dt.date(2023, 3, 7), "500", "EUR")
    add(brokerage, _dt.date(2025, 2, 3), "deposit", "75000.00")
    buy(brokerage, "FAKEG", _dt.date(2025, 2, 4), "200")
    sell_price = px("FAKEG", _dt.date(2025, 11, 12))
    add(
        brokerage,
        _dt.date(2025, 11, 12),
        "sell",
        f"{(D('150') * sell_price).quantize(D('0.01'))}",
        instrument_id=inst["FAKEG"].id,
        quantity=D("150"),
        price_native=sell_price,
    )
    add(brokerage, _dt.date(2025, 12, 1), "withdrawal", "-12500.00")
    for year, month in (
        (2023, 6),
        (2023, 12),
        (2024, 6),
        (2024, 12),
        (2025, 6),
        (2025, 12),
        (2026, 6),
    ):
        day = _dt.date(year, month, 20)
        add(brokerage, day, "dividend_cash", "1843.27", instrument_id=inst["FAKEL"].id)
        add(euro, day, "dividend_cash", "212.40", "EUR", instrument_id=inst["FAKEU"].id)
    add(brokerage, _dt.date(2024, 8, 14), "fee", "-0.01")
    add(retirement, _dt.date(2024, 9, 2), "interest", "3.07")
    # Booked since the owner last looked (the Brief lists these): yesterday afternoon.
    seen = _dt.date(2026, 6, 29)
    add(
        brokerage,
        seen,
        "dividend_cash",
        "312.50",
        instrument_id=inst["FAKEB"].id,
        created_at=_dt.datetime(2026, 6, 29, 21, 30),
    )
    add(retirement, seen, "interest", "5.42", created_at=_dt.datetime(2026, 6, 29, 21, 32))
    session.add_all(rows)
    session.flush()
    # The owner last had the app open on Thursday just after the close (three sessions
    # ago): the Brief's window is the absence since, and the rate then is the intraday
    # sample stored 5 minutes before that last visible read. The sample carries the
    # intraday-priced holdings' value as of that Thursday's close.
    from investment_dashboard.services import intraday_snapshots_service, positions_service

    previous_seen = _dt.datetime(2026, 6, 25, 21, 0, tzinfo=_dt.UTC)
    brief_service._store(session, brief_service.FROM_KEY, previous_seen)
    brief_service._store(session, brief_service.START_KEY, FROZEN_NOW)
    brief_service._store(session, brief_service.SEEN_KEY, FROZEN_NOW)
    then = positions_service.compute_positions(session, as_of=previous_seen.date())
    usd_then = intraday_snapshots_service.market_value_usd(then, FX_LAST_VISIT)
    assert usd_then is not None
    intraday_repo.insert_sample(
        session,
        (previous_seen - _dt.timedelta(minutes=5)).replace(tzinfo=None),
        usd_then / FX_LAST_VISIT,
        fx_eur_usd=FX_LAST_VISIT,
        market_value_usd=usd_then,
    )
    _seed_open_session(session, inst, today)


def _bridge(rng: random.Random, steps: int) -> list[float]:
    """A Brownian bridge of ``steps + 1`` points (unit-ish scale), zero at both ends."""
    raw = [0.0]
    for _ in range(steps):
        raw.append(raw[-1] + rng.gauss(0, 1) / steps**0.5)
    return [raw[i] - raw[-1] * (i / steps) for i in range(steps + 1)]


def _seed_open_session(session: Any, inst: dict[str, Any], today: _dt.date) -> None:
    """Make the frozen moment a live US session: today's quotes, intraday samples, FX, twin.

    Everything is stored the way the running app stores it: today's last price in
    ``price_history`` (+ the refresh metadata), one ``intraday_value`` row per sample
    (native-USD market component and the per-instant EUR/USD stored beside it), the
    live EUR/USD spot in memory, and the ETF twin's intraday prices for the NAV fund.
    """
    from investment_dashboard.repositories import (
        intraday_repo,
        price_cache_repo,
        prices_repo,
        twin_prices_repo,
    )
    from investment_dashboard.services import (
        fx_service,
        intraday_snapshots_service,
        positions_service,
        refresh_status,
    )

    rng = random.Random(SEED + 1)  # own stream: the ledger above is unchanged by this
    now_naive = FROZEN_NOW.replace(tzinfo=None)
    prev_day = today - _dt.timedelta(days=1)
    steps = int((now_naive - SESSION_OPEN_UTC).total_seconds() // 60 // SAMPLE_MINUTES)
    times = [SESSION_OPEN_UTC + _dt.timedelta(minutes=SAMPLE_MINUTES * k) for k in range(steps + 1)]

    # Today's last price per live-priced instrument and its intraday path.
    prev_close: dict[str, Decimal] = {}
    paths: dict[str, list[Decimal]] = {}
    for key, move in DAY_MOVES.items():
        iid = inst[key].id
        prev = prices_repo_close(session, iid, prev_day)
        prev_close[key] = prev
        last = (prev * (1 + move)).quantize(D("0.000001"))
        wobble = _bridge(rng, steps)
        vol = DAY_VOL[key]
        path = [
            (prev * (1 + move * D(k / steps) + D(vol * wobble[k]))).quantize(D("0.000001"))
            for k in range(steps + 1)
        ]
        path[-1] = last
        paths[key] = path
        prices_repo.upsert_closes(session, iid, {today: last})
    session.flush()

    # Provider bookkeeping: live quotes pulled seconds ago, the NAV fund's last NAV is yesterday's.
    pulled = now_naive - _dt.timedelta(seconds=40)
    for key in DAY_MOVES:
        price_cache_repo.upsert_last_refreshed_at(
            session,
            inst[key].id,
            pulled,
            market_time=now_naive - _dt.timedelta(seconds=55),
        )
    nav_pulled = _dt.datetime.combine(prev_day, _dt.time(22, 5))
    price_cache_repo.upsert_last_refreshed_at(
        session,
        inst["FAKENX"].id,
        nav_pulled,
        market_time=_dt.datetime.combine(prev_day, _dt.time(20, 0)),
    )
    refresh_status._state["last_update_at"] = FROZEN_NOW - _dt.timedelta(seconds=40)
    refresh_status._state["last_price_update_at"] = FROZEN_NOW - _dt.timedelta(seconds=40)

    # EUR/USD: a wandering path from the open rate to the live spot, one sample per step.
    fx_wobble = _bridge(rng, steps)
    fx_path = [
        (
            FX_SESSION_OPEN
            + (FX_LIVE_NOW - FX_SESSION_OPEN) * D(k / steps)
            + D(0.0013 * fx_wobble[k])
        ).quantize(D("0.00000001"))
        for k in range(steps + 1)
    ]
    fx_path[0] = FX_SESSION_OPEN
    fx_path[-1] = FX_LIVE_NOW
    fx_service.set_live_spot(
        "USD", FX_LIVE_NOW, observed_on=today, observed_at=FROZEN_NOW - _dt.timedelta(seconds=20)
    )

    # The market component (stocks/ETFs only) per sample, FX-free in native USD.
    positions = positions_service.compute_positions(session)
    priced = [
        p for p in positions if p.shares > 0 and intraday_snapshots_service.is_intraday_priced(p)
    ]
    by_symbol = {inst[k].symbol: {t: paths[k][i] for i, t in enumerate(times)} for k in paths}
    lookups = {sym: (lambda at, m=series: m.get(at)) for sym, series in by_symbol.items()}
    for i, at in enumerate(times):
        usd = intraday_snapshots_service._market_component_usd(priced, lookups, at, fx_t=fx_path[i])
        if usd is None:  # pragma: no cover - the seed always has a rate
            continue
        eur = (usd / fx_path[i]).quantize(D("0.000001"))
        intraday_repo.insert_sample(session, at, eur, fx_path[i], usd.quantize(D("0.000001")))

    # The NAV fund FAKENX estimates from its twin FAKEL: yesterday's 16:00 ET close + today's bars.
    twin_rows = {
        _dt.datetime.combine(prev_day, _dt.time(20, 0)): prev_close["FAKEL"],
        **{t: paths["FAKEL"][i] for i, t in enumerate(times)},
    }
    twin_prices_repo.upsert_prices(session, "FAKEL", twin_rows)
    session.flush()


def prices_repo_close(session: Any, instrument_id: int, day: _dt.date) -> Decimal:
    """Close on or before ``day`` (the seed needs prices to book trades at)."""
    from sqlalchemy import select

    from investment_dashboard.models import PriceHistory

    row = session.execute(
        select(PriceHistory.close_native)
        .where(PriceHistory.instrument_id == instrument_id, PriceHistory.date <= day)
        .order_by(PriceHistory.date.desc())
        .limit(1)
    ).scalar_one()
    return Decimal(row)


# -- running the app ---------------------------------------------------------------

#: Stands in for the app version; ``frontend/src/fixtures/mock.ts`` replaces it.
VERSION_SENTINEL = "fixtures-version"
_WORKDIR = ""
_DT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$")


def _normalise(value: Any, key: str = "") -> Any:
    """Strip what differs between runs (real-clock timestamps, random ids)."""
    if isinstance(value, dict):
        return {k: _normalise(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalise(v, key) for v in value]
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float) and key in {"uptime_seconds", "db_size_bytes"}:
        return 0
    if isinstance(value, str):
        if key in {"version", "app_version"}:
            return VERSION_SENTINEL  # the mock layer swaps in the build's own version
        if key in {"boot_id", "head", "current"}:
            return "fixture"
        if _WORKDIR and _WORKDIR in value:
            return "/fixtures" + value.split(_WORKDIR, 1)[1].replace("\\", "/")
        if _DT_RE.match(value):
            parsed = _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
            if key.startswith("next_") or key == "reopen_at":
                return value  # real, future clock fields (next open / close, FX reopen)
            aware = parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=_dt.UTC)
            if parsed.date() > FROZEN_NOW.date() or (key.endswith("_at") and aware > FROZEN_NOW):
                tz = "+00:00" if parsed.tzinfo is not None else ""
                return FROZEN_NOW.replace(tzinfo=None).isoformat() + tz
    return value


def _build(dataset: str, workdir: Path) -> dict[str, Any]:
    """Hermetically create the database, call every endpoint, return ``{"GET path": body}``.

    No network (every non-loopback connection is refused and recorded), no
    settings, tokens or keyring from the host, and no state left over from an
    earlier build in the same process: calling this twice gives identical output.
    """
    NETWORK_ATTEMPTS.clear()
    with _clean_environment(), _pinned_host(), _no_network():
        out = _build_inner(dataset, workdir)
    if NETWORK_ATTEMPTS:
        raise RuntimeError(
            "make_fixtures tried to reach the network: " + "; ".join(NETWORK_ATTEMPTS)
        )
    return out


def _build_inner(dataset: str, workdir: Path) -> dict[str, Any]:
    global _WORKDIR  # noqa: PLW0603
    _WORKDIR = str(workdir)
    db = workdir / f"{dataset}.sqlite"
    os.environ["INV_DASHBOARD_DB_PATH"] = str(db)
    os.environ["INV_DASHBOARD_SERVER_MODE"] = "true"
    os.environ["INV_DASHBOARD_COOKIE_SECURE"] = "false"

    from fastapi.testclient import TestClient

    from investment_dashboard.api.app import create_app
    from investment_dashboard.api.deps import require_auth
    from investment_dashboard.api.guards import require_session
    from investment_dashboard.config import get_settings
    from investment_dashboard.db import dispose_engines, get_ledger_engine, ledger_session_scope
    from investment_dashboard.models import ALL_METADATAS

    get_settings.cache_clear()
    dispose_engines()
    engine = get_ledger_engine()
    for metadata in ALL_METADATAS:
        metadata.create_all(engine)

    async def _allow() -> None:
        return None

    # Build the app (loads every router) before the clock is frozen, so the
    # routers' own `date` annotations stay the real classes.
    app = create_app(lifespan=False)

    async def _actor() -> str:
        return "fixtures"

    app.dependency_overrides[require_auth] = _allow
    app.dependency_overrides[require_session] = _actor
    _import_backend_modules()
    _reset_process_state()
    restore_clock = _freeze_clock()
    try:
        return _collect(app, dataset, ledger_session_scope, TestClient)
    finally:
        restore_clock()
        dispose_engines()
        get_settings.cache_clear()


def _collect(app: Any, dataset: str, ledger_session_scope: Any, test_client: Any) -> dict[str, Any]:
    with ledger_session_scope() as session:
        _seed_provider_state(session)
        if dataset == "full":
            seed_full(session)
    if dataset == "full":
        # A running server warms every daily snapshot at boot (boot.py); do the same,
        # so the equity curve, Periods and Risk read a daily history like the real app
        # instead of the sparse month ends a cold first render would compute.
        from investment_dashboard.services import snapshots_service

        with ledger_session_scope() as session:
            snapshots_service.warm_range(
                session, FIRST_DAY, FROZEN_NOW.date() - _dt.timedelta(days=1)
            )
    out: dict[str, Any] = {}
    with test_client(app) as client:
        endpoints = list(GET_ENDPOINTS)
        if dataset == "full":
            ids = [row["id"] for row in client.get("/api/instruments").json()]
            endpoints += [
                f"/api/holdings/{i}/history?range={r}" for i in ids[:2] for r in HISTORY_RANGES
            ]
            endpoints += [f"/api/transactions/{i}" for i in (1, 2)]
        for path in endpoints:
            resp = client.get(path)
            if resp.status_code != 200:
                out[f"GET {path}"] = {
                    "__status": resp.status_code,
                    "__body": resp.json() if resp.content else None,
                }
                continue
            out[f"GET {path}"] = _normalise(resp.json())
        # No login in fixture mode: the guard is overridden above, so say so explicitly.
        out["GET /api/auth/me"] = {"authenticated": True, "passkeys": 1}
        proj = client.get("/api/calculator/both")
        if proj.status_code == 200:
            out["POST /api/calculator"] = _projection(client, proj.json())
    return out


def _projection(client: Any, inputs: dict[str, Any]) -> Any:
    """The projection for the calculator's own default inputs, if it accepts them."""
    body = inputs.get("EUR") or {}
    request = {
        k: body[k] for k in ("monthly_contribution", "years", "expected_return_pct") if k in body
    }
    resp = client.post("/api/calculator?ccy=EUR", json=request)
    return _normalise(resp.json()) if resp.status_code == 200 else None


def render(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="make_fixtures", description=__doc__.splitlines()[0])
    parser.add_argument("out_dir", type=Path, help="folder that receives full.json and empty.json")
    parser.add_argument("--dataset", choices=("full", "empty"), help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    if args.dataset is None:
        # One process per data set: the frozen clock must not leak between them.
        code = 0
        for dataset in ("full", "empty"):
            cmd = [
                sys.executable,
                "-m",
                "investment_dashboard.tools.make_fixtures",
                str(args.out_dir),
                "--dataset",
                dataset,
            ]
            code |= subprocess.run(cmd, check=False).returncode
        return code
    with tempfile.TemporaryDirectory(prefix="make-fixtures-", ignore_cleanup_errors=True) as tmp:
        data = _build(args.dataset, Path(tmp))
    bad = sorted(k for k, v in data.items() if isinstance(v, dict) and "__status" in v)
    for key in bad:
        print(f"  {args.dataset}: {key} -> HTTP {data[key]['__status']}", file=sys.stderr)
    (args.out_dir / f"{args.dataset}.json").write_text(render(data), encoding="utf-8", newline="\n")
    print(f"{args.dataset}.json: {len(data)} endpoints")
    return 1 if bad else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
