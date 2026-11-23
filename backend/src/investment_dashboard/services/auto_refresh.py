"""Automatic price-refresh cadence + background runner.

Two things live here so both the boot path and the UI can share them without a
circular import on :mod:`investment_dashboard.main`:

* the **auto-update interval** the user can now edit in Settings — how often the
  background tick pulls fresh prices — persisted in ``app_config`` and read when
  the live timer is (re)armed; and
* a small **background runner** that performs one refresh on a daemon thread,
  wrapped in the :mod:`investment_dashboard.services.refresh_status` activity
  cues (so the header chip + top bar animate) and the
  :mod:`investment_dashboard.services.runtime_status` error surface.

The server arms a single live timer with the configured interval; a
page load and the header chip both ask :func:`run_in_background` to pull now, so
"refresh the page" (or a click on the Live chip) also refreshes prices.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.services import app_config_service

log = logging.getLogger(__name__)

_INTERVAL_KEY = "live_refresh_interval_seconds"

#: Default cadence (seconds). Each tick only hits the network for instruments
#: whose per-asset-class TTL has expired (see ``prices_service``), so a brisk
#: default is cheap.
#:
#: NOTE (intentional divergence from the web companion): this desktop cadence is
#: in **seconds** (default 60, range 15-3600) because the desktop pulls from the
#: keyless yfinance feed with no per-credit budget. The web companion's matching
#: "update prices every" knob is in **minutes** (default 15, range 1-240, see
#: ``web/src/config.ts``) because each pull there spends a scarce Twelve Data
#: free-tier credit. The differing units/defaults are deliberate -- do not align.
DEFAULT_INTERVAL_SECONDS = 60
#: Guard-rails for the user-editable interval: fast enough to feel live, but
#: never so fast it hammers the free price feed, and capped at an hour.
MIN_INTERVAL_SECONDS = 15
MAX_INTERVAL_SECONDS = 3600


def clamp_interval_seconds(value: int) -> int:
    """Clamp a requested interval into ``[MIN, MAX]`` seconds."""
    return max(MIN_INTERVAL_SECONDS, min(MAX_INTERVAL_SECONDS, value))


def get_interval_seconds(session: Session) -> int:
    """Return the persisted auto-update interval, defaulting + clamped."""
    raw = app_config_service.get(session, _INTERVAL_KEY)
    if raw is None:
        return DEFAULT_INTERVAL_SECONDS
    try:
        return clamp_interval_seconds(int(float(raw)))
    except (TypeError, ValueError):
        return DEFAULT_INTERVAL_SECONDS


def set_interval_seconds(session: Session, value: int) -> int:
    """Persist a new auto-update interval (clamped). Returns the stored value."""
    clamped = clamp_interval_seconds(int(value))
    app_config_service.set_value(session, _INTERVAL_KEY, str(clamped))
    return clamped


class _StepTimer:
    """``perf_counter`` timings of a tick's steps, for the pull round's log line."""

    def __init__(self) -> None:
        self._started = time.perf_counter()
        self._steps: list[tuple[str, float]] = []

    @contextmanager
    def step(self, name: str) -> Iterator[None]:
        began = time.perf_counter()
        try:
            yield
        finally:
            self._steps.append((name, time.perf_counter() - began))

    def summary(self) -> str:
        parts = [f"{name} {secs:.2f}s" for name, secs in self._steps]
        parts.append(f"total {time.perf_counter() - self._started:.2f}s")
        return "timings: " + " | ".join(parts)


class _Prefetched:
    """A ``fetch_closes``-shaped callable that answers one known call from a download
    already in flight. Any other call goes to ``fallback``; a failed download re-raises.
    """

    def __init__(
        self, key: tuple[Any, ...], future: Future[Any], fallback: Callable[..., Any]
    ) -> None:
        self._key = key
        self._future = future
        self._fallback = fallback

    def __call__(self, symbols: list[str], start: date, end: date, **kwargs: Any) -> Any:
        if not kwargs and (tuple(symbols), start, end) == self._key:
            return self._future.result()
        return self._fallback(symbols, start, end, **kwargs)


#: The "1 Day"/"1 Week" top-up runs on every tick only while a graph is short of
#: target. Once it reports everything covered it is re-run at least this often,
#: and at once when the session changes or the day's curve opens a hole.
_BACKFILL_RECHECK = timedelta(minutes=15)
_backfill_state: dict[str, Any] = {"clean_at": None, "session": None}


def _backfill_due(now: datetime) -> bool:
    """Whether this tick should run :func:`intraday_snapshots_service.backfill_graphs`."""
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import intraday_snapshots_service as iss  # noqa: PLC0415

    clean_at = _backfill_state["clean_at"]
    if clean_at is None or now - clean_at >= _BACKFILL_RECHECK:
        return True
    if _backfill_state["session"] != iss.last_session_date(now):
        return True
    try:
        with ledger_session_scope() as session:
            return not iss.day_graph_covered(session, now=now)
    except Exception:  # pragma: no cover - defensive: when in doubt, top up
        return True


def _note_backfill(now: datetime, *, has_gaps: bool) -> None:
    from investment_dashboard.services import intraday_snapshots_service as iss  # noqa: PLC0415

    _backfill_state["clean_at"] = None if has_gaps else now
    _backfill_state["session"] = iss.last_session_date(now)


def reset_backfill_gate() -> None:
    """Forget the graph top-up gate, so the next tick runs it (tests, a graph reload)."""
    _backfill_state.update(clean_at=None, session=None)


def _twin_prefetch(pool: ThreadPoolExecutor, now: datetime) -> _Prefetched | None:
    """Start the ETF twins' daily-closes download now (network only), if one is due."""
    from investment_dashboard.adapters import yfinance_client  # noqa: PLC0415
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import (  # noqa: PLC0415
        intraday_snapshots_service,
        positions_service,
    )

    try:
        with ledger_session_scope() as session:
            held = positions_service.compute_positions(session)
            request = intraday_snapshots_service.twin_closes_request(
                session, now=now, positions=held
            )
    except Exception:  # pragma: no cover - defensive: the twins then fetch in their step
        log.warning("twin prefetch plan failed", exc_info=True)
        return None
    if request is None:
        return None
    symbols, start, end = request
    future = pool.submit(yfinance_client.fetch_closes, symbols, start, end)
    return _Prefetched((tuple(symbols), start, end), future, yfinance_client.fetch_closes)


