"""The broker cash pool: which euros paid for every dollar (7.4 contract section 3).

Pure: no I/O, no ORM rows. One pass over plain events (date, rank, id order) keeps a
first-in-first-out queue of :class:`PoolLot` per account. Every lot is native money of
its account currency (generic: ``ccy`` is whatever the account holds) and carries the
euros behind it:

* ``orig_eur``: the original euros that bought those units (a conversion's all-in
  cost, or the ECB fallback);
* ``market_eur``: market or income EUR realised into those units (a dividend, a sale's
  gain or loss); the lot's book cost is ``orig_eur + market_eur``;
* ``origins``: where the original euros came from, pro-rated with the amount, so a
  trail (lot -> deposit -> conversion slices) is derived, never stored.

Rates: ``ecb_rate(ccy, day)`` returns units of ``ccy`` per 1 EUR on ``day`` (the
``fx_history`` convention, USD per EUR for dollars), or ``None`` when there is none.

Owner rule 2026-11-25: on a sale the original units keep their EUR cost; only the
gain (or loss) enters at the sale date's rate, as ``market_eur``. Realised currency
exists only on a conversion back to EUR (see :mod:`domain.cash_out`).

Decimal only. Whole-lot draws move the lot's EUR exactly (no rounding residue).
"""

from __future__ import annotations

from collections.abc import Callable, Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Literal

from investment_dashboard.domain import kinds
from investment_dashboard.domain.fx_pool import Batch, Pin, PoolResult

ZERO = Decimal(0)

#: The pool outside the broker (the owner's own currency account).
OUTSIDE_ACCOUNT = "usd_account"

SourceKind = Literal["deposit", "sale", "income", "fallback", "withdrawal"]

EventKind = Literal[
    "deposit",
    "withdrawal",
    "buy",
    "sell",
    "dividend_cash",
    "dividend_reinvest",
    "interest",
    "fee",
    "transfer_in",
    "transfer_out",
    "split",
]

EcbRate = Callable[[str, date], Decimal | None]


# --------------------------------------------------------------------------- types


@dataclass(frozen=True)
class Origin:
    """Where a unit's euros came from."""

    #: ``None`` = ECB fallback, income or gain.
    conversion_id: int | None
    #: The day the euros left: the conversion date, or the fallback event's date;
    #: ``None`` for income and gain (no euros left).
    conv_date: date | None
    #: Original euros (0 for income and gain units).
    eur: Decimal


@dataclass(frozen=True)
class PoolLot:
    #: Stable: ``f"{source_kind}:{txn_or_conv_id}:{n}"`` (a piece moved by a paired
    #: transfer keeps its id and appends ``":t{transfer_out_id}"``).
    lot_id: str
    #: Broker account id as ``str``, or :data:`OUTSIDE_ACCOUNT`.
    account_key: str
    ccy: str
    opened: date
    #: Native units left.
    amount: Decimal
    orig_eur: Decimal
    market_eur: Decimal
    origins: tuple[Origin, ...]
    source_kind: SourceKind
    source_txn_id: int | None
    #: True when some of it is an ECB fallback.
    flagged: bool

    @property
    def book_eur(self) -> Decimal:
        return self.orig_eur + self.market_eur


@dataclass(frozen=True)
class Draw:
    """One consumption of one lot by one event."""

    #: Buy / fee / withdrawal / transfer txn id, or the conversion id of a conversion
    #: back (those draws are also listed in :attr:`PoolState.conversions_back`).
    event_txn_id: int | None
    #: A lot id, or a virtual source: ``uncovered:{event}:0`` (ECB fallback for units
    #: no lot covered) or ``kept:{conversion_id}:0`` (units a conversion left in the
    #: outside account, taken by a conversion back).
    lot_id: str
    amount: Decimal
    orig_eur: Decimal
    market_eur: Decimal
    origins: tuple[Origin, ...]
    flagged: bool = False

    @property
    def book_eur(self) -> Decimal:
        return self.orig_eur + self.market_eur


