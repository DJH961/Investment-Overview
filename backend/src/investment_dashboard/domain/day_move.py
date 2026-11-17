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


@dataclass(frozen=True)
class HoldingDaySplit:
    """A holding's day move cut into the day (market hours) and the night (currency), per currency.

    Market open: ``session`` = B+C and ``overnight`` = A (last night), which add up
    to the row's ``today_move``. Market shut (:func:`holding_day_split`): the row's
    ``today_move`` is frozen A+B+C, ``session`` = B+C and ``overnight`` = D, the
    currency since the close, which is NOT part of it. The % share the previous-mark
    base. In USD a USD-native holding has no overnight move at all.
    """

    session_eur: Decimal | None
    session_usd: Decimal | None
    overnight_eur: Decimal | None
    overnight_usd: Decimal | None
    session_pct_eur: Decimal | None
    session_pct_usd: Decimal | None
    overnight_pct_eur: Decimal | None
    overnight_pct_usd: Decimal | None


_CENT = Decimal("0.01")


def _cents(value: Decimal) -> Decimal:
    return value.quantize(_CENT, rounding="ROUND_HALF_UP")


def _split_leg(
    now: Decimal | None, at_close: Decimal | None, prev: Decimal | None
) -> tuple[Decimal | None, Decimal | None, Decimal | None, Decimal | None]:
    if now is None or at_close is None or prev is None:
        return None, None, None, None
    session = _cents(at_close - prev)
    overnight = _cents(now - prev) - session
    if prev <= ZERO:
        return session, overnight, None, None
    return session, overnight, (at_close - prev) / prev, (now - at_close) / prev


def _night_leg(
    live: Decimal | None,
    at_close: Decimal | None,
    prev: Decimal | None,
    at_open: Decimal | None,
) -> tuple[Decimal | None, Decimal | None, Decimal | None, Decimal | None]:
    """``(day, night, day %, night %)`` of one currency leg once the market has shut.

    ``day`` = B+C = (close - prev) - A, with A = ``at_open - prev`` (the previous
    book revalued to the session's open rate; no open rate -> A = 0, so ``day`` is
    the whole frozen total A+B+C). ``night`` = D = ``live - at_close`` (informational,
    never part of the total). Cents like :func:`_split_leg`; the % share ``prev``.
    """
    if live is None or at_close is None or prev is None:
        return None, None, None, None
    lead = (at_open - prev) if at_open is not None else ZERO
    day = _cents(at_close - prev) - _cents(lead)
    night = _cents(live - at_close)
    if prev <= ZERO:
        return day, night, None, None
    return day, night, ((at_close - prev) - lead) / prev, (live - at_close) / prev


def holding_day_split(
    *,
    shares: Decimal,
    native_currency: str,
    legs: DayLegs,
    rate_close: Decimal | None,
    rate_live: Decimal | None,
    rate_prev: Decimal | None,
    rate_open: Decimal | None = None,
) -> HoldingDaySplit:
    """The day / night cut of a holding's day move once the market has shut.

    The owner's day rule (2026-11-16): the day figure (``holding_day_move`` with its
    now mark at ``rate_close``) is FROZEN at the close, A+B+C. ``session`` is its
    market-hours part B+C (the total minus A, last night's currency move: the
    previous close's holding revalued from ``rate_prev`` to the session's
    ``rate_open``); ``overnight`` is D, the same close holding revalued from
    ``rate_close`` to the live ``rate_live`` and NOT part of the total.
    """
    last_native = shares * legs.close_last
    prev_native = shares * legs.close_prev
    live_eur, live_usd = convert_native(last_native, native_currency, rate_live)
    close_eur, close_usd = convert_native(last_native, native_currency, rate_close)
    prev_eur, prev_usd = convert_native(prev_native, native_currency, rate_prev)
    open_eur, open_usd = (
        convert_native(prev_native, native_currency, rate_open)
        if rate_open is not None and rate_open > ZERO
        else (None, None)
    )
    s_eur, o_eur, sp_eur, op_eur = _night_leg(live_eur, close_eur, prev_eur, open_eur)
    s_usd, o_usd, sp_usd, op_usd = _night_leg(live_usd, close_usd, prev_usd, open_usd)
    return HoldingDaySplit(s_eur, s_usd, o_eur, o_usd, sp_eur, sp_usd, op_eur, op_usd)


def holding_open_day_split(
    *,
    shares: Decimal,
    native_currency: str,
    legs: DayLegs,
    rate_open: Decimal | None,
    rate_last: Decimal | None,
    rate_prev: Decimal | None,
) -> HoldingDaySplit:
    """The same cut while the market trades: last night's overnight, then the session.

    ``overnight`` is the previous close's holding (``shares x close_prev``) revalued from
    the previous close rate ``rate_prev`` to the rate at today's open ``rate_open``
    (the same revaluation as ``metrics_service.fx_revaluation``); ``session`` is the rest of
    the day move (prices and intraday FX), so the two add up to :func:`holding_day_move`.
    """
    prev_native = shares * legs.close_prev
    now_eur, now_usd = convert_native(shares * legs.close_last, native_currency, rate_last)
    prev_eur, prev_usd = convert_native(prev_native, native_currency, rate_prev)
    open_eur, open_usd = convert_native(prev_native, native_currency, rate_open)
    return open_day_split(
        now=(now_eur, now_usd), at_open=(open_eur, open_usd), prev=(prev_eur, prev_usd)
    )


def open_day_split(
    *,
    now: tuple[Decimal | None, Decimal | None],
    at_open: tuple[Decimal | None, Decimal | None],
    prev: tuple[Decimal | None, Decimal | None],
) -> HoldingDaySplit:
    """The market-open cut from three ``(eur, usd)`` marks of one holding.

    ``prev`` is the previous close's holding at the previous close rate, ``at_open``
    the same holding at the rate of today's open and ``now`` the holding now (its
    price now, at the rate now). Overnight = A = ``at_open - prev``; session = B+C =
    the rest, so ``session + overnight == now - prev``. The ONE cut for a priced
    holding (:func:`holding_open_day_split`) and for a pending fund at its ETF-twin
    estimate (``intraday_snapshots_service.estimate_day_split``), so an estimated
    row splits exactly like a priced one. Cents and % as :func:`_split_leg`.
    """
    # ``_split_leg(now, mid, prev)``: first part = mid - prev, rest = now - mid. With
    # ``mid`` = the previous close's holding at the open rate, the first part is the
    # OVERNIGHT and the rest the SESSION (the reverse of the shut-market cut).
    o_eur, s_eur, op_eur, sp_eur = _split_leg(now[0], at_open[0], prev[0])
    o_usd, s_usd, op_usd, sp_usd = _split_leg(now[1], at_open[1], prev[1])
    return HoldingDaySplit(s_eur, s_usd, o_eur, o_usd, sp_eur, sp_usd, op_eur, op_usd)


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
