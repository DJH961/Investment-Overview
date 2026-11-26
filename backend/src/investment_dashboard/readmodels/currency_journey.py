"""Currency page "Your dollars": where every converted euro is now (7.4 contract §8).

Built from lane B2's :class:`services.cash_pool_service.PoolSnapshot` (contract §7):
the cash pool's lots, holdings and cash-outs, plus the EUR -> USD conversions, the
holdings' native value now and the live rate. The core (:func:`build_journey`) is
pure over :class:`JourneyInputs`; :func:`load_inputs` gathers them from a session.

**Buckets.** Every dollar is in one place, each with its book EUR (``orig + market``,
the pool's cost) and its EUR value now (``dollars / rate_now``, one instant):

* ``usd_account``: the owner's own dollar account. Withdrawn lots (cost carried) plus
  the dollars a conversion delivered that no deposit took yet (``fx_pool`` remaining)
  and the kept dollars, less what a conversion back already took from them;
* ``broker_cash``: the broker pool's lots (sale proceeds, dividends, money-market cash);
* ``invested``: the holdings, value now against their pool book;
* back in euros: the cash-outs (``domain.cash_out``).

**The stage bridge** (EUR view only) splits the lifetime currency effect

    total = sum(bucket currency, still in dollars) + sum(cash-out currency + cost)

into five lines that add up to ``total`` exactly (each line is rounded to the cent and
the total is the sum of the rounded lines, so what is shown adds up):

* ``conversion_cost``: every EUR -> USD conversion's dollars at the ECB fixing of its
  date minus its all-in euros (``fx_spread``), plus each cash-out's conversion cost;
* ``waiting``: the rate move while dollars sat in the USD account. For a deposit's
  matched slice ``usd / ecb(deposit) - usd / ecb(conversion)``; for dollars still
  there, ``usd / rate_now - usd / ecb(conversion)``; for withdrawn lots their move since
  they cost what they cost, net of what is already counted upstream;
* ``holdings``: each holding's currency part (``cost_native / rate_now - book``) net of
  the conversion cost and waiting already counted for its euros;
* ``realised``: each cash-out's currency part, net of the same;
* ``cash``: the rest (broker cash; also the embedded cost of dollars spent on fees).

The upstream parts are carried into a bucket by its ``origins`` (pro rata per euro of
each conversion). This is the Overview card's ``fx_pnl_eur`` (it is rebuilt on these
buckets, :mod:`readmodels.journey_fields`).

💱 The USD view shows native dollars only (``bridge`` is ``null`` and the stats carry no
euro figures). A cash-out's dollar side uses the dollars originally deposited behind
its units (native: each conversion's own dollars-per-euro, never a market rate) and an
XIRR over those dollar flows; the euro side is ``domain.cash_out``'s, from euros only.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import date
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Any, Protocol

from investment_dashboard.domain import cash_out as cash_out_domain
from investment_dashboard.domain import kinds
from investment_dashboard.domain.cash_out import CashOut
from investment_dashboard.domain.cash_pool import (
    OUTSIDE_ACCOUNT,
    ConversionBack,
    Draw,
    EcbRate,
    HoldingCost,
    Origin,
    PoolLot,
    PoolState,
)
from investment_dashboard.domain.fx_pool import Batch, PoolResult
from investment_dashboard.domain.returns import Cashflow, xirr
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.services.read_cache import cached_read

ZERO = Decimal(0)
GRID = cash_out_domain.GRID
CENT = Decimal("0.01")
RATE_DP = Decimal("0.0001")
#: Dollars waiting longer than this many days are "idle" (plan: idle-dollars callout).
IDLE_DAYS = 30
#: The units the journey follows (the pool's deposit currency).
USD = "USD"

BRIDGE_KEYS = ("conversion_cost", "waiting", "cash", "holdings", "realised")

VS_IMPACT_NOTE = (
    "This card follows every dollar at your own conversion rates since your first "
    "conversion; Impact measures day-by-day moves at the ECB rate over the range you "
    "pick, so the two differ by the conversion costs and the waiting."
)


# --------------------------------------------------------------------------- inputs


class PoolSnapshotLike(Protocol):
    """What the journey reads from B2's ``cash_pool_service.PoolSnapshot`` (contract §7)."""

    @property
    def state(self) -> PoolState: ...

    @property
    def deposit_matches(self) -> PoolResult: ...

    @property
    def cash_outs(self) -> tuple[CashOut, ...]: ...

    @property
    def basis(self) -> str: ...


