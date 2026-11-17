"""Ledger completeness (v7 P7): spot dividends the provider paid but the ledger lacks.

Pure logic, no I/O. The provider's ex-dividend dates are matched against the
ledger's share history: on every ex-date on which shares were held (bought
*before* the ex-date), the ledger should show a dividend, a reinvestment or (for
money-market funds) an interest/distribution row within a window after it. Pay
dates trail ex-dates by days to weeks, so the window is generous (60 days) and an
ex-date is only judged once its window has fully elapsed.

Money-market funds distribute monthly (often accrued daily), so their ex-dates are
folded into calendar months and a month is judged as a whole instead.

Output is a hint only: nothing here ever writes or fixes anything.
"""

from __future__ import annotations

import calendar
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from investment_dashboard.domain import kinds

#: Days after an ex-date within which the matching ledger row is expected.
DEFAULT_WINDOW_DAYS = 60
#: Fewer shares than this count as "not held" (rounding dust after a sale).
MIN_HELD_SHARES = Decimal("0.0000001")
#: Money-market distributions are booked as dividends or as interest.
_MONEY_MARKET_PAYOUT_KINDS: frozenset[str] = kinds.DIVIDEND_KINDS | {kinds.INTEREST}
#: A money-market month is judged once this many days after its end have passed.
_MONEY_MARKET_GRACE_DAYS = 31


@dataclass(frozen=True)
class LedgerEvent:
    """The slice of one ledger row the check needs (one instrument)."""

    date: date
    kind: str
    quantity: Decimal | None = None
    account_id: int | None = None


@dataclass(frozen=True)
class MissingDividend:
    """One hint: shares were held on ``ex_date`` but no payout row follows."""

    ex_date: date
    shares_held: Decimal


def shares_held_before(events: Iterable[LedgerEvent], day: date) -> Decimal:
    """Shares held at the close of the day before ``day`` (the ex-date entitlement).

    A buy dated on the ex-date itself does not earn that dividend. Quantities are
    signed (sells negative), and only share-moving kinds count.
    """
    total = Decimal(0)
    for event in events:
        if event.date < day and event.kind in kinds.SHARE_MOVING_KINDS:
            total += event.quantity or Decimal(0)
    return total


def _has_payout(
    events: Sequence[LedgerEvent], start: date, end: date, payout_kinds: frozenset[str]
) -> bool:
    return any(start <= e.date <= end and e.kind in payout_kinds for e in events)


def find_missing_dividends(
    ex_dates: Iterable[date],
    events: Sequence[LedgerEvent],
    *,
    today: date,
    window_days: int = DEFAULT_WINDOW_DAYS,
) -> list[MissingDividend]:
    """Ex-dates (oldest first) with shares held but no dividend row inside the window.

    Ex-dates whose window has not yet elapsed are skipped (the payment may still be
    on its way), as are ex-dates on which nothing was held.
    """
    out: list[MissingDividend] = []
    for ex in sorted(set(ex_dates)):
        if ex + timedelta(days=window_days) >= today:
            continue
        held = shares_held_before(events, ex)
        if held <= MIN_HELD_SHARES:
            continue
        if not _has_payout(events, ex, ex + timedelta(days=window_days), kinds.DIVIDEND_KINDS):
            out.append(MissingDividend(ex_date=ex, shares_held=held))
    return out


def find_missing_money_market_distributions(
    ex_dates: Iterable[date],
    events: Sequence[LedgerEvent],
    *,
    today: date,
) -> list[MissingDividend]:
    """Months with a distribution date, shares held, and no payout row in the month.

    The month's ex-dates collapse to the latest one (reported). A payout is accepted
    anywhere from the first of the month to a month after its end; a month is judged
    only after that grace has passed.
    """
    latest_by_month: dict[tuple[int, int], date] = {}
    for ex in ex_dates:
        key = (ex.year, ex.month)
        if key not in latest_by_month or ex > latest_by_month[key]:
            latest_by_month[key] = ex
    out: list[MissingDividend] = []
    for (year, month), ex in sorted(latest_by_month.items()):
        month_start = date(year, month, 1)
        month_end = date(year, month, calendar.monthrange(year, month)[1])
        deadline = month_end + timedelta(days=_MONEY_MARKET_GRACE_DAYS)
        if deadline >= today:
            continue
        held = shares_held_before(events, ex)
        if held <= MIN_HELD_SHARES:
            continue
        if not _has_payout(events, month_start, deadline, _MONEY_MARKET_PAYOUT_KINDS):
            out.append(MissingDividend(ex_date=ex, shares_held=held))
    return out


def days_since(last: date | None, today: date) -> int | None:
    """Whole days from ``last`` to ``today`` (never negative); ``None`` if never."""
    if last is None:
        return None
    return max(0, (today - last).days)


# --- splits (v7 P7): provider splits against the ledger's split rows ---------

#: A ledger split row counts as the provider's split within this many days.
SPLIT_DATE_TOLERANCE_DAYS = 3
#: Relative difference under which two split ratios are "the same" (brokers round).
SPLIT_RATIO_TOLERANCE = Decimal("0.001")
#: Typed broker share counts match the ledger within this many shares.
SHARE_COUNT_TOLERANCE = Decimal("0.0001")