@dataclass(frozen=True)
class HoldingCost:
    """Per (account, instrument), average cost like ``ledger_walk``."""

    shares: Decimal
    cost_native: Decimal
    book_eur: Decimal
    orig_eur: Decimal
    origins: tuple[Origin, ...]


@dataclass(frozen=True)
class PoolState:
    #: What is left, both pools (broker accounts and the outside account).
    lots: tuple[PoolLot, ...]
    #: Every consumption, for trails.
    draws: tuple[Draw, ...]
    holdings: Mapping[tuple[int, int], HoldingCost]
    #: Buy txn id -> book EUR (feeds ``_legs``).
    buy_cost_eur: Mapping[int, Decimal]
    #: Sell txn id -> market EUR realised (the gain or loss at the sale date's rate).
    sale_market_eur: Mapping[int, Decimal]
    #: Book EUR of units spent on fees.
    fees_eur: Decimal
    #: Txn ids that fell back to ECB (conversions back flag their draws instead).
    uncovered: tuple[int, ...]
    #: Conversion-back id -> its draws (input to :func:`domain.cash_out.cash_out`).
    conversions_back: Mapping[int, tuple[Draw, ...]] = field(default_factory=dict)


# -------------------------------------------------------------------------- events


@dataclass(frozen=True)
class TxnEvent:
    """One ledger transaction, as plain data (the service layer builds these).

    ``amount`` is the cash moved, positive (``abs(net_native)``); for a reinvested
    dividend it is ``quantity x price``. ``quantity`` is positive shares bought, sold or
    reinvested (a split's added shares may be negative). Pass only the
    ``dividend_reinvest`` leg of a reinvested dividend, never its paired cash leg
    (``domain.dividends.reinvest_keys``), exactly as ``ledger_walk`` leaves it out.
    """

    id: int
    date: date
    kind: EventKind
    account_id: int
    ccy: str
    amount: Decimal
    instrument_id: int | None = None
    quantity: Decimal = ZERO
    #: A deposit received in ``ccy`` directly (no conversion).
    no_conversion: bool = False
    #: The other leg of a paired transfer.
    pair_id: int | None = None


@dataclass(frozen=True)
class ConversionBack:
    """A conversion from ``from_ccy`` back to EUR, out of the outside account."""

    id: int
    date: date
    from_ccy: str
    sent: Decimal
    eur_received: Decimal
    fees_eur: Decimal = ZERO


Event = TxnEvent | ConversionBack

#: Order within one date: money comes in before it is spent; conversions back last.
_RANK: Mapping[str, int] = {
    kinds.DEPOSIT: 0,
    kinds.TRANSFER_IN: 1,
    kinds.SELL: 2,
    kinds.DIVIDEND_CASH: 3,
    kinds.INTEREST: 3,
    kinds.DIVIDEND_REINVEST: 4,
    kinds.SPLIT: 5,
    kinds.BUY: 6,
    kinds.FEE: 7,
    kinds.TRANSFER_OUT: 8,
    kinds.WITHDRAWAL: 9,
}
_RANK_BACK = 10


def _order(ev: Event) -> tuple[date, int, int]:
    rank = _RANK_BACK if isinstance(ev, ConversionBack) else _RANK[ev.kind]
    return (ev.date, rank, ev.id)


# ---------------------------------------------------------------------- internals

_OriginKey = tuple[int | None, date | None]


def _origin_order(o: Origin) -> tuple[bool, date, int]:
    return (
        o.conv_date is None,
        o.conv_date or date.min,
        -1 if o.conversion_id is None else o.conversion_id,
    )


def _freeze(origins: Mapping[_OriginKey, Decimal]) -> tuple[Origin, ...]:
    return tuple(sorted((Origin(k[0], k[1], v) for k, v in origins.items()), key=_origin_order))


def _merge(into: dict[_OriginKey, Decimal], origins: Iterable[Origin]) -> None:
    for o in origins:
        k = (o.conversion_id, o.conv_date)
        into[k] = into.get(k, ZERO) + o.eur


def _has_fallback(origins: Iterable[Origin]) -> bool:
    return any(o.conversion_id is None and o.eur != 0 for o in origins)