@dataclass(frozen=True)
class TxnInfo:
    """One ledger transaction, as plain data (labels and kinds for the trail)."""

    id: int
    date: date
    kind: str
    account_id: int
    ccy: str
    #: Cash moved, positive (``abs(net_native)``).
    amount: Decimal
    instrument_id: int | None = None
    symbol: str | None = None
    #: Shares, positive.
    quantity: Decimal = ZERO


@dataclass(frozen=True)
class JourneyInputs:
    snapshot: PoolSnapshotLike
    #: EUR -> USD conversions (the ``fx_pool`` batches).
    conversions: tuple[Batch, ...]
    #: Native value now per ``(account_id, instrument_id)`` (USD holdings).
    values: Mapping[tuple[int, int], Decimal]
    #: Live USD per 1 EUR (the valuation instant), or ``None``.
    rate_now: Decimal | None
    ecb_rate: EcbRate
    today: date
    txns: Mapping[int, TxnInfo] = field(default_factory=dict)
    #: Account ids that are brokerage accounts with a negative ledger cash balance
    #: (P18's ``ledger_cash_balances``), with the balance.
    negative_cash: Mapping[int, Decimal] = field(default_factory=dict)


# -------------------------------------------------------------------------- helpers


def _q(x: Decimal) -> Decimal:
    return x.quantize(GRID)


def _cent(x: Decimal) -> Decimal:
    return x.quantize(CENT, rounding=ROUND_HALF_EVEN)


def rate4(x: Decimal | None) -> Decimal | None:
    return None if x is None else x.quantize(RATE_DP, rounding=ROUND_HALF_EVEN)


def _m(x: Decimal | None) -> str | None:
    return None if x is None else dec(_cent(x))


def _ecb(inputs: JourneyInputs, on: date) -> Decimal | None:
    r = inputs.ecb_rate(USD, on)
    return r if r is not None and r > 0 else None


@dataclass(frozen=True)
class _Conv:
    batch: Batch
    ecb: Decimal | None
    #: Native dollars per all-in euro (the conversion's own pair).
    usd_per_eur: Decimal | None
    #: Conversion cost per euro of origin (``usd_per_eur / ecb - 1``).
    cost_per_eur: Decimal
    #: Waiting per euro of deposited origin (averaged over its deposits).
    wait_per_eur: Decimal


@dataclass(frozen=True)
class _Ctx:
    inputs: JourneyInputs
    convs: Mapping[int, _Conv]
    #: Fallback origin date -> native dollars per euro (from the units born there).
    fallback_ratio: Mapping[date, Decimal]
    #: Global lines (GRID): every conversion's cost; every deposit slice's waiting.
    cost_to_usd: Decimal
    waiting_slices: Decimal


def _fallback_ratios(state: PoolState, matches: PoolResult) -> dict[date, Decimal]:
    """Native dollars per euro of each fallback origin (units born at ECB on that date).

    Read from units whose only origin is that fallback (no market part), so the ratio
    is the native dollars over the euros they were booked at: never a rate looked up.
    """
    usd: dict[date, Decimal] = {}
    eur: dict[date, Decimal] = {}

    def add(day: date | None, units: Decimal, euros: Decimal) -> None:
        if day is None or euros <= 0 or units <= 0:
            return
        usd[day] = usd.get(day, ZERO) + units
        eur[day] = eur.get(day, ZERO) + euros

    pieces: list[tuple[Decimal, Decimal, Decimal, tuple[Origin, ...]]] = [
        (d.amount, d.orig_eur, d.market_eur, d.origins) for d in state.draws
    ]
    pieces += [(lot.amount, lot.orig_eur, lot.market_eur, lot.origins) for lot in state.lots]
    for amount, orig, market, origins in pieces:
        if market == 0 and len(origins) == 1 and origins[0].conversion_id is None:
            add(origins[0].conv_date, amount, orig)
    for m in matches.deposits:
        if m.fallback_usd > 0:
            add(m.date, m.fallback_usd, m.fallback_eur)
    return {d: usd[d] / eur[d] for d in usd}


