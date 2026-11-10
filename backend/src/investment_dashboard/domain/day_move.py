"""A holding's day move (and a group's), in EUR and USD: the one pure definition.

Shared by the holdings rows (``readmodels.queries.overview_query``) and the live
tick (``services.scheduler``), so a tick never shows a different day figure than
the refetch that follows it.

Rules:

* both marks use **today's share count** (``shares x close``), so a buy or sale
  during the session is never a gain or loss of that holding (B-007);
* 💱 each mark is converted at **its own** rate: the previous close at that
  session's close rate, the current one at the rate now (live while the session
  trades). The EUR figure is therefore FX-aware; a return is never converted;
* the % is ``value_now / value_prev - 1``; a group's % is its summed move over
  its summed previous value (``move / (value - move)``).

Pure: no I/O.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

ZERO = Decimal(0)


@dataclass(frozen=True)
class DayLegs:
    """The two marks of a holding's day move.

    ``close_*`` are native prices; ``rate_date_*`` the dates whose EUR/USD rate
    converts each mark; ``as_of`` the print date the move lands on.
    """

    close_last: Decimal
    rate_date_last: date
    close_prev: Decimal
    rate_date_prev: date
    as_of: date


def select_day_legs(  # noqa: PLR0911 - one exit per case
    pairs: Sequence[tuple[date, Decimal | None]],
    *,
    latest_price_date: date | None,
    previous_price_date: date | None,
) -> DayLegs | None:
    """Pick the two marks from a holding's recent closes (newest first).

    ``latest_price_date`` / ``previous_price_date`` are the book's baseline
    sessions. A holding whose own newest print predates the baseline (a NAV not
    yet posted, or before the open) shows its own last *published* move (its two
    newest prints at their own dates); with only one print it forward-fills that
    price onto the baseline (an FX-only move). Otherwise its two newest closes are
    valued at the baseline dates. ``None`` when there is nothing to diff.
    """
    if not pairs:
        return None
    last_date, close_last = pairs[0]
    if close_last is None:
        return None
    if (
        latest_price_date is not None
        and previous_price_date is not None
        and last_date < latest_price_date
    ):
        own_prev = pairs[1] if len(pairs) >= 2 else None
        if own_prev is not None and own_prev[1] is not None:
            return DayLegs(close_last, last_date, own_prev[1], own_prev[0], last_date)
        return DayLegs(close_last, latest_price_date, close_last, previous_price_date, last_date)
    if len(pairs) < 2:
        return None
    prev_date, close_prev = pairs[1]
    if close_prev is None:
        return None
    return DayLegs(
        close_last,
        latest_price_date or last_date,
        close_prev,
        previous_price_date or prev_date,
        last_date,
    )


def convert_native(
    value_native: Decimal, native_currency: str, rate: Decimal | None
) -> tuple[Decimal | None, Decimal | None]:
    """``(eur, usd)`` of a native EUR or USD amount at one EUR/USD rate (USD per EUR).

    A missing rate leaves the converted leg ``None``; any other native currency
    gives ``(None, None)`` (no single EUR/USD rate converts it).
    """
    ccy = native_currency.upper()
    ok = rate is not None and rate > ZERO
    if ccy == "USD":
        return (value_native / rate if ok and rate is not None else None), value_native
    if ccy == "EUR":
        return value_native, (value_native * rate if ok and rate is not None else None)
    return None, None


@dataclass(frozen=True)
class HoldingDayMove:
    """A holding's day move per currency (``None``: not computable)."""

    move_eur: Decimal | None
    move_usd: Decimal | None
    pct_eur: Decimal | None
    pct_usd: Decimal | None
    #: The previous mark's value, the % base (for group sums).
    prev_eur: Decimal | None
    prev_usd: Decimal | None


def _leg(now: Decimal | None, prev: Decimal | None) -> tuple[Decimal | None, Decimal | None]:
    if now is None or prev is None:
        return None, None
    move = now - prev
    return move, (move / prev if prev > ZERO else None)


def holding_day_move(
    *,
    shares: Decimal,
    native_currency: str,
    legs: DayLegs,
    rate_last: Decimal | None,
    rate_prev: Decimal | None,
) -> HoldingDayMove:
    """The day move of ``shares`` between the two ``legs``, each at its own rate."""
    now_eur, now_usd = convert_native(shares * legs.close_last, native_currency, rate_last)
    prev_eur, prev_usd = convert_native(shares * legs.close_prev, native_currency, rate_prev)
    move_eur, pct_eur = _leg(now_eur, prev_eur)
    move_usd, pct_usd = _leg(now_usd, prev_usd)
    return HoldingDayMove(
        move_eur=move_eur,
        move_usd=move_usd,
        pct_eur=pct_eur,
        pct_usd=pct_usd,
        prev_eur=prev_eur if move_eur is not None else None,
        prev_usd=prev_usd if move_usd is not None else None,
    )


def group_day_pct(members: Iterable[tuple[Decimal | None, Decimal | None]]) -> Decimal | None:
    """A group's day %: ``sum(move) / sum(prev)`` over its ``(move, prev)`` members.

    Members without a move are left out (they are not priced); ``None`` when no
    member has one or the summed base is not positive.
    """
    move = ZERO
    base = ZERO
    priced = False
    for m, p in members:
        if m is None or p is None:
            continue
        move += m
        base += p
        priced = True
    if not priced or base <= ZERO:
        return None
    return move / base