def tick_refresh(  # noqa: PLR0915 - one narrated round, step by step
    source: str = "Live price refresh", *, force: bool = False
) -> bool:
    """Run one price refresh, wrapped in the activity + error surfaces.

    ``force`` performs a full :func:`refresh_prices` over the recent window (an
    explicit user action — e.g. the header Live chip), otherwise only TTL-due
    instruments are pulled. Returns whether new closes actually landed (drives
    the "last update" timestamp on the header chip). Never raises.

    Only network work runs concurrently: the live EUR/USD spot and the ETF twins'
    daily closes download while the holdings' own prices are in flight. Every
    database write stays on this thread. Each step's time is logged on the pull
    round (``timings: ...``).
    """
    from investment_dashboard.adapters import yfinance_client  # noqa: PLC0415
    from investment_dashboard.db import (  # noqa: PLC0415
        cache_session_scope,
        ledger_session_scope,
    )
    from investment_dashboard.domain import market_hours  # noqa: PLC0415
    from investment_dashboard.services import (  # noqa: PLC0415
        fx_service,
        intraday_snapshots_service,
        positions_service,
        pull_log,
        refresh_status,
        runtime_status,
    )
    from investment_dashboard.services.prices_service import (  # noqa: PLC0415
        refresh_due_prices,
        refresh_prices,
    )

    refresh_status.begin(source)
    updated = False
    fx_updated = False
    mode = "manual full re-pull" if force else "auto (TTL-due only)"
    round_ = pull_log.begin(source, mode=mode)
    steps = _StepTimer()
    now = datetime.now(UTC)
    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="tick-prefetch")
    try:
        # Start the side downloads first so they overlap the holdings' own pull. The
        # FX spot is only polled while the forex market trades (refresh_live_spot
        # would not call it otherwise).
        fx_fetcher: Callable[[], Any] | None = None
        if market_hours.is_forex_market_open(now):
            fx_fetcher = pool.submit(yfinance_client.fetch_eur_usd_spot).result
        with steps.step("plan"):
            twin_fetcher = _twin_prefetch(pool, now)
        # Open both tiers explicitly so the cached closes + ``last_refreshed_at``
        # stamps land in the cache database the overview actually reads. Passing
        # only a ledger session here (the old behaviour) silently wrote them to
        # the ledger DB under split-DB layouts, so the live tick never advanced
        # the per-symbol prices or "updated" time on screen.
        with (
            steps.step("prices"),
            ledger_session_scope() as ledger,
            cache_session_scope() as cache,
        ):
            if force:
                refreshed = refresh_prices(
                    ledger, cache, earliest_needed=exchange_today() - timedelta(days=30)
                )
            else:
                refreshed = refresh_due_prices(ledger, cache)
        # Refresh the live EUR/USD spot alongside prices so the FX-aware "today"
        # figures move intraday with the currency, not just the security price.
        # Best-effort: a failed FX pull leaves the ECB daily rate in place.
        with steps.step("fx"):
            spot = fx_service.refresh_live_spot(fetcher=fx_fetcher)
            if spot is None and fx_service.active_live_spot("USD") is None:
                spot = fx_service.backfill_live_spot()
        if spot is not None:
            fx_updated = True
            round_.note(f"FX: live EUR/USD spot {spot}")
        updated = any(refreshed.values())
        # The holdings at this tick's prices, computed once for the steps below.
        with steps.step("positions"), ledger_session_scope() as session:
            positions = positions_service.compute_positions(session)
        # Capture a point for the Overview "1 Day" intraday curve while the US
        # market is open, so the graph fills in with real market-time samples as
        # the app keeps auto-updating prices (no-op + self-pruning otherwise).
        with steps.step("capture"):
            intraday_snapshots_service.record_if_market_open(now=now, positions=positions)
        # ETF twins of the mutual funds (auxiliary symbols, never holdings): their
        # price now estimates each fund on the 1D line until its NAV posts. A no-op
        # without twins; a session without twin bars is backfilled once.
        with steps.step("twins"):
            intraday_snapshots_service.record_twin_prices(
                now=now, positions=positions, fetcher=twin_fetcher
            )
        # Top up the "1 Day" / "1 Week" graphs to target whether or not the market
        # is open: the live capture above only appends a point while the market
        # trades, so an under-filled graph (after a blank start, a stalled feed, or
        # simply between restarts) would otherwise never recover. The backfill is
        # cache-first; it is skipped while everything is covered (re-run every few
        # minutes, at a new session and as soon as the day's curve has a hole). A
        # graph it still can't fill is surfaced by the Data Health "Intraday graph
        # coverage" probe (diagnostics_service).
        with steps.step("backfill"):
            if force or _backfill_due(now):
                coverage = intraday_snapshots_service.backfill_graphs(now=now)
                _note_backfill(now, has_gaps=coverage.has_gaps)
            else:
                round_.note("graphs covered: backfill skipped")
        # The refresh completed without error: clear any lingering "outdated
        # prices"/refresh-failure notice from a previous tick so the Data Health
        # surface self-heals once prices are actually flowing again.
        runtime_status.resolve(source)
    except Exception as exc:
        # The explicit record_error below gives this a friendly label, so skip
        # the logging handler's mirror to avoid a duplicate (uglier) entry.
        log.warning("%s tick failed", source, exc_info=True, extra={"runtime_status_skip": True})
        # A failure *here* (outside the inner refresh, which catches its own
        # provider errors) aborts the whole round; record it against the trigger
        # label so the round summary flags the pull as failed.
        round_.provider_failed(source, f"{type(exc).__name__}: {exc}")
        runtime_status.record_error(source, f"{type(exc).__name__}: {exc}")
    finally:
        # Never wait on a side download nobody consumed (an early failure).
        pool.shutdown(wait=False, cancel_futures=True)
        round_.note(steps.summary())
        pull_log.end(round_)
        refresh_status.finish(source, updated=updated, fx_updated=fx_updated)
    return updated


def run_in_background(source: str, *, force: bool = False) -> None:
    """Kick off :func:`tick_refresh` on a daemon thread (non-blocking)."""
    threading.Thread(
        target=lambda: tick_refresh(source, force=force),
        name="inv-dashboard-refresh",
        daemon=True,
    ).start()