def _context(inputs: JourneyInputs) -> _Ctx:
    matches = inputs.snapshot.deposit_matches
    slices_eur: dict[int, Decimal] = {}
    slices_wait: dict[int, Decimal] = {}
    waiting = ZERO
    ecb_by_conv = {b.id: _ecb(inputs, b.date) for b in inputs.conversions}
    for m in matches.deposits:
        ecb_dep = _ecb(inputs, m.date)
        for s in m.matched:
            ecb_c = ecb_by_conv.get(s.conversion_id)
            if ecb_c is None or ecb_dep is None:
                continue
            w = _q(s.usd / ecb_dep - s.usd / ecb_c)
            waiting += w
            slices_wait[s.conversion_id] = slices_wait.get(s.conversion_id, ZERO) + w
            slices_eur[s.conversion_id] = slices_eur.get(s.conversion_id, ZERO) + s.eur
    convs: dict[int, _Conv] = {}
    cost = ZERO
    for b in inputs.conversions:
        ecb_c = ecb_by_conv[b.id]
        ratio = b.usd_received / b.eur_cost if b.eur_cost > 0 else None
        per_cost = ratio / ecb_c - 1 if ratio is not None and ecb_c is not None else ZERO
        if ecb_c is not None and b.date <= inputs.today:
            cost += _q(b.usd_received / ecb_c - b.eur_cost)
        e = slices_eur.get(b.id, ZERO)
        per_wait = slices_wait.get(b.id, ZERO) / e if e > 0 else ZERO
        convs[b.id] = _Conv(b, ecb_c, ratio, per_cost, per_wait)
    return _Ctx(
        inputs=inputs,
        convs=convs,
        fallback_ratio=_fallback_ratios(inputs.snapshot.state, matches),
        cost_to_usd=cost,
        waiting_slices=waiting,
    )


def _embedded(ctx: _Ctx, origins: Iterable[Origin], *, waited: bool = True) -> Decimal:
    """Conversion cost (and waiting) already counted upstream for these euros (GRID)."""
    out = ZERO
    for o in origins:
        c = ctx.convs.get(o.conversion_id) if o.conversion_id is not None else None
        if c is None or o.eur == 0:
            continue
        out += o.eur * (c.cost_per_eur + (c.wait_per_eur if waited else ZERO))
    return _q(out)


def origin_usd(ctx: _Ctx, origins: Iterable[Origin]) -> Decimal:
    """The native dollars originally bought with these euros (rate-free)."""
    out = ZERO
    for o in origins:
        if o.eur == 0:
            continue
        if o.conversion_id is not None:
            c = ctx.convs.get(o.conversion_id)
            if c is not None and c.usd_per_eur is not None:
                out += o.eur * c.usd_per_eur
        elif o.conv_date is not None:
            ratio = ctx.fallback_ratio.get(o.conv_date)
            if ratio is not None:
                out += o.eur * ratio
    return out


def draw_embedded(ctx: _Ctx, d: Draw) -> Decimal:
    # Kept dollars were never deposited: only their conversion cost is upstream.
    return _embedded(ctx, d.origins, waited=not d.lot_id.startswith("kept:"))


# -------------------------------------------------------------------------- buckets


@dataclass(frozen=True)
class Bucket:
    usd: Decimal
    eur_cost: Decimal
    #: ``None`` without a live rate.
    eur_now: Decimal | None
    #: ``eur_now - eur_cost - market`` on GRID (``None`` without a rate).
    currency_eur: Decimal | None
    #: Holdings only: ``(value - cost_native) / rate_now``.
    market_eur: Decimal | None = None
    #: Holdings only: native cost of the shares held.
    cost_native: Decimal = ZERO


@dataclass(frozen=True)
class _Remaining:
    conversion_id: int
    date: date
    usd: Decimal
    eur: Decimal
    #: Of ``usd``: the part no deposit took (not the intentionally kept dollars).
    undeposited_usd: Decimal


def remaining_in_usd_account(inputs: JourneyInputs) -> list[_Remaining]:
    """Per conversion: dollars still in the USD account (remaining + kept - taken back)."""
    snap = inputs.snapshot
    rest = {r.conversion_id: r for r in snap.deposit_matches.remaining}
    taken_usd: dict[int, Decimal] = {}
    taken_eur: dict[int, Decimal] = {}
    for draws in snap.state.conversions_back.values():
        for d in draws:
            if d.lot_id.startswith("kept:"):
                cid = int(d.lot_id.split(":")[1])
                taken_usd[cid] = taken_usd.get(cid, ZERO) + d.amount
                taken_eur[cid] = taken_eur.get(cid, ZERO) + d.orig_eur
    out: list[_Remaining] = []
    for b in sorted(inputs.conversions, key=lambda x: (x.date, x.id)):
        if b.date > inputs.today:
            continue
        r = rest.get(b.id)
        undeposited = r.usd if r else ZERO
        usd = undeposited + b.kept_usd - taken_usd.get(b.id, ZERO)
        eur = (r.eur if r else ZERO) + (b.eur_cost - b.pool_eur) - taken_eur.get(b.id, ZERO)
        if usd > 0:
            # The domain does not split a conversion back's take between the
            # undeposited and the kept dollars; count it against the undeposited first.
            left = max(undeposited - taken_usd.get(b.id, ZERO), ZERO)
            out.append(_Remaining(b.id, b.date, usd, eur, min(left, usd)))
    return out


