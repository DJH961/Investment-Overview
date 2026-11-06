"""Watch the live price feed for frozen quotes and remember when it stalled.

Wraps the pure detector in :mod:`investment_dashboard.domain.feed_stall` with the
app's runtime state: one detector shared by every pull (thread-safe), a line in
the market-data activity log when a stall starts and ends, and a short persisted
history of stall windows (``app_config``) so the Data Health page and the 1 Day /
1 Week graphs can say "no market data from the provider between 18:11 and 19:53"
instead of silently drawing a flat line.

While a stall is in progress:

* the figures are not called "Live" (:func:`is_stalled` feeds ``is_live_now``);
* the live 1 Day capture stores no points, so the graph shows a gap that a later
  intraday re-pull can fill, rather than a flat line followed by a jump;
* the Tiingo backup (when a token is set) is asked for the stalled symbols.
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.domain import feed_stall

log = logging.getLogger(__name__)

#: ``app_config`` key holding the finished stall windows as JSON
#: ``[[start_iso, end_iso], ...]`` (UTC).
_WINDOWS_KEY = "price_feed_stall_windows"

#: How long finished stall windows are kept (the 1 Week graph spans ~7 days).
KEEP_DAYS = 14

_lock = threading.Lock()
_state = feed_stall.StallState()
#: Newest stock/ETF market time any pull reported (when the latest price was struck).
_newest_market_time: datetime | None = None


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(at: datetime) -> datetime:
    return at.replace(tzinfo=UTC) if at.tzinfo is None else at


def _fmt(at: datetime) -> str:
    return _aware(at).strftime("%Y-%m-%d %H:%M UTC")


def observe_pull(
    session: Session | None,
    *,
    now: datetime,
    market_open: bool,
    quotes: Mapping[str, Decimal],
    newest_market_time: datetime | None,
) -> feed_stall.StallChange:
    """Record one pull's intraday quotes; log and persist a stall that starts/ends.

    ``session`` is a ledger session for persisting a finished window (``None``
    skips persistence, e.g. in a context without the ledger). Never raises.
    """
    global _state, _newest_market_time  # noqa: PLW0603
    with _lock:
        if newest_market_time is not None and (
            _newest_market_time is None or _aware(newest_market_time) > _newest_market_time
        ):
            _newest_market_time = _aware(newest_market_time)
        _state, change = feed_stall.observe(
            _state,
            now=now,
            market_open=market_open,
            quotes=quotes,
            newest_market_time=newest_market_time,
            stall_after_seconds=stall_after_seconds(),
        )
    if change.started is not None:
        activity("market_data").warning(
            "price feed stalled: the provider keeps serving unchanged quotes since %s; "
            "not shown as Live and no graph points stored until it recovers",
            _fmt(change.started),
        )
    if change.ended is not None:
        start, end = change.ended
        minutes = (end - start).total_seconds() / 60
        activity("market_data").info(
            "price feed recovered: quotes were frozen from %s to %s (%.0f min)",
            _fmt(start),
            _fmt(end),
            minutes,
        )
        if session is not None:
            try:
                _persist_window(session, start, end, now=now)
            except Exception:  # pragma: no cover - defensive: history is best-effort
                log.warning("could not save the price-feed stall window", exc_info=True)
    return change


def stall_after_seconds() -> float:
    """Setting ``prices.stall_after_seconds`` (Settings > Data refresh)."""
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    try:
        return float(
            settings_service.get_or("prices.stall_after_seconds", feed_stall.STALL_AFTER_SECONDS)
        )
    except Exception:  # pragma: no cover - settings unreadable: keep the default
        return feed_stall.STALL_AFTER_SECONDS


def live_max_age_seconds() -> float:
    """Setting ``prices.live_max_age_seconds`` (Settings > Data refresh)."""
    from investment_dashboard.domain import market_hours  # noqa: PLC0415
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    try:
        return float(
            settings_service.get_or(
                "prices.live_max_age_seconds", market_hours.LIVE_PRICE_WINDOW_SECONDS
            )
        )
    except Exception:  # pragma: no cover - settings unreadable: keep the default
        return market_hours.LIVE_PRICE_WINDOW_SECONDS


def is_stalled() -> bool:
    """Whether a stall is in progress right now."""
    with _lock:
        return _state.stalled_since is not None


def stalled_since() -> datetime | None:
    """Start of the stall in progress (when prices last moved), else ``None``."""
    with _lock:
        return _state.stalled_since


def newest_market_time() -> datetime | None:
    """When the newest stock/ETF price seen by any pull was struck (aware UTC)."""
    with _lock:
        return _newest_market_time


def reset() -> None:
    """Forget the in-memory detector state (tests)."""
    global _state, _newest_market_time  # noqa: PLW0603
    with _lock:
        _state = feed_stall.StallState()
        _newest_market_time = None


def _load(session: Session) -> list[tuple[datetime, datetime]]:
    from investment_dashboard.services import app_config_service  # noqa: PLC0415

    raw = app_config_service.get(session, _WINDOWS_KEY)
    if not raw:
        return []
    try:
        rows = json.loads(raw)
        return [
            (_aware(datetime.fromisoformat(s)), _aware(datetime.fromisoformat(e))) for s, e in rows
        ]
    except (ValueError, TypeError):
        log.warning("ignoring unreadable %s value", _WINDOWS_KEY)
        return []


def _persist_window(session: Session, start: datetime, end: datetime, *, now: datetime) -> None:
    from investment_dashboard.services import app_config_service  # noqa: PLC0415

    cutoff = _aware(now) - timedelta(days=KEEP_DAYS)
    windows = feed_stall.merge_windows([*_load(session), (start, end)])
    kept = [(s, e) for s, e in windows if e >= cutoff]
    app_config_service.set_value(
        session, _WINDOWS_KEY, json.dumps([[s.isoformat(), e.isoformat()] for s, e in kept])
    )


def record_window(session: Session, start: datetime, end: datetime) -> None:
    """Add a known stall window by hand (repair tool / tests)."""
    _persist_window(session, start, end, now=_now())


def windows_between(
    session: Session, start: datetime, end: datetime, *, now: datetime | None = None
) -> list[tuple[datetime, datetime]]:
    """Stall windows overlapping ``[start, end]``, the one in progress included.

    The in-progress stall is reported up to ``now``. Windows are clipped to the
    range and returned sorted, as aware UTC datetimes.
    """
    now = _aware(now or _now())
    start, end = _aware(start), _aware(end)
    windows = list(_load(session))
    since = stalled_since()
    if since is not None:
        windows.append((_aware(since), now))
    out: list[tuple[datetime, datetime]] = []
    for s, e in feed_stall.merge_windows(windows):
        if e <= start or s >= end:
            continue
        out.append((max(s, start), min(e, end)))
    return out
