"""Purchase tranches: a FIFO *view* of one instrument's buys (7.1, plan §6.1).

Pure replay over plain ledger rows, per ``(account, instrument)``: every buy,
reinvested dividend and in-kind ``transfer_in`` opens a tranche; sells and in-kind
``transfer_out`` rows consume the oldest open tranches first. Rows replay in
``(date, transaction id)`` order, so a same-day buy and sell always resolve the
same way whatever order they arrive in.

A ``split`` row (its ``quantity`` is the share-count delta, as in
``services.ledger_walk``) scales every open tranche of that account by
``(shares + delta) / shares``: quantities grow, cost per share shrinks, total cost
is unchanged. The share counts therefore stay on the ledger's own basis, which is
the basis today's (split back-adjusted) close values, as ``positions_service``
does for today.

This is a display view only. The app's gains, growth and XIRR use average cost
per account; tranche figures never feed an aggregate.

Native currency throughout, ``Decimal`` end to end.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Literal

from investment_dashboard.domain import kinds

ZERO = Decimal(0)
#: A tranche with fewer shares left than this is fully sold (Decimal dust after
#: an uneven split ratio must not keep it open).
DUST = Decimal("1e-9")
#: ``matches_position`` tolerance between the tranche sum and the position.
MATCH_TOLERANCE = Decimal("1e-6")
#: "soon" = long-term within this many days.
SOON_DAYS = 60

Source = Literal["buy", "reinvest", "transfer_in"]
Status = Literal["long", "soon", "short"]


@dataclass(frozen=True)
class TrancheTxn:
    """One ledger row of the instrument, as plain values (no ORM)."""

    id: int
    account_id: int
    date: date
    kind: str
    #: Signed share count (sells negative; a split's share delta).
    quantity: Decimal | None
    #: Signed booked cash (a buy is negative, fees included).
    net_native: Decimal | None
    price_native: Decimal | None


@dataclass(frozen=True)
class Tranche:
    """One purchase after the replay (split-adjusted shares, native cost)."""

    id: int
    account_id: int
    acquired_on: date
    source: Source
    #: Shares bought, on today's split basis.
    quantity_bought: Decimal
    quantity_left: Decimal
    #: Cost of the shares still held (the bought cost less what sells released).
    cost_native: Decimal
    cost_per_share_native: Decimal

    @property
    def is_open(self) -> bool:
        return self.quantity_left > DUST


@dataclass
class _Open:
    id: int
    account_id: int
    acquired_on: date
    source: Source
    bought: Decimal
    left: Decimal
    cost_left: Decimal
    cost_bought: Decimal


def _sorted(txns: Iterable[TrancheTxn]) -> list[TrancheTxn]:
    return sorted(txns, key=lambda t: (t.date, t.id))


def _opening(t: TrancheTxn, *, money_market: bool) -> tuple[Source, Decimal] | None:
    """``(source, cost)`` when ``t`` opens a tranche, else ``None``."""
    qty = t.quantity or ZERO
    if qty <= ZERO:
        return None
    if t.kind == kinds.BUY:
        cost = -t.net_native if t.net_native is not None else qty * (t.price_native or ZERO)
        return "buy", cost
    if t.kind == kinds.DIVIDEND_REINVEST:
        # Same rule as ledger_walk: a money-market fund's reinvested income is
        # return, not cost.
        cost = ZERO if money_market or t.price_native is None else qty * t.price_native
        return "reinvest", cost
    if t.kind == kinds.TRANSFER_IN:
        return "transfer_in", qty * (t.price_native or ZERO)
    return None


def replay(txns: Iterable[TrancheTxn], *, money_market: bool = False) -> list[Tranche]:
    """Every tranche of one instrument (open and fully sold), oldest first."""
    by_account: dict[int, list[_Open]] = {}
    every: list[_Open] = []
    for t in _sorted(txns):
        lots = by_account.setdefault(t.account_id, [])
        qty = t.quantity or ZERO
        opening = _opening(t, money_market=money_market)
        if opening is not None:
            source, cost = opening
            lot = _Open(t.id, t.account_id, t.date, source, qty, qty, cost, cost)
            lots.append(lot)
            every.append(lot)
        elif t.kind in {kinds.SELL, kinds.TRANSFER_OUT} and qty < ZERO:
            remaining = -qty
            for lot in lots:
                if remaining <= ZERO:
                    break
                if lot.left <= DUST:
                    continue
                take = min(remaining, lot.left)
                lot.cost_left -= lot.cost_left * take / lot.left
                lot.left -= take
                remaining -= take
                if lot.left <= DUST:
                    lot.left = ZERO
                    lot.cost_left = ZERO
        elif t.kind == kinds.SPLIT and qty != ZERO:
            held = sum((lot.left for lot in lots), start=ZERO)
            if held > ZERO:
                factor = (held + qty) / held
                for lot in lots:
                    lot.left *= factor
                    lot.bought *= factor
    out: list[Tranche] = []
    for lot in every:
        per_share = lot.cost_bought / lot.bought if lot.bought else ZERO
        out.append(
            Tranche(
                id=lot.id,
                account_id=lot.account_id,
                acquired_on=lot.acquired_on,
                source=lot.source,
                quantity_bought=lot.bought,
                quantity_left=lot.left,
                cost_native=lot.cost_left,
                cost_per_share_native=per_share,
            )
        )
    return out


def long_term_on(acquired: date) -> date:
    """First long-term day: acquisition + 1 year + 1 day.

    29 Feb has no anniversary, so its year ends on 1 Mar: a lot bought
    29 Feb 2024 is long-term on 2 Mar 2025.
    """
    try:
        anniversary = acquired.replace(year=acquired.year + 1)
    except ValueError:  # 29 Feb
        anniversary = date(acquired.year + 1, 3, 1)
    return anniversary + timedelta(days=1)


@dataclass(frozen=True)
class TrancheRow:
    tranche: Tranche
    age_days: int
    long_term_on: date
    #: ``None`` once long-term.
    days_to_long_term: int | None
    status: Status
    gain_native: Decimal | None
    gain_pct: Decimal | None


@dataclass(frozen=True)
class ReinvestGroup:
    account_id: int
    count: int
    quantity_left: Decimal
    cost_native: Decimal
    avg_cost_per_share_native: Decimal | None
    gain_native: Decimal | None
    gain_pct: Decimal | None
    long_count: int
    short_count: int
    row_ids: tuple[int, ...]


@dataclass(frozen=True)
class TrancheTotals:
    quantity_left: Decimal
    position_quantity: Decimal
    matches_position: bool
    long_quantity: Decimal
    short_quantity: Decimal
    fully_sold_count: int


@dataclass(frozen=True)
class TrancheView:
    rows: tuple[TrancheRow, ...]
    groups: tuple[ReinvestGroup, ...]
    totals: TrancheTotals


def _gain(
    quantity: Decimal, cost: Decimal, price: Decimal | None
) -> tuple[Decimal | None, Decimal | None]:
    if price is None:
        return None, None
    gain = quantity * price - cost
    return gain, (gain / cost if cost > ZERO else None)


def classify(tranche: Tranche, *, as_of: date, price_native: Decimal | None) -> TrancheRow:
    """Age, holding-period status and gain against ``price_native`` for one tranche."""
    lt = long_term_on(tranche.acquired_on)
    days_left = (lt - as_of).days
    if days_left <= 0:
        status: Status = "long"
        days: int | None = None
    else:
        status = "soon" if days_left <= SOON_DAYS else "short"
        days = days_left
    gain, pct = _gain(tranche.quantity_left, tranche.cost_native, price_native)
    return TrancheRow(
        tranche=tranche,
        age_days=(as_of - tranche.acquired_on).days,
        long_term_on=lt,
        days_to_long_term=days,
        status=status,
        gain_native=gain,
        gain_pct=pct,
    )


def build_view(
    tranches: Sequence[Tranche],
    *,
    as_of: date,
    price_native: Decimal | None,
    position_quantity: Decimal,
) -> TrancheView:
    """Open rows (oldest first), reinvest groups per account, and the totals."""
    open_ = sorted((t for t in tranches if t.is_open), key=lambda t: (t.acquired_on, t.id))
    rows = tuple(classify(t, as_of=as_of, price_native=price_native) for t in open_)

    groups: list[ReinvestGroup] = []
    for account_id in dict.fromkeys(r.tranche.account_id for r in rows):
        members = [
            r for r in rows if r.tranche.account_id == account_id and r.tranche.source == "reinvest"
        ]
        if not members:
            continue
        qty = sum((r.tranche.quantity_left for r in members), start=ZERO)
        cost = sum((r.tranche.cost_native for r in members), start=ZERO)
        gain, pct = _gain(qty, cost, price_native)
        long_count = sum(1 for r in members if r.status == "long")
        groups.append(
            ReinvestGroup(
                account_id=account_id,
                count=len(members),
                quantity_left=qty,
                cost_native=cost,
                avg_cost_per_share_native=cost / qty if qty > ZERO else None,
                gain_native=gain,
                gain_pct=pct,
                long_count=long_count,
                short_count=len(members) - long_count,
                row_ids=tuple(r.tranche.id for r in members),
            )
        )

    left = sum((r.tranche.quantity_left for r in rows), start=ZERO)
    long_qty = sum((r.tranche.quantity_left for r in rows if r.status == "long"), start=ZERO)
    totals = TrancheTotals(
        quantity_left=left,
        position_quantity=position_quantity,
        matches_position=abs(left - position_quantity) <= MATCH_TOLERANCE,
        long_quantity=long_qty,
        short_quantity=left - long_qty,
        fully_sold_count=sum(1 for t in tranches if not t.is_open),
    )
    return TrancheView(rows=rows, groups=tuple(groups), totals=totals)