def _cash_bucket(
    lots: Sequence[PoolLot], extra: Sequence[_Remaining], rate: Decimal | None
) -> Bucket:
    usd = sum((lot.amount for lot in lots), ZERO) + sum((r.usd for r in extra), ZERO)
    cost = sum((lot.book_eur for lot in lots), ZERO) + sum((r.eur for r in extra), ZERO)
    if rate is None:
        return Bucket(usd, cost, None, None)
    cur = sum((_q(lot.amount / rate) - _q(lot.book_eur) for lot in lots), ZERO)
    cur += sum((_q(r.usd / rate) - _q(r.eur) for r in extra), ZERO)
    return Bucket(usd, cost, usd / rate, cur)


def _usd_holdings(inputs: JourneyInputs) -> dict[tuple[int, int], HoldingCost]:
    return {k: h for k, h in inputs.snapshot.state.holdings.items() if h.shares > 0}


def _holding_currency(h: HoldingCost, rate: Decimal) -> Decimal:
    return _q(h.cost_native / rate) - _q(h.book_eur)


def _invested_bucket(inputs: JourneyInputs) -> Bucket:
    rate = inputs.rate_now
    hold = _usd_holdings(inputs)
    usd = ZERO
    cost_native = ZERO
    book = ZERO
    for k, h in hold.items():
        book += h.book_eur
        cost_native += h.cost_native
        # No price: carried at cost (no market part), never at zero.
        usd += inputs.values.get(k, h.cost_native)
    if rate is None:
        return Bucket(usd, book, None, None, None, cost_native)
    cur = sum((_holding_currency(h, rate) for h in hold.values()), ZERO)
    market = _q((usd - cost_native) / rate)
    return Bucket(usd, book, usd / rate, cur, market, cost_native)


@dataclass(frozen=True)
class Journey:
    usd_account: Bucket
    broker_cash: Bucket
    invested: Bucket
    your_rate: Decimal | None
    ecb_avg: Decimal | None
    rate_now: Decimal | None
    #: Line key -> EUR (cents); ``None`` without a live rate.
    bridge: Mapping[str, Decimal] | None
    bridge_total: Decimal | None
    #: Signed (``<= 0`` is a cost), cents: both directions, the bridge's own line.
    conversion_cost_eur: Decimal | None
    cash_outs: tuple[CashOut, ...]
    idle: tuple[_Remaining, ...]
    uncovered_buys: int
    ecb_fallback_deposits: int


def your_rates(inputs: JourneyInputs) -> tuple[Decimal | None, Decimal | None]:
    """``(your rate, ECB over the same conversions)`` in USD per EUR.

    Your rate is the conversions' blend (dollars over all-in euros); the ECB average
    weighs each conversion's dollars the same way, so ``dollars / ecb_avg - dollars /
    your_rate`` is the total conversion cost.
    """
    usd = eur = at_ecb = ZERO
    usd_ecb = ZERO
    for b in inputs.conversions:
        if b.date > inputs.today or b.usd_received <= 0:
            continue
        usd += b.usd_received
        eur += b.eur_cost
        ecb = _ecb(inputs, b.date)
        if ecb is not None:
            usd_ecb += b.usd_received
            at_ecb += b.usd_received / ecb
    yours = usd / eur if eur > 0 else None
    ecb_avg = usd_ecb / at_ecb if at_ecb > 0 else None
    return yours, ecb_avg


