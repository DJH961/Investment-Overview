"""Smart import matching: which import rows are *updates* of existing transactions.

An import row that is almost identical to a transaction already in the ledger
(same account, instrument and kind; date within a business day; amount and
quantity within a small tolerance) is the same event booked again with slightly
different figures (a settled price replacing an estimate, a rounding change).
It is not a new row: the import updates the existing one.

Pure: no I/O. Exact duplicates are handled before this (``importer_service``);
only the leftovers reach :func:`match_updates`.

Rules:

* near-match = same account, same symbol, same kind, ``business_day_gap <=
  tolerance.business_days``, and amount and quantity each within
  ``max(rel * max(|a|, |b|), abs)`` (symmetric in the two values);
* each existing transaction absorbs at most one incoming row, and each incoming
  row takes at most one existing one;
* an existing row is matched by its profile: ``normal`` or ``estimated`` (a recurring-plan
  estimate: wider date/amount tolerance, trade quantity ignored); estimated rows are
  preferred over confirmed ones;
* conflicts are settled globally, estimated first, then closest pair (date distance, then amount,
  then quantity distance), ties by the rows' keys, so the result never depends on
  the order the rows arrive in.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from investment_dashboard.domain.market_hours import is_trading_day

#: Calendar days beyond which a pair can never be within the business-day limit
#: (long holiday stretches included); keeps :func:`business_day_gap` cheap.
_MAX_SCAN_DAYS = 14


#: Profile of an existing transaction: a confirmed one, or an estimate booked from a
#: recurring plan (looser rules, and preferred when both are candidates).
PROFILE_NORMAL = "normal"
PROFILE_ESTIMATED = "estimated"
#: Kinds whose quantity follows the price.
_TRADE_KINDS = frozenset({"buy", "sell"})


@dataclass(frozen=True)
class MatchTolerance:
    """How close two transactions must be to count as the same one."""

    #: Relative tolerance on amount and quantity (a fraction: 0.005 = 0.5 %).
    relative: Decimal = Decimal("0.005")
    #: Absolute tolerance on the amount, in the account's native currency.
    absolute_amount: Decimal = Decimal("0.05")
    #: Absolute tolerance on the quantity, in shares.
    absolute_quantity: Decimal = Decimal("0.0001")
    #: Largest date distance, in NYSE sessions.
    business_days: int = 1
    #: Skip the quantity check for buys and sells (it follows the price, which
    #: an estimate does not know).
    ignore_trade_quantity: bool = False


#: The looser rules for estimated rows: 3 sessions, 2 % or 0.50, quantity ignored.
ESTIMATED_TOLERANCE = MatchTolerance(
    relative=Decimal("0.02"),
    absolute_amount=Decimal("0.50"),
    absolute_quantity=Decimal("0.0001"),
    business_days=3,
    ignore_trade_quantity=True,
)


@dataclass(frozen=True)
class TxnFigures:
    """The fields matching looks at. ``key`` identifies the row (unique per side)."""

    key: str
    account_id: int
    symbol: str | None
    kind: str
    on: date
    quantity: Decimal | None
    net: Decimal | None
    #: How the *existing* row is matched (ignored on the incoming side).
    profile: str = PROFILE_NORMAL


def business_day_gap(a: date, b: date) -> int:
    """NYSE sessions strictly after the earlier date up to and including the later.

    Friday -> Monday is 1, Saturday -> Monday is 1, Friday -> Saturday is 0,
    a date with itself is 0. Symmetric. Capped: far-apart dates return a large
    number.
    """
    lo, hi = (a, b) if a <= b else (b, a)
    if (hi - lo).days > _MAX_SCAN_DAYS:
        return _MAX_SCAN_DAYS
    gap = 0
    day = lo
    while day < hi:
        day += timedelta(days=1)
        if is_trading_day(day):
            gap += 1
    return gap


def within_tolerance(
    a: Decimal | None, b: Decimal | None, *, relative: Decimal, absolute: Decimal
) -> bool:
    """Two figures are close enough; ``None`` only matches ``None``. Symmetric."""
    if a is None or b is None:
        return a is None and b is None
    allowed = max(relative * max(abs(a), abs(b)), absolute)
    return abs(a - b) <= allowed


def _same_thing(a: TxnFigures, b: TxnFigures) -> bool:
    return (
        a.account_id == b.account_id
        and (a.symbol or "").upper() == (b.symbol or "").upper()
        and a.kind == b.kind
    )


def is_near_match(existing: TxnFigures, incoming: TxnFigures, tol: MatchTolerance) -> bool:
    """Whether ``incoming`` could be the same transaction as ``existing``."""
    return (
        _same_thing(existing, incoming)
        and business_day_gap(existing.on, incoming.on) <= tol.business_days
        and within_tolerance(
            existing.net, incoming.net, relative=tol.relative, absolute=tol.absolute_amount
        )
        and (
            (tol.ignore_trade_quantity and existing.kind in _TRADE_KINDS)
            or within_tolerance(
                existing.quantity,
                incoming.quantity,
                relative=tol.relative,
                absolute=tol.absolute_quantity,
            )
        )
    )


def _distance(a: Decimal | None, b: Decimal | None) -> Decimal:
    return Decimal(0) if a is None or b is None else abs(a - b)


def match_updates(
    existing: Sequence[TxnFigures],
    incoming: Sequence[TxnFigures],
    tol: MatchTolerance | None = None,
    estimated_tol: MatchTolerance | None = None,
) -> dict[str, str]:
    """``{incoming key: existing key}`` for every incoming row that updates one.

    Keys must be unique within each side. See the module doc for the rules.
    """
    tol = tol or MatchTolerance()
    estimated_tol = estimated_tol or ESTIMATED_TOLERANCE
    pairs: list[tuple[int, int, Decimal, Decimal, str, str]] = []
    for inc in incoming:
        for ex in existing:
            estimated = ex.profile == PROFILE_ESTIMATED
            if is_near_match(ex, inc, estimated_tol if estimated else tol):
                pairs.append(
                    (
                        0 if estimated else 1,
                        business_day_gap(ex.on, inc.on),
                        _distance(ex.net, inc.net),
                        _distance(ex.quantity, inc.quantity),
                        ex.key,
                        inc.key,
                    )
                )
    pairs.sort()
    used_existing: set[str] = set()
    out: dict[str, str] = {}
    for _rank, _gap, _net, _qty, ex_key, inc_key in pairs:
        if ex_key in used_existing or inc_key in out:
            continue
        used_existing.add(ex_key)
        out[inc_key] = ex_key
    return out
