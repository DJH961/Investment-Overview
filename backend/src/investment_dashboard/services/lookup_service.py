"""Lookup: quotes and charts for symbols the user does not (necessarily) hold.

Read-only by construction: nothing here creates an ``instruments`` row or writes the
ledger or cache databases. Results live in a small in-memory TTL cache (15 minutes,
50 symbols) so repeated opens of the same symbol do not hammer the provider.
FX is attached per point at that point's own day (live spot for today), exactly like
the rest of the app: one instant, one rate; the client converts, never computes a return.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.adapters import yfinance_client as yf_client
from investment_dashboard.adapters.yfinance_client import SearchHit
from investment_dashboard.domain.currency import lookup_rate_with_forward_fill
from investment_dashboard.errors import DomainError, NotFoundError, UpstreamError, ValidationError
from investment_dashboard.repositories import instruments_repo
from investment_dashboard.services import fx_service

log = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 15 * 60
CACHE_MAX_SYMBOLS = 50
RANGES = ("1d", "1w", "1m", "3m", "6m", "ytd", "1y", "all")
_SESSION_GAP = timedelta(hours=4)
_ALL_START = date(1970, 1, 1)


@dataclass(frozen=True)
class SearchResult:
    symbol: str
    name: str
    exchange: str | None
    type: str | None
    currency: str | None
    held_instrument_id: int | None


@dataclass(frozen=True)
class Quote:
    symbol: str
    name: str | None
    exchange: str | None
    type: str | None
    currency: str | None
    price_native: Decimal
    day_change_native: Decimal | None
    day_pct: Decimal | None
    captured_at: datetime
    week52_low: Decimal | None
    week52_high: Decimal | None
    fx_eur_usd: Decimal | None


@dataclass(frozen=True)
class HistoryPoint:
    t: str
    price_native: Decimal
    fx_eur_usd: Decimal | None


@dataclass(frozen=True)
class SessionSpan:
    open: str
    close: str


@dataclass(frozen=True)
class History:
    symbol: str
    currency: str | None
    range: str
    x_mode: str
    sessions: list[SessionSpan]
    points: list[HistoryPoint]


# -- cache ---------------------------------------------------------------------------

_clock: Callable[[], float] = time.monotonic
_lock = threading.Lock()
# symbol -> {key: (stored_at, value)}; insertion order = least recently used first.
_cache: OrderedDict[str, dict[str, tuple[float, Any]]] = OrderedDict()


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def _cache_get(symbol: str, key: str) -> Any | None:
    with _lock:
        entry = _cache.get(symbol, {}).get(key)
        if entry is None:
            return None
        stored_at, value = entry
        if _clock() - stored_at >= CACHE_TTL_SECONDS:
            del _cache[symbol][key]
            return None
        _cache.move_to_end(symbol)
        return value


def _cache_put(symbol: str, key: str, value: Any) -> None:
    with _lock:
        _cache.setdefault(symbol, {})[key] = (_clock(), value)
        _cache.move_to_end(symbol)
        while len(_cache) > CACHE_MAX_SYMBOLS:
            _cache.popitem(last=False)


# -- helpers -------------------------------------------------------------------------


def _check_symbol(symbol: str) -> str:
    cleaned = symbol.strip().upper()
    if not cleaned:
        raise ValidationError("Enter a symbol.")
    return cleaned


def _upstream(what: str, exc: Exception) -> UpstreamError:
    log.warning("lookup: %s failed: %s", what, exc)
    return UpstreamError("The market-data provider is not answering right now. Try again shortly.")


def _fx_series(session: Session) -> dict[date, Decimal]:
    try:
        return fx_service.get_rates(session)
    except Exception as exc:  # FX is optional garnish for a lookup chart
        log.debug("lookup: fx rates unavailable: %s", exc)
        return {}


def _iso(moment: datetime) -> str:
    return moment.replace(tzinfo=UTC).isoformat().replace("+00:00", "Z")


# -- search --------------------------------------------------------------------------


def search(session: Session, query: str, limit: int = 10) -> list[SearchResult]:
    q = query.strip()
    if not q:
        raise ValidationError("Enter something to search for.")
    log.info("lookup: search")
    try:
        hits: list[SearchHit] = yf_client.search_instruments(q, limit)
    except yf_client.YFinanceError as exc:
        raise _upstream("search", exc) from exc
    held = {row.symbol.upper(): row.id for row in instruments_repo.list_instruments(session)}
    return [
        SearchResult(
            symbol=h.symbol,
            name=h.name,
            exchange=h.exchange,
            type=h.type,
            currency=h.currency,
            held_instrument_id=held.get(h.symbol.upper()),
        )
        for h in hits
    ]


# -- quote ---------------------------------------------------------------------------


def get_quote(session: Session, symbol: str) -> Quote:
    symbol = _check_symbol(symbol)
    cached = _cache_get(symbol, "quote")
    if cached is not None:
        return cached  # type: ignore[no-any-return]
    log.info("lookup: quote %s", symbol)
    try:
        snap = yf_client.fetch_quote(symbol)
    except yf_client.YFinanceError as exc:
        raise _upstream(f"quote {symbol}", exc) from exc
    if snap is None:
        raise NotFoundError(f"No quote found for {symbol}.")
    change: Decimal | None = None
    pct: Decimal | None = None
    if snap.previous_close is not None and snap.previous_close > 0:
        change = snap.price - snap.previous_close
        pct = change / snap.previous_close
    now = datetime.now(UTC)
    quote = Quote(
        symbol=symbol,
        name=snap.name,
        exchange=snap.exchange,
        type=snap.type,
        currency=snap.currency,
        price_native=snap.price,
        day_change_native=change,
        day_pct=pct,
        captured_at=now,
        week52_low=snap.week52_low,
        week52_high=snap.week52_high,
        fx_eur_usd=lookup_rate_with_forward_fill(_fx_series(session), now.date()),
    )
    _cache_put(symbol, "quote", quote)
    return quote


# -- history -------------------------------------------------------------------------


def _range_start(range_: str, today: date) -> date:
    return {
        "1m": today - timedelta(days=31),
        "3m": today - timedelta(days=92),
        "6m": today - timedelta(days=183),
        "ytd": date(today.year, 1, 1),
        "1y": today - timedelta(days=366),
        "all": _ALL_START,
    }[range_]


def _split_sessions(bars: dict[datetime, Decimal]) -> list[list[datetime]]:
    sessions: list[list[datetime]] = []
    for ts in sorted(bars):
        if sessions and ts - sessions[-1][-1] <= _SESSION_GAP:
            sessions[-1].append(ts)
        else:
            sessions.append([ts])
    return sessions


def _currency_of(session: Session, symbol: str) -> str | None:
    try:
        return get_quote(session, symbol).currency
    except DomainError:
        return None


def get_history(session: Session, symbol: str, range_: str) -> History:
    symbol = _check_symbol(symbol)
    if range_ not in RANGES:
        raise ValidationError(f"Unknown range {range_!r}.")
    key = f"history:{range_}"
    cached = _cache_get(symbol, key)
    if cached is not None:
        return cached  # type: ignore[no-any-return]
    log.info("lookup: history %s %s", symbol, range_)
    today = datetime.now(UTC).date()
    fx = _fx_series(session)
    sessions: list[SessionSpan] = []
    points: list[HistoryPoint] = []
    try:
        if range_ in ("1d", "1w"):
            interval = "1m" if range_ == "1d" else "5m"
            bars = yf_client.fetch_intraday_closes_range(
                [symbol], today - timedelta(days=7), today, interval=interval
            ).get(symbol, {})
            for group in _split_sessions(bars)[-(1 if range_ == "1d" else 5) :]:
                sessions.append(SessionSpan(open=_iso(group[0]), close=_iso(group[-1])))
                for ts in group:
                    points.append(
                        HistoryPoint(
                            t=_iso(ts),
                            price_native=bars[ts],
                            fx_eur_usd=lookup_rate_with_forward_fill(fx, ts.date()),
                        )
                    )
        else:
            closes = yf_client.fetch_closes(
                [symbol], _range_start(range_, today), today + timedelta(days=1)
            ).get(symbol, {})
            for day in sorted(closes):
                points.append(
                    HistoryPoint(
                        t=day.isoformat(),
                        price_native=closes[day],
                        fx_eur_usd=lookup_rate_with_forward_fill(fx, day),
                    )
                )
    except yf_client.YFinanceError as exc:
        raise _upstream(f"history {symbol} {range_}", exc) from exc
    if not points:
        raise NotFoundError(f"No price history found for {symbol}.")
    result = History(
        symbol=symbol,
        currency=_currency_of(session, symbol),
        range=range_,
        x_mode="time" if range_ in ("1d", "1w") else "date",
        sessions=sessions,
        points=points,
    )
    _cache_put(symbol, key, result)
    return result