def _bridge(
    ctx: _Ctx,
    lots_out: Sequence[PoolLot],
    rest: Sequence[_Remaining],
    lots_broker: Sequence[PoolLot],
) -> tuple[dict[str, Decimal], Decimal] | None:
    inputs = ctx.inputs
    rate = inputs.rate_now
    if rate is None:
        return None
    cash_outs = inputs.snapshot.cash_outs
    hold = _usd_holdings(inputs)
    cost = ctx.cost_to_usd + sum((co.conversion_cost_eur for co in cash_outs), ZERO)
    waiting = ctx.waiting_slices
    total = ZERO
    for r in rest:
        c = ctx.convs.get(r.conversion_id)
        cur = _q(r.usd / rate) - _q(r.eur)
        total += cur
        ecb_c = c.ecb if c is not None else None
        waiting += _q(r.usd / rate - r.usd / ecb_c) if ecb_c is not None else cur
    for lot in lots_out:
        cur = _q(lot.amount / rate) - _q(lot.book_eur)
        total += cur
        waiting += cur - _embedded(ctx, lot.origins)
    holdings = ZERO
    for h in hold.values():
        cur = _holding_currency(h, rate)
        total += cur
        holdings += cur - _embedded(ctx, h.origins)
    realised = ZERO
    for co in cash_outs:
        total += co.currency_eur + co.conversion_cost_eur
        realised += co.currency_eur - sum((draw_embedded(ctx, d) for d in co.draws), ZERO)
    for lot in lots_broker:
        total += _q(lot.amount / rate) - _q(lot.book_eur)
    cash = total - cost - waiting - holdings - realised
    lines = {
        "conversion_cost": _cent(cost),
        "waiting": _cent(waiting),
        "cash": _cent(cash),
        "holdings": _cent(holdings),
        "realised": _cent(realised),
    }
    return lines, sum(lines.values(), ZERO)


def build_journey(inputs: JourneyInputs) -> Journey:
    """The journey's buckets, bridge and lists (pure)."""
    ctx = _context(inputs)
    state = inputs.snapshot.state
    rate = inputs.rate_now
    lots = [lot for lot in state.lots if lot.ccy == USD and lot.amount > 0]
    out_lots = [lot for lot in lots if lot.account_key == OUTSIDE_ACCOUNT]
    broker_lots = [lot for lot in lots if lot.account_key != OUTSIDE_ACCOUNT]
    rest = remaining_in_usd_account(inputs)
    yours, ecb_avg = your_rates(inputs)
    bridge = _bridge(ctx, out_lots, rest, broker_lots)
    idle = tuple(
        r for r in rest if r.undeposited_usd > 0 and (inputs.today - r.date).days > IDLE_DAYS
    )
    uncovered = [
        t for t in state.uncovered if (info := inputs.txns.get(t)) is None or info.kind == kinds.BUY
    ]
    fallbacks = sum(1 for m in inputs.snapshot.deposit_matches.deposits if m.fallback_usd > 0)
    return Journey(
        usd_account=_cash_bucket(out_lots, rest, rate),
        broker_cash=_cash_bucket(broker_lots, (), rate),
        invested=_invested_bucket(inputs),
        your_rate=yours,
        ecb_avg=ecb_avg,
        rate_now=rate,
        bridge=None if bridge is None else bridge[0],
        bridge_total=None if bridge is None else bridge[1],
        conversion_cost_eur=None if bridge is None else bridge[0]["conversion_cost"],
        cash_outs=inputs.snapshot.cash_outs,
        idle=idle,
        uncovered_buys=len(uncovered),
        ecb_fallback_deposits=fallbacks,
    )


# ------------------------------------------------------------------------ cash-outs


def fees_of(co: CashOut) -> Decimal:
    """The cash-out's fees in EUR (``received - fees - orig = realised``)."""
    return co.eur_received - co.orig_eur - co.realised_eur


def _pct(part: Decimal, whole: Decimal) -> Decimal | None:
    return part / whole if whole > 0 else None


def _usd_side(ctx: _Ctx, co: CashOut) -> dict[str, Any]:
    """The dollar side: dollars originally put in behind the units, from native USD only."""
    put_in = ZERO
    flows: dict[date, Decimal] = {}
    for d in co.draws:
        for o in d.origins:
            usd = origin_usd(ctx, (o,))
            if usd == 0 or o.conv_date is None:
                continue
            put_in += usd
            flows[o.conv_date] = flows.get(o.conv_date, ZERO) - usd
    realised = co.usd_sent - put_in
    cfs = [Cashflow(day, amount) for day, amount in sorted(flows.items())]
    cfs.append(Cashflow(co.date, co.usd_sent))
    rate = xirr(cfs, co.date) if flows else None
    return {
        "put_in": put_in,
        "market": realised,
        "realised": realised,
        "realised_pct": _pct(realised, put_in),
        "xirr": rate,
    }