@dataclass
class _Lot:
    lot_id: str
    account_key: str
    ccy: str
    opened: date
    amount: Decimal
    orig: Decimal
    market: Decimal
    origins: dict[_OriginKey, Decimal]
    source_kind: SourceKind
    source_txn_id: int | None
    flagged: bool
    seq: int

    def take(self, units: Decimal) -> tuple[Decimal, Decimal, dict[_OriginKey, Decimal]]:
        """Remove ``units`` (at most the amount left); return their orig, market, origins."""
        if units >= self.amount:
            out = (self.orig, self.market, dict(self.origins))
            self.amount = self.orig = self.market = ZERO
            self.origins = {}
            return out
        orig = self.orig * units / self.amount
        market = self.market * units / self.amount
        origins = {k: v * units / self.amount for k, v in self.origins.items()}
        self.amount -= units
        self.orig -= orig
        self.market -= market
        for k, v in origins.items():
            self.origins[k] -= v
        return orig, market, origins

    def frozen(self) -> PoolLot:
        return PoolLot(
            lot_id=self.lot_id,
            account_key=self.account_key,
            ccy=self.ccy,
            opened=self.opened,
            amount=self.amount,
            orig_eur=self.orig,
            market_eur=self.market,
            origins=_freeze(self.origins),
            source_kind=self.source_kind,
            source_txn_id=self.source_txn_id,
            flagged=self.flagged,
        )


@dataclass
class _Holding:
    shares: Decimal = ZERO
    cost_native: Decimal = ZERO
    book: Decimal = ZERO
    orig: Decimal = ZERO
    origins: dict[_OriginKey, Decimal] = field(default_factory=dict)

    def add(self, draws: Iterable[Draw]) -> None:
        for d in draws:
            self.book += d.book_eur
            self.orig += d.orig_eur
            _merge(self.origins, d.origins)

    def frozen(self) -> HoldingCost:
        return HoldingCost(
            shares=self.shares,
            cost_native=self.cost_native,
            book_eur=self.book,
            orig_eur=self.orig,
            origins=_freeze(self.origins),
        )


