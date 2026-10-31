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

The desktop app arms a single ``app.timer`` with the configured interval; a
page load and the header chip both ask :func:`run_in_background` to pull now, so
"refresh the page" (or a click on the Live chip) also refreshes prices.
"""

from __future__ import annotations

import logging
import threading
from datetime import date, timedelta

from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo

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
    raw = app_config_repo.get(session, _INTERVAL_KEY)
    if raw is None:
        return DEFAULT_INTERVAL_SECONDS
    try:
        return clamp_interval_seconds(int(float(raw)))
    except (TypeError, ValueError):
        return DEFAULT_INTERVAL_SECONDS


def set_interval_seconds(session: Session, value: int) -> int:
    """Persist a new auto-update interval (clamped). Returns the stored value."""
    clamped = clamp_interval_seconds(int(value))
    app_config_repo.set_value(session, _INTERVAL_KEY, str(clamped))
    return clamped


def tick_refresh(source: str = "Live price refresh", *, force: bool = False) -> bool:
    """Run one price refresh, wrapped in the activity + error surfaces.

    ``force`` performs a full :func:`refresh_prices` over the recent window (an
    explicit user action — e.g. the header Live chip), otherwise only TTL-due
    instruments are pulled. Returns whether new closes actually landed (drives
    the "last update" timestamp on the header chip). Never raises.
    """
    from investment_dashboard.db import (  # noqa: PLC0415
        cache_session_scope,
        ledger_session_scope,
    )
    from investment_dashboard.services import pull_log, refresh_status  # noqa: PLC0415
    from investment_dashboard.services.prices_service import (  # noqa: PLC0415
        refresh_due_prices,
        refresh_prices,
    )

    refresh_status.begin(source)
    updated = False
    mode = "manual full re-pull" if force else "auto (TTL-due only)"
    round_ = pull_log.begin(source, mode=mode)
    try:
        # Open both tiers explicitly so the cached closes + ``last_refreshed_at``
        # stamps land in the cache database the overview actually reads. Passing
        # only a ledger session here (the old behaviour) silently wrote them to
        # the ledger DB under split-DB layouts, so the live tick never advanced
        # the per-symbol prices or "updated" time on screen.
        with ledger_session_scope() as ledger, cache_session_scope() as cache:
            if force:
                refreshed = refresh_prices(
                    ledger, cache, earliest_needed=date.today() - timedelta(days=30)
                )
            else:
                refreshed = refresh_due_prices(ledger, cache)
        # Refresh the live EUR/USD spot alongside prices so the FX-aware "today"
        # figures move intraday with the currency, not just the security price.
        # Best-effort: a failed FX pull leaves the ECB daily rate in place.
        from investment_dashboard.services import fx_service  # noqa: PLC0415

        spot = fx_service.refresh_live_spot()
        if spot is not None:
            round_.note(f"FX: live EUR/USD spot {spot}")
        updated = any(refreshed.values())
        # Capture a point for the Overview "1 Day" intraday curve while the US
        # market is open, so the graph fills in with real market-time samples as
        # the app keeps auto-updating prices (no-op + self-pruning otherwise).
        from investment_dashboard.services import intraday_snapshots_service  # noqa: PLC0415

        intraday_snapshots_service.record_if_market_open()
        # Top up the "1 Day" / "1 Week" graphs to target on *every* auto-update,
        # whether or not the market is open: the live capture above only appends a
        # point while the market trades, so an under-filled graph (after a blank
        # start, a stalled feed, or simply between restarts) would otherwise never
        # recover. The backfill is cache-first and a no-op once a graph is fully
        # covered; a graph it still can't fill is surfaced by the Data Health
        # "Intraday graph coverage" probe (diagnostics_service).
        intraday_snapshots_service.backfill_graphs()
        # The refresh completed without error: clear any lingering "outdated
        # prices"/refresh-failure notice from a previous tick so the Data Health
        # surface self-heals once prices are actually flowing again.
        from investment_dashboard.services import runtime_status  # noqa: PLC0415

        runtime_status.resolve(source)
    except Exception as exc:
        # The explicit record_error below gives this a friendly label, so skip
        # the logging handler's mirror to avoid a duplicate (uglier) entry.
        log.warning("%s tick failed", source, exc_info=True, extra={"runtime_status_skip": True})
        # A failure *here* (outside the inner refresh, which catches its own
        # provider errors) aborts the whole round; record it against the trigger
        # label so the round summary flags the pull as failed.
        round_.provider_failed(source, f"{type(exc).__name__}: {exc}")
        from investment_dashboard.services import runtime_status  # noqa: PLC0415

        runtime_status.record_error(source, f"{type(exc).__name__}: {exc}")
    finally:
        pull_log.end(round_)
        refresh_status.finish(source, updated=updated)
    return updated


def run_in_background(source: str, *, force: bool = False) -> None:
    """Kick off :func:`tick_refresh` on a daemon thread (non-blocking)."""
    threading.Thread(
        target=lambda: tick_refresh(source, force=force),
        name="inv-dashboard-refresh",
        daemon=True,
    ).start()