def note_for(xirr_eur: Decimal | None, xirr_usd: Decimal | None) -> str:
    """One sentence: how far the euro result trails or beats the dollar one."""
    if xirr_eur is None or xirr_usd is None:
        return "Too little time to compare the yearly euro and dollar results."
    gap = ((xirr_eur - xirr_usd) * 100).quantize(Decimal("0.1"), rounding=ROUND_HALF_EVEN)
    if gap == 0:
        return "You kept the same yearly result in euros as in dollars."
    word = "more" if gap > 0 else "less"
    return f"You kept {abs(gap)} points a year {word} in euros than in dollars."


def cash_out_out(ctx: _Ctx, co: CashOut) -> dict[str, Any]:
    """One ``CashOutOut`` (contract §8)."""
    usd = _usd_side(ctx, co)
    fees = fees_of(co)
    eur_x = co.xirr_eur
    return {
        "conversion_id": co.conversion_id,
        "date": co.date.isoformat(),
        "usd_sent": _m(co.usd_sent),
        "eur_received": _m(co.eur_received),
        "fees_eur": _m(fees + co.fees_usd_eur),
        "eur": {
            "put_in": _m(co.orig_eur),
            "market": _m(co.market_eur),
            "currency": _m(co.currency_eur),
            "conversion_cost": _m(co.conversion_cost_eur),
            "realised": _m(co.realised_eur),
            "realised_pct": dec(_pct(co.realised_eur, co.orig_eur)),
            "xirr": dec(eur_x),
        },
        "usd": {
            "put_in": _m(usd["put_in"]),
            "market": _m(usd["market"]),
            "realised": _m(usd["realised"]),
            "realised_pct": dec(usd["realised_pct"]),
            "xirr": dec(usd["xirr"]),
        },
        "note": note_for(eur_x, usd["xirr"]),
        "flagged": co.flagged,
    }


def preview_draws(
    inputs: JourneyInputs, *, usd_sent: Decimal, on: date, withdrawal_id: int | None
) -> list[Draw]:
    """The units a conversion back saved now would take (the pool's own order).

    Pinned withdrawal lots first, then the USD account's lots oldest first, then the
    dollars a conversion left there (remaining and kept). With no withdrawal named, the
    broker's lots follow (the withdrawal about to be recorded). Any rest is uncovered,
    at the ECB rate of ``on``, flagged.
    """
    state = inputs.snapshot.state
    need = usd_sent
    draws: list[Draw] = []

    def take(
        lot_id: str,
        avail: Decimal,
        orig: Decimal,
        market: Decimal,
        origins: tuple[Origin, ...],
        flagged: bool,
    ) -> None:
        nonlocal need
        if need <= 0 or avail <= 0:
            return
        units = min(need, avail)
        f = units / avail
        draws.append(
            Draw(
                None,
                lot_id,
                units,
                orig * f,
                market * f,
                tuple(Origin(o.conversion_id, o.conv_date, o.eur * f) for o in origins),
                flagged,
            )
        )
        need -= units

    outside = sorted(
        (x for x in state.lots if x.account_key == OUTSIDE_ACCOUNT and x.ccy == USD),
        key=lambda x: x.opened,
    )
    if withdrawal_id is not None:
        for lot in outside:
            if lot.source_kind == "withdrawal" and lot.source_txn_id == withdrawal_id:
                take(lot.lot_id, lot.amount, lot.orig_eur, lot.market_eur, lot.origins, lot.flagged)
    pinned = {d.lot_id for d in draws}
    for lot in outside:
        if lot.lot_id not in pinned:
            take(lot.lot_id, lot.amount, lot.orig_eur, lot.market_eur, lot.origins, lot.flagged)
    for r in remaining_in_usd_account(inputs):
        if r.date <= on:
            b = next(x for x in inputs.conversions if x.id == r.conversion_id)
            take(
                f"kept:{r.conversion_id}:0",
                r.usd,
                r.eur,
                ZERO,
                (Origin(r.conversion_id, b.date, r.eur),),
                False,
            )
    if withdrawal_id is None:
        broker = sorted(
            (x for x in state.lots if x.account_key != OUTSIDE_ACCOUNT and x.ccy == USD),
            key=lambda x: x.opened,
        )
        for lot in broker:
            take(lot.lot_id, lot.amount, lot.orig_eur, lot.market_eur, lot.origins, lot.flagged)
    if need > 0:
        ecb = _ecb(inputs, on)
        eur = need / ecb if ecb is not None else ZERO
        draws.append(
            Draw(None, "uncovered:preview:0", need, eur, ZERO, (Origin(None, on, eur),), True)
        )
    return draws