class _Engine:
    def __init__(
        self,
        deposit_matches: PoolResult,
        ecb_rate: EcbRate,
        money_market_ids: Collection[int | None],
        conversions: Sequence[Batch],
        deposit_ccy: str,
    ) -> None:
        self.ecb_rate = ecb_rate
        self.mmf = money_market_ids
        self.deposit_ccy = deposit_ccy
        self.matches = {m.deposit_id: m for m in deposit_matches.deposits}
        self.conv_dates = {b.id: b.date for b in conversions}
        self.lots: dict[str, list[_Lot]] = {}
        self.draws: list[Draw] = []
        self.holdings: dict[tuple[int, int], _Holding] = {}
        self.buy_cost: dict[int, Decimal] = {}
        self.sale_market: dict[int, Decimal] = {}
        self.fees = ZERO
        self.uncovered: list[int] = []
        self.back: dict[int, tuple[Draw, ...]] = {}
        self.seq = 0

    # ------------------------------------------------------------------ helpers

    def _at_ecb(self, ccy: str, on: date, units: Decimal) -> tuple[Decimal, bool]:
        """``units`` of ``ccy`` in EUR at ``on``'s rate; ``(0, True)`` without a rate."""
        rate = self.ecb_rate(ccy, on)
        if rate is None or rate <= 0:
            return ZERO, True
        return units / rate, False

    def _flag(self, txn_id: int) -> None:
        if txn_id not in self.uncovered:
            self.uncovered.append(txn_id)

    def _add_lot(
        self,
        lot_id: str,
        account_key: str,
        ccy: str,
        opened: date,
        amount: Decimal,
        orig: Decimal,
        market: Decimal,
        origins: Mapping[_OriginKey, Decimal],
        source_kind: SourceKind,
        source_txn_id: int | None,
        flagged: bool,
    ) -> _Lot | None:
        if amount <= 0:
            return None
        self.seq += 1
        lot = _Lot(
            lot_id,
            account_key,
            ccy,
            opened,
            amount,
            orig,
            market,
            dict(origins),
            source_kind,
            source_txn_id,
            flagged,
            self.seq,
        )
        self.lots.setdefault(account_key, []).append(lot)
        return lot

    def _draw(self, lot: _Lot, units: Decimal, event_id: int | None) -> Draw:
        orig, market, origins = lot.take(units)
        d = Draw(event_id, lot.lot_id, units, orig, market, _freeze(origins), lot.flagged)
        self.draws.append(d)
        return d

    def _fifo(
        self,
        account_key: str,
        ccy: str,
        units: Decimal,
        event_id: int,
        only: Callable[[_Lot], bool] | None = None,
    ) -> tuple[list[tuple[Draw, _Lot]], Decimal]:
        """Take up to ``units`` oldest-first; return the draws and the units still needed."""
        out: list[tuple[Draw, _Lot]] = []
        pool = self.lots.get(account_key, [])
        for lot in sorted(pool, key=lambda x: (x.opened, x.seq)):
            if units <= 0:
                break
            if lot.ccy != ccy or lot.amount <= 0 or (only is not None and not only(lot)):
                continue
            take = min(units, lot.amount)
            out.append((self._draw(lot, take, event_id), lot))
            units -= take
        self.lots[account_key] = [x for x in pool if x.amount > 0]
        return out, units

    def _uncovered_draw(self, event_id: int, ccy: str, on: date, units: Decimal) -> Draw:
        eur, _missing = self._at_ecb(ccy, on, units)
        d = Draw(
            event_id,
            f"uncovered:{event_id}:0",
            units,
            eur,
            ZERO,
            (Origin(None, on, eur),),
            True,
        )
        self.draws.append(d)
        return d

    def _spend(self, ev: TxnEvent) -> list[Draw]:
        """FIFO in the event's account; the rest at ECB, flagged and listed uncovered."""
        pairs, need = self._fifo(str(ev.account_id), ev.ccy, ev.amount, ev.id)
        draws = [d for d, _ in pairs]
        if need > 0:
            draws.append(self._uncovered_draw(ev.id, ev.ccy, ev.date, need))
            self._flag(ev.id)
        return draws

    def _holding(self, ev: TxnEvent) -> _Holding:
        if ev.instrument_id is None:
            msg = f"{ev.kind} event {ev.id} has no instrument"
            raise ValueError(msg)
        return self.holdings.setdefault((ev.account_id, ev.instrument_id), _Holding())

    def received(self, ev: TxnEvent) -> None:
        """Units received in the account currency (no conversion): ECB of their date.

        An owner fact, not a fallback: flagged only when the rate is missing.
        """
        eur, missing = self._at_ecb(ev.ccy, ev.date, ev.amount)
        if missing:
            self._flag(ev.id)
        self._add_lot(
            f"deposit:{ev.id}:0",
            str(ev.account_id),
            ev.ccy,
            ev.date,
            ev.amount,
            eur,
            ZERO,
            {(None, ev.date): eur},
            "deposit",
            ev.id,
            missing,
        )

    # ------------------------------------------------------------------- rules

    def deposit(self, ev: TxnEvent) -> None:
        """Matched slices become one lot; the rest is a flagged ECB fallback lot."""
        if ev.no_conversion:
            self.received(ev)
            return
        match = self.matches.get(ev.id) if ev.ccy == self.deposit_ccy else None
        matched = ZERO
        if match is not None and match.matched:
            origins: dict[_OriginKey, Decimal] = {}
            _merge(
                origins,
                (
                    Origin(s.conversion_id, self.conv_dates.get(s.conversion_id), s.eur)
                    for s in match.matched
                ),
            )
            matched = match.matched_usd
            self._add_lot(
                f"deposit:{ev.id}:0",
                str(ev.account_id),
                ev.ccy,
                ev.date,
                matched,
                sum((s.eur for s in match.matched), ZERO),
                ZERO,
                origins,
                "deposit",
                ev.id,
                False,
            )
        rest = ev.amount - matched
        if rest <= 0:
            return
        if match is not None and match.fallback_usd == rest:
            eur = match.fallback_eur  # the Deposits page's own fallback figure
        else:
            eur, _missing = self._at_ecb(ev.ccy, ev.date, rest)
        self._flag(ev.id)
        self._add_lot(
            f"fallback:{ev.id}:0",
            str(ev.account_id),
            ev.ccy,
            ev.date,
            rest,
            eur,
            ZERO,
            {(None, ev.date): eur},
            "fallback",
            ev.id,
            True,
        )

    def buy(self, ev: TxnEvent) -> None:
        if ev.instrument_id in self.mmf:
            return  # a money-market sweep: still cash, lots do not move
        h = self._holding(ev)
        draws = self._spend(ev)
        h.shares += ev.quantity
        h.cost_native += ev.amount
        h.add(draws)
        self.buy_cost[ev.id] = self.buy_cost.get(ev.id, ZERO) + sum(
            (d.book_eur for d in draws), ZERO
        )

    def fee(self, ev: TxnEvent) -> None:
        self.fees += sum((d.book_eur for d in self._spend(ev)), ZERO)

    def sell(self, ev: TxnEvent) -> None:
        """Average cost releases the sold share of the holding; only the gain is new EUR."""
        if ev.instrument_id in self.mmf:
            return
        h = self._holding(ev)
        rel_cost = rel_book = rel_orig = ZERO
        rel_origins: dict[_OriginKey, Decimal] = {}
        no_holding = h.shares <= 0
        if not no_holding:
            sold = min(ev.quantity, h.shares)
            if sold >= h.shares:  # the whole holding: release exactly
                rel_cost, rel_book, rel_orig = h.cost_native, h.book, h.orig
                rel_origins = dict(h.origins)
            else:
                frac = sold / h.shares
                rel_cost = h.cost_native * frac
                rel_book = h.book * frac
                rel_orig = h.orig * frac
                rel_origins = {k: v * frac for k, v in h.origins.items()}
            h.cost_native = max(h.cost_native - rel_cost, ZERO)
            h.book -= rel_book
            h.orig -= rel_orig
            for k, v in rel_origins.items():
                h.origins[k] -= v
        h.shares -= ev.quantity
        gain_eur, missing = self._at_ecb(ev.ccy, ev.date, ev.amount - rel_cost)
        if missing or no_holding:
            self._flag(ev.id)
        self.sale_market[ev.id] = self.sale_market.get(ev.id, ZERO) + gain_eur
        origins = [Origin(k[0], k[1], v) for k, v in rel_origins.items()]
        self._add_lot(
            f"sale:{ev.id}:0",
            str(ev.account_id),
            ev.ccy,
            ev.date,
            ev.amount,
            rel_orig,
            rel_book - rel_orig + gain_eur,
            rel_origins,
            "sale",
            ev.id,
            missing or no_holding or _has_fallback(origins),
        )

    def _income_lot(self, ev: TxnEvent) -> _Lot | None:
        market, missing = self._at_ecb(ev.ccy, ev.date, ev.amount)
        if missing:
            self._flag(ev.id)
        return self._add_lot(
            f"income:{ev.id}:0",
            str(ev.account_id),
            ev.ccy,
            ev.date,
            ev.amount,
            ZERO,
            market,
            {(None, None): ZERO},
            "income",
            ev.id,
            missing,
        )

    def income(self, ev: TxnEvent) -> None:
        """Cash dividend or interest (money-market dividends too) at its own date's rate."""
        self._income_lot(ev)

    def reinvest(self, ev: TxnEvent) -> None:
        """An income lot spent the same day on the holding (a money market keeps it as cash)."""
        if ev.instrument_id in self.mmf:
            self._income_lot(ev)
            return
        h = self._holding(ev)
        h.shares += ev.quantity
        lot = self._income_lot(ev)
        if lot is None:
            return
        h.cost_native += ev.amount
        h.add([self._draw(lot, lot.amount, ev.id)])
        key = lot.account_key
        self.lots[key] = [x for x in self.lots[key] if x.amount > 0]

    def split(self, ev: TxnEvent) -> None:
        if ev.instrument_id in self.mmf:
            return
        self._holding(ev).shares += ev.quantity

    def withdrawal(self, ev: TxnEvent) -> None:
        """FIFO out of the broker, then the same draws land outside, cost unchanged."""
        for n, d in enumerate(self._spend(ev)):
            self._add_lot(
                f"withdrawal:{ev.id}:{n}",
                OUTSIDE_ACCOUNT,
                ev.ccy,
                ev.date,
                d.amount,
                d.orig_eur,
                d.market_eur,
                {(o.conversion_id, o.conv_date): o.eur for o in d.origins},
                "withdrawal",
                ev.id,
                d.flagged,
            )

    def transfer(self, out: TxnEvent, into: TxnEvent) -> None:
        """A paired transfer: the lots move to the receiving account with their cost."""
        pairs, need = self._fifo(str(out.account_id), out.ccy, out.amount, out.id)
        target = str(into.account_id)
        for d, lot in pairs:
            self._add_lot(
                f"{lot.lot_id}:t{out.id}",
                target,
                out.ccy,
                lot.opened,
                d.amount,
                d.orig_eur,
                d.market_eur,
                {(o.conversion_id, o.conv_date): o.eur for o in d.origins},
                lot.source_kind,
                lot.source_txn_id,
                d.flagged,
            )
        if need > 0:
            d = self._uncovered_draw(out.id, out.ccy, out.date, need)
            self._flag(out.id)
            self._add_lot(
                f"fallback:{out.id}:0",
                target,
                out.ccy,
                out.date,
                need,
                d.orig_eur,
                ZERO,
                {(None, out.date): d.orig_eur},
                "fallback",
                out.id,
                True,
            )

    def conversion_back(self, cb: ConversionBack, pins: Sequence[Pin], kept: _Kept) -> None:
        """Outside lots (pinned withdrawals first, then FIFO), then kept units, then ECB."""
        draws: list[Draw] = []
        need = cb.sent
        for pin in sorted(pins, key=lambda p: (p.deposit_id, p.usd)):
            want = min(pin.usd, need)
            if want <= 0:
                continue
            pairs, left = self._fifo(
                OUTSIDE_ACCOUNT, cb.from_ccy, want, cb.id, only=_from_withdrawal(pin.deposit_id)
            )
            draws += [d for d, _ in pairs]
            need -= want - left
        if need > 0:
            pairs, need = self._fifo(OUTSIDE_ACCOUNT, cb.from_ccy, need, cb.id)
            draws += [d for d, _ in pairs]
        if need > 0 and cb.from_ccy == self.deposit_ccy:
            got, need = kept.take(cb.date, need, cb.id)
            self.draws += got
            draws += got
        if need > 0:
            draws.append(self._uncovered_draw(cb.id, cb.from_ccy, cb.date, need))
        self.back[cb.id] = tuple(draws)