@dataclass(frozen=True)
class LedgerSplit:
    """A ``split`` row of the ledger, as the ratio ``shares after / shares before``."""

    date: date
    ratio: Decimal


@dataclass(frozen=True)
class MissingSplit:
    """A provider split with shares held and no matching ledger split row."""

    date: date
    ratio: Decimal
    shares_held: Decimal


def ledger_splits(events: Sequence[LedgerEvent]) -> list[LedgerSplit]:
    """The ledger's split rows as ratios, replayed per account (rows carry added shares).

    Events must be in ledger order (date, then id). Splits with nothing held before
    them have no ratio and are skipped; identical (date, ratio) pairs from several
    accounts collapse into one.
    """
    running: dict[int | None, Decimal] = {}
    found: dict[tuple[date, Decimal], LedgerSplit] = {}
    for e in events:
        if e.kind not in kinds.SHARE_MOVING_KINDS:
            continue
        qty = e.quantity or Decimal(0)
        before = running.get(e.account_id, Decimal(0))
        if e.kind == kinds.SPLIT and before > MIN_HELD_SHARES:
            ratio = ((before + qty) / before).quantize(Decimal("0.000001"))
            found.setdefault((e.date, ratio), LedgerSplit(date=e.date, ratio=ratio))
        running[e.account_id] = before + qty
    return sorted(found.values(), key=lambda s: (s.date, s.ratio))


def _same_ratio(a: Decimal, b: Decimal) -> bool:
    return abs(a - b) <= SPLIT_RATIO_TOLERANCE * max(abs(a), abs(b))


def _split_matches(
    on: date, ratio: Decimal, others: Iterable[tuple[date, Decimal]], tolerance_days: int
) -> bool:
    return any(abs((on - d).days) <= tolerance_days and _same_ratio(ratio, r) for d, r in others)


def find_missing_splits(
    provider_splits: Iterable[tuple[date, Decimal]],
    events: Sequence[LedgerEvent],
    *,
    tolerance_days: int = SPLIT_DATE_TOLERANCE_DAYS,
) -> list[MissingSplit]:
    """Provider splits with shares held on their date and no matching ledger split row.

    "Matching" is the same ratio on a date within ``tolerance_days``. A ratio of 1
    (a feed correction) and splits on which nothing was held are skipped.
    """
    ledger = [(s.date, s.ratio) for s in ledger_splits(events)]
    out: list[MissingSplit] = []
    for on, ratio in sorted(set(provider_splits)):
        if ratio == 1:
            continue
        held = shares_held_before(events, on)
        if held <= MIN_HELD_SHARES:
            continue
        if not _split_matches(on, ratio, ledger, tolerance_days):
            out.append(MissingSplit(date=on, ratio=ratio, shares_held=held))
    return out


def find_unmatched_ledger_splits(
    provider_splits: Iterable[tuple[date, Decimal]],
    events: Sequence[LedgerEvent],
    *,
    tolerance_days: int = SPLIT_DATE_TOLERANCE_DAYS,
) -> list[LedgerSplit]:
    """Ledger split rows the provider has no matching split for (a softer hint)."""
    provider = list(provider_splits)
    return [
        s
        for s in ledger_splits(events)
        if not _split_matches(s.date, s.ratio, provider, tolerance_days)
    ]


# --- broker share counts (v7 P7) ----------------------------------------------


@dataclass(frozen=True)
class ShareCountMismatch:
    """A typed broker share count that differs from the ledger's total."""

    account_id: int
    instrument_id: int
    ledger: Decimal
    typed: Decimal


def ledger_share_totals(
    events_by_instrument: dict[int, Sequence[LedgerEvent]],
) -> dict[tuple[int, int], Decimal]:
    """Ledger shares per ``(account_id, instrument_id)`` (all share-moving rows)."""
    totals: dict[tuple[int, int], Decimal] = {}
    for instrument_id, events in events_by_instrument.items():
        for e in events:
            if e.account_id is None or e.kind not in kinds.SHARE_MOVING_KINDS:
                continue
            key = (e.account_id, instrument_id)
            totals[key] = totals.get(key, Decimal(0)) + (e.quantity or Decimal(0))
    return totals


def find_share_count_mismatches(
    ledger_totals: dict[tuple[int, int], Decimal],
    typed: dict[tuple[int, int], Decimal],
    *,
    tolerance: Decimal = SHARE_COUNT_TOLERANCE,
) -> list[ShareCountMismatch]:
    """Typed ``(account, instrument)`` counts differing from the ledger by over ``tolerance``.

    A typed count with no ledger rows compares against zero.
    """
    out: list[ShareCountMismatch] = []
    for (account_id, instrument_id), typed_shares in sorted(typed.items()):
        have = ledger_totals.get((account_id, instrument_id), Decimal(0))
        if abs(have - typed_shares) > tolerance:
            out.append(ShareCountMismatch(account_id, instrument_id, have, typed_shares))
    return out