def build_preview(
    inputs: JourneyInputs,
    *,
    usd_sent: Decimal,
    eur_received: Decimal,
    fees_eur: Decimal,
    on: date,
    withdrawal_id: int | None = None,
    fees_usd: Decimal = ZERO,
) -> dict[str, Any]:
    """``POST /cash-out/preview``: the cash-out card for a conversion back, not saved."""
    back = ConversionBack(0, on, USD, usd_sent, eur_received, fees_eur, fees_usd)
    draws = preview_draws(inputs, usd_sent=usd_sent, on=on, withdrawal_id=withdrawal_id)
    co = cash_out_domain.cash_out(back, draws, inputs.ecb_rate)
    out = cash_out_out(_context(inputs), co)
    out["conversion_id"] = None
    return out


# ------------------------------------------------------------------------- the views


def _bucket_out(b: Bucket, *, eur: bool, invested: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "usd": _m(b.usd),
        "eur_cost": _m(b.eur_cost) if eur else None,
        "eur_now": _m(b.eur_now) if eur else None,
        "currency_eur": _m(b.currency_eur) if eur else None,
    }
    if invested:
        out["market_eur"] = _m(b.market_eur) if eur else None
        out["usd_cost"] = _m(b.cost_native)
        out["market_usd"] = _m(b.usd - b.cost_native)
    return out


def _view(ctx: _Ctx, j: Journey, *, eur: bool) -> dict[str, Any]:
    cos = j.cash_outs
    back = None
    if cos:
        back = {
            "count": len(cos),
            "eur_received": _m(sum((c.eur_received for c in cos), ZERO)),
            "orig_eur": _m(sum((c.orig_eur for c in cos), ZERO)),
            "realised_eur": _m(sum((c.realised_eur for c in cos), ZERO)),
        }
    bridge = None
    if eur and j.bridge is not None and j.bridge_total is not None:
        bridge = {
            "lines": [{"key": k, "eur": dec(j.bridge[k])} for k in BRIDGE_KEYS],
            "total_eur": dec(j.bridge_total),
        }
    return {
        "stats": {
            "usd_account": _bucket_out(j.usd_account, eur=eur),
            "broker_cash": _bucket_out(j.broker_cash, eur=eur),
            "invested": _bucket_out(j.invested, eur=eur, invested=True),
            "your_rate": {
                "rate": dec(rate4(j.your_rate)),
                "ecb_avg": dec(rate4(j.ecb_avg)),
                "now": dec(rate4(j.rate_now)),
            },
        },
        "bridge": bridge,
        "idle": [
            {
                "conversion_id": r.conversion_id,
                "date": r.date.isoformat(),
                "usd": _m(r.undeposited_usd),
                "days": (ctx.inputs.today - r.date).days,
            }
            for r in sorted(j.idle, key=lambda x: (x.date, x.conversion_id))
        ],
        "back_in_euros": back,
        "cash_outs": [cash_out_out(ctx, c) for c in cos],
        "flagged": {
            "uncovered_buys": j.uncovered_buys,
            "ecb_fallback_deposits": j.ecb_fallback_deposits,
        },
    }


def build_journey_both(inputs: JourneyInputs) -> dict[str, Any]:
    """``JourneyBoth``: ``{eur, usd}`` (the USD side hides the euro-only lines)."""
    ctx = _context(inputs)
    j = build_journey(inputs)
    return {"eur": _view(ctx, j, eur=True), "usd": _view(ctx, j, eur=False)}


def empty_journey_both() -> dict[str, Any]:
    """No pool yet (no ledger, or the pool service is not available)."""
    empty = {"usd": "0.00", "eur_cost": None, "eur_now": None, "currency_eur": None}
    view: dict[str, Any] = {
        "stats": {
            "usd_account": dict(empty),
            "broker_cash": dict(empty),
            "invested": {**empty, "market_eur": None, "usd_cost": None, "market_usd": None},
            "your_rate": {"rate": None, "ecb_avg": None, "now": None},
        },
        "bridge": None,
        "idle": [],
        "back_in_euros": None,
        "cash_outs": [],
        "flagged": {"uncovered_buys": 0, "ecb_fallback_deposits": 0},
    }
    return {"eur": view, "usd": {**view}}