def _from_withdrawal(withdrawal_id: int) -> Callable[[_Lot], bool]:
    def only(lot: _Lot) -> bool:
        return lot.source_kind == "withdrawal" and lot.source_txn_id == withdrawal_id

    return only


class _Kept:
    """Units a conversion left in the outside account: never deposited, or kept."""

    def __init__(self, conversions: Sequence[Batch], deposit_matches: PoolResult) -> None:
        rest = {r.conversion_id: r for r in deposit_matches.remaining}
        self.batches = sorted(conversions, key=lambda b: (b.date, b.id))
        self.units: dict[int, Decimal] = {}
        self.eur: dict[int, Decimal] = {}
        for b in self.batches:
            r = rest.get(b.id)
            self.units[b.id] = (r.usd if r else ZERO) + b.kept_usd
            self.eur[b.id] = (r.eur if r else ZERO) + (b.eur_cost - b.pool_eur)

    def take(self, on: date, units: Decimal, event_id: int) -> tuple[list[Draw], Decimal]:
        out: list[Draw] = []
        for b in self.batches:
            if units <= 0 or b.date > on:
                break
            avail = self.units[b.id]
            if avail <= 0:
                continue
            take = min(units, avail)
            eur = self.eur[b.id] if take == avail else self.eur[b.id] * take / avail
            self.units[b.id] -= take
            self.eur[b.id] -= eur
            units -= take
            out.append(
                Draw(event_id, f"kept:{b.id}:0", take, eur, ZERO, (Origin(b.id, b.date, eur),))
            )
        return out, units


