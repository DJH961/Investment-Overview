"""Detect a price feed that keeps answering but serves frozen quotes.

On 2026-11-05 yfinance answered every pull for about 100 minutes during US
trading hours, but with exactly the same stock/ETF prices and EUR/USD rate each
time. Every pull looked successful, so the app called the data "Live", stored a
flat line in the 1 Day graph and the Data Health page saw nothing wrong. When the
quotes moved again the line jumped.

This module is the pure state machine that spots such a stall from what each pull
returned. It knows nothing about providers, the database or the clock: the
service feeds it one :func:`observe` call per pull and acts on the result.

A stall is declared when, while the market is open, either

* the newest quote's own market time (when the provider says the price was struck)
  is older than :data:`STALL_AFTER_SECONDS`, or
* every intraday-priced quote has been exactly unchanged for at least
  :data:`STALL_AFTER_SECONDS` of pulls (a dozen liquid ETFs never all sit still
  for four minutes in a trading session).

It ends at the first pull that returns moved prices with a recent market time, or
when the market closes.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from decimal import Decimal

#: How long quotes may sit unchanged (or the newest quote may be old) before the
#: feed counts as stalled. Pulls run about once a minute, so this is about four
#: identical pulls in a row.
STALL_AFTER_SECONDS = 240.0


def _aware(at: datetime) -> datetime:
    return at.replace(tzinfo=UTC) if at.tzinfo is None else at


@dataclass(frozen=True)
class StallState:
    """What the detector remembers between pulls."""

    #: The intraday quotes the last pull returned, ``{symbol: price}``.
    signature: tuple[tuple[str, Decimal], ...] = ()
    #: When the current ``signature`` was first seen (prices last moved).
    signature_since: datetime | None = None
    #: Start of the stall in progress (when prices last moved), else ``None``.
    stalled_since: datetime | None = None


@dataclass(frozen=True)
class StallChange:
    """A stall that started or ended on this pull (``None`` fields: no change)."""

    started: datetime | None = None
    #: ``(start, end)`` of a stall that just ended.
    ended: tuple[datetime, datetime] | None = None


def _signature(quotes: Mapping[str, Decimal]) -> tuple[tuple[str, Decimal], ...]:
    return tuple(sorted(quotes.items()))


def observe(  # noqa: PLR0911 - one exit per detector transition
    state: StallState,
    *,
    now: datetime,
    market_open: bool,
    quotes: Mapping[str, Decimal],
    newest_market_time: datetime | None,
) -> tuple[StallState, StallChange]:
    """Fold one pull's result into ``state``.

    ``quotes`` are the current-session prices of the intraday-priced holdings the
    pull returned (empty when it returned none). ``newest_market_time`` is the
    most recent provider market time among them, or ``None`` when unknown.
    Returns the new state and whether a stall started or ended.
    """
    now = _aware(now)
    if not market_open:
        if state.stalled_since is not None:
            return StallState(), StallChange(ended=(state.stalled_since, now))
        return StallState(), StallChange()
    if not quotes:
        # Nothing priced intraday came back: no evidence either way.
        return state, StallChange()

    signature = _signature(quotes)
    if signature != state.signature or state.signature_since is None:
        moved = replace(state, signature=signature, signature_since=now)
        # Moved prices end a stall only when the quotes are also recent: a frozen
        # feed can still flip one value (a late print) without being live again.
        if state.stalled_since is not None and not _old(newest_market_time, now):
            return replace(moved, stalled_since=None), StallChange(ended=(state.stalled_since, now))
        if state.stalled_since is None and _old(newest_market_time, now):
            start = _aware(newest_market_time) if newest_market_time is not None else now
            return replace(moved, stalled_since=start), StallChange(started=start)
        return moved, StallChange()

    unchanged_for = (now - _aware(state.signature_since)).total_seconds()
    stalled = unchanged_for >= STALL_AFTER_SECONDS or _old(newest_market_time, now)
    if stalled and state.stalled_since is None:
        start = _aware(state.signature_since)
        if newest_market_time is not None:
            start = min(start, _aware(newest_market_time))
        return replace(state, stalled_since=start), StallChange(started=start)
    return state, StallChange()


def _old(market_time: datetime | None, now: datetime) -> bool:
    if market_time is None:
        return False
    return (now - _aware(market_time)).total_seconds() > STALL_AFTER_SECONDS


def frozen_points(
    samples: list[tuple[datetime, Decimal]],
    *,
    min_seconds: float = STALL_AFTER_SECONDS,
) -> list[datetime]:
    """Instants of stored graph points that only repeat a frozen value.

    ``samples`` are ``(captured_at, value)`` pairs. A *run* is consecutive points
    (by time) with exactly the same value. A run lasting at least ``min_seconds``
    is a frozen feed, not a market that stood still; its first point is the last
    real price and is kept, every later point of the run is returned. Shorter runs
    (an unchanged pull between two moves) are left alone.
    """
    ordered = sorted(samples)
    out: list[datetime] = []
    i = 0
    while i < len(ordered):
        j = i
        while j + 1 < len(ordered) and ordered[j + 1][1] == ordered[i][1]:
            j += 1
        if (ordered[j][0] - ordered[i][0]).total_seconds() >= min_seconds:
            out.extend(t for t, _ in ordered[i + 1 : j + 1])
        i = j + 1
    return out


def merge_windows(
    windows: list[tuple[datetime, datetime]],
) -> list[tuple[datetime, datetime]]:
    """Sort and merge overlapping or touching ``(start, end)`` windows."""
    out: list[tuple[datetime, datetime]] = []
    for start, end in sorted((_aware(s), _aware(e)) for s, e in windows):
        if end <= start:
            continue
        if out and start <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], end))
        else:
            out.append((start, end))
    return out