def context_for(inputs: JourneyInputs) -> _Ctx:
    """The shared per-build context (for :mod:`readmodels.money_trail`)."""
    return _context(inputs)


# --------------------------------------------------------------------------- loading


def _txn_infos(session: Any) -> dict[int, TxnInfo]:
    from investment_dashboard.repositories import transactions_repo  # noqa: PLC0415

    out: dict[int, TxnInfo] = {}
    for t in transactions_repo.list_transactions(session):
        account = t.account
        out[t.id] = TxnInfo(
            id=t.id,
            date=t.date,
            kind=t.kind,
            account_id=t.account_id,
            ccy=(account.native_currency.upper() if account is not None else USD),
            amount=abs(t.net_native or ZERO),
            instrument_id=t.instrument_id,
            symbol=t.instrument.symbol if t.instrument is not None else None,
            quantity=abs(t.quantity or ZERO),
        )
    return out


def _batches(session: Any) -> tuple[Batch, ...]:
    from investment_dashboard.services import fx_conversion_service  # noqa: PLC0415

    rows = fx_conversion_service.list_conversions(session)
    return tuple(
        Batch(
            id=r.id,
            date=r.date,
            eur_sent=r.eur_sent,
            usd_received=r.usd_received,
            fees_eur=r.fees_eur if r.fees_eur is not None else ZERO,
            kept_usd=r.kept_usd,
        )
        for r in rows
        if (r.from_ccy or "EUR").upper() == "EUR" and (r.to_ccy or USD).upper() == USD
    )


def _values(session: Any) -> dict[tuple[int, int], Decimal]:
    from investment_dashboard.services import positions_service  # noqa: PLC0415

    out: dict[tuple[int, int], Decimal] = {}
    for p in positions_service.compute_positions(session):
        if p.account.native_currency.upper() != USD or p.current_price_native is None:
            continue
        key = (p.account.id, p.instrument.id)
        out[key] = out.get(key, ZERO) + p.current_value_native
    return out


def _ecb_lookup(session: Any) -> EcbRate:
    from investment_dashboard.readmodels.currency_deposits import rate_lookup  # noqa: PLC0415

    at = rate_lookup(session)

    def ecb(ccy: str, on: date) -> Decimal | None:
        return at(on) if ccy.upper() == USD else None

    return ecb


def _rate_now(session: Any, today: date) -> Decimal | None:
    from investment_dashboard.services import fx_service  # noqa: PLC0415

    spot = fx_service.active_live_spot(USD)
    if spot is not None and spot.rate > 0:
        return spot.rate
    return fx_service.get_settled_rate(session, today, base="EUR", quote=USD)


def snapshot_provider() -> Callable[..., PoolSnapshotLike] | None:
    """B2's ``build_pool_snapshot`` (contract §7), or ``None`` before it is merged."""
    import importlib  # noqa: PLC0415

    try:
        cash_pool_service = importlib.import_module(
            "investment_dashboard.services.cash_pool_service"
        )
    except ImportError:
        return None
    fn = getattr(cash_pool_service, "build_pool_snapshot", None)
    return fn if callable(fn) else None


def load_inputs(session: Any, *, today: date | None = None) -> JourneyInputs | None:
    """Everything the journey reads, from a session; ``None`` without a pool service."""
    from investment_dashboard.domain.market_hours import exchange_today  # noqa: PLC0415

    build = snapshot_provider()
    if build is None:
        return None
    day = today or exchange_today()
    snapshot = build(session)
    return JourneyInputs(
        snapshot=snapshot,
        conversions=_batches(session),
        values=_values(session),
        rate_now=_rate_now(session, day),
        ecb_rate=_ecb_lookup(session),
        today=day,
        txns=_txn_infos(session),
    )


_BUILDING: ContextVar[bool] = ContextVar("journey_building", default=False)


@cached_read
def _cached(session: Any) -> JourneyInputs | None:
    return load_inputs(session)


def load_inputs_cached(session: Any) -> JourneyInputs | None:
    """:func:`load_inputs`, cached until the next ledger or price change.

    ``None`` when called while the inputs are being built (a read model the pool
    service itself uses never waits on the journey).
    """
    if _BUILDING.get():
        return None
    token = _BUILDING.set(True)
    try:
        return _cached(session=session)  # type: ignore[no-any-return]
    finally:
        _BUILDING.reset(token)