def _paired(events: Iterable[TxnEvent]) -> dict[int, TxnEvent]:
    """Transfer-out id -> its transfer-in, for pairs that agree on both legs."""
    by_id = {e.id: e for e in events}
    pairs: dict[int, TxnEvent] = {}
    for out in by_id.values():
        if out.kind != kinds.TRANSFER_OUT or out.pair_id is None:
            continue
        into = by_id.get(out.pair_id)
        if (
            into is not None
            and into.kind == kinds.TRANSFER_IN
            and into.pair_id == out.id
            and into.ccy == out.ccy
            and into.amount == out.amount
        ):
            pairs[out.id] = into
    return pairs


def run(
    events: Sequence[Event],
    deposit_matches: PoolResult,
    ecb_rate: EcbRate,
    money_market_ids: Collection[int | None],
    *,
    conversions: Sequence[Batch] = (),
    back_pins: Sequence[Pin] = (),
    deposit_ccy: str = "USD",
) -> PoolState:
    """Walk ``events`` (any input order) through the cash pool.

    ``deposit_matches`` is ``fx_pool.match_deposits``'s result for deposits in
    ``deposit_ccy`` (the currency fx_pool's conversions deliver). ``conversions`` are
    the same batches: they date each origin and offer the units no deposit took (and
    the kept units) to a conversion back. ``back_pins`` reuse the 7.3 pin rows with
    ``deposit_id`` = the withdrawal txn id and ``conversion_id`` = the conversion back.
    A transfer pair must agree on currency and amount; otherwise the out leg works like
    a withdrawal and the in leg like a deposit received in its currency.
    """
    eng = _Engine(deposit_matches, ecb_rate, money_market_ids, conversions, deposit_ccy)
    kept = _Kept(conversions, deposit_matches)
    txns = [e for e in events if isinstance(e, TxnEvent)]
    pairs = _paired(txns)
    paired_in = {e.id for e in pairs.values()}
    pins_by_back: dict[int, list[Pin]] = {}
    for p in back_pins:
        pins_by_back.setdefault(p.conversion_id, []).append(p)
    rules: Mapping[str, Callable[[TxnEvent], None]] = {
        kinds.DEPOSIT: eng.deposit,
        kinds.BUY: eng.buy,
        kinds.SELL: eng.sell,
        kinds.DIVIDEND_CASH: eng.income,
        kinds.INTEREST: eng.income,
        kinds.DIVIDEND_REINVEST: eng.reinvest,
        kinds.FEE: eng.fee,
        kinds.SPLIT: eng.split,
        kinds.WITHDRAWAL: eng.withdrawal,
    }
    for ev in sorted(events, key=_order):
        if isinstance(ev, ConversionBack):
            eng.conversion_back(ev, pins_by_back.get(ev.id, []), kept)
        elif ev.kind == kinds.TRANSFER_OUT:
            into = pairs.get(ev.id)
            if into is None:
                eng.withdrawal(ev)
            else:
                eng.transfer(ev, into)
        elif ev.kind == kinds.TRANSFER_IN:
            if ev.id not in paired_in:
                eng.received(ev)
        else:
            rules[ev.kind](ev)
    lots = [lot for pool in eng.lots.values() for lot in pool if lot.amount > 0]
    lots.sort(key=lambda x: (x.account_key, x.opened, x.seq))
    return PoolState(
        lots=tuple(lot.frozen() for lot in lots),
        draws=tuple(eng.draws),
        holdings={k: h.frozen() for k, h in sorted(eng.holdings.items())},
        buy_cost_eur=eng.buy_cost,
        sale_market_eur=eng.sale_market,
        fees_eur=eng.fees,
        uncovered=tuple(sorted(eng.uncovered)),
        conversions_back=eng.back,
    )
