"""The cash pool, wired to the ledger (7.4 contract part 2, section 7).

:func:`build_pool_snapshot` turns the ledger rows, the conversions (both
directions), the pins and the settled ECB fixings into the plain inputs of
:func:`domain.cash_pool.run` and :func:`domain.cash_out.cash_outs`, and returns
one :class:`PoolSnapshot`. Every read model that needs "which euros paid for
these dollars" reads that snapshot; lane C builds synthetic ones in its tests.

Events (non-EUR accounts only; a EUR account's euros are their own cost):

* ``deposit`` / ``transfer_in`` with a positive amount are deposits (both are
  external contributions, and both are matched by ``fx_pool``); a deposit marked
  "received in USD" enters at its own date's ECB rate. A negative contribution
  works like a withdrawal (and a positive withdrawal like a deposit).
* ``withdrawal`` / ``transfer_out`` move dollars to the account outside the
  broker, cost unchanged (the ledger has no transfer pairs).
* ``buy`` / ``sell`` / ``dividend_cash`` / ``interest`` / ``fee`` / ``split``
  as they are; the cash leg of a reinvested dividend is left out
  (``domain.dividends.reinvest_keys``), the ``dividend_reinvest`` leg costs
  ``quantity x price``.
* Every USD -> EUR conversion is a :class:`cash_pool.ConversionBack`; withdrawal
  pins come from the 7.3 pins table.

Rates are the *settled* fixings (never today's live spot), forward-filled, read
through :mod:`fx_service` (cache-tier rule).

Cached: once per session (memo), and process-wide by the exact inputs plus the
FX generation, so the Overview, Holdings and Currency reads after one ledger
change share one walk.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Literal, cast

from sqlalchemy.orm import Session

from investment_dashboard.domain import cash_out, cash_pool, dividends, fx_pool, kinds
from investment_dashboard.domain.instruments import is_money_market_effective
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.repositories import (
    accounts_repo,
    instrument_overrides_repo,
    instruments_repo,
    transactions_repo,
)
from investment_dashboard.services import fx_conversion_service, fx_service, read_cache
from investment_dashboard.services.instrument_enrichment_service import effective_instrument
from investment_dashboard.services.session_memo import memo

if TYPE_CHECKING:
    from investment_dashboard.models import Transaction

ZERO = Decimal(0)

Basis = Literal["pool", "buy_date"]
#: The setting that picks the per-holding EUR cost (``pool`` | ``buy_date``).
BASIS_KEY = "fx.holding_cost_basis"
DEFAULT_BASIS: Basis = "pool"


@dataclass(frozen=True)
class PoolSnapshot:
    state: cash_pool.PoolState
    deposit_matches: fx_pool.PoolResult
    cash_outs: tuple[cash_out.CashOut, ...]
    #: Setting ``fx.holding_cost_basis``.
    basis: Basis


def holding_cost_basis(session: Session | None = None) -> Basis:
    """The ``fx.holding_cost_basis`` setting (``pool`` unless set to ``buy_date``)."""
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    value = settings_service.get_or(BASIS_KEY, DEFAULT_BASIS, session)
    return "buy_date" if value == "buy_date" else "pool"


# ------------------------------------------------------------------------ events

_CASH_IN = {
    kinds.DEPOSIT: "deposit",
    kinds.TRANSFER_IN: "deposit",
}
_CASH_OUT = {
    kinds.WITHDRAWAL: "withdrawal",
    kinds.TRANSFER_OUT: "withdrawal",
}
_AS_IS = frozenset(
    {
        kinds.BUY,
        kinds.SELL,
        kinds.DIVIDEND_CASH,
        kinds.INTEREST,
        kinds.FEE,
        kinds.SPLIT,
        kinds.DIVIDEND_REINVEST,
    }
)
_NEEDS_INSTRUMENT = frozenset({kinds.BUY, kinds.SELL, kinds.DIVIDEND_REINVEST, kinds.SPLIT})


def _event(  # noqa: PLR0911
    t: Transaction,
    ccy: str,
    *,
    reinvest_keys: frozenset[tuple[int, int | None, date]],
    received_in_usd: frozenset[int],
) -> cash_pool.TxnEvent | None:
    """One ledger row as a cash-pool event, or ``None`` when it moves nothing."""
    net = t.net_native or ZERO
    qty = t.quantity or ZERO
    kind = t.kind
    if kind in _CASH_IN or kind in _CASH_OUT:
        if net == 0:
            return None
        ev_kind = "deposit" if net > 0 else "withdrawal"
        return cash_pool.TxnEvent(
            t.id,
            t.date,
            cast("cash_pool.EventKind", ev_kind),
            t.account_id,
            ccy,
            abs(net),
            no_conversion=t.id in received_in_usd,
        )
    if kind not in _AS_IS:
        return None
    if kind in _NEEDS_INSTRUMENT and t.instrument_id is None:
        return None
    if kind == kinds.DIVIDEND_CASH and (t.account_id, t.instrument_id, t.date) in reinvest_keys:
        return None  # the reinvested dividend's cash leg: its reinvest leg carries it
    if kind == kinds.DIVIDEND_REINVEST:
        amount = abs(qty * t.price_native) if t.price_native is not None else ZERO
        return cash_pool.TxnEvent(
            t.id, t.date, "dividend_reinvest", t.account_id, ccy, amount, t.instrument_id, abs(qty)
        )
    if kind == kinds.SPLIT:
        return cash_pool.TxnEvent(
            t.id, t.date, "split", t.account_id, ccy, ZERO, t.instrument_id, qty
        )
    if net == 0 and kind not in {kinds.BUY, kinds.SELL}:
        return None
    return cash_pool.TxnEvent(
        t.id,
        t.date,
        cast("cash_pool.EventKind", kind),
        t.account_id,
        ccy,
        abs(net),
        t.instrument_id,
        abs(qty),
    )


def _money_market_ids(session: Session) -> frozenset[int]:
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    extra = tuple(settings_service.get_or("portfolio.money_market_symbols", (), session))
    instruments = instruments_repo.list_instruments(session)
    overrides = instrument_overrides_repo.get_override_map(session, [i.id for i in instruments])
    return frozenset(
        i.id
        for i in instruments
        if is_money_market_effective(i, effective_instrument(i, overrides.get(i.id)), extra)
    )


def _pool_report(session: Session) -> fx_conversion_service.PoolReport:
    return memo(session, ("cash_pool_report",), lambda: fx_conversion_service.pool_report(session))


def ledger_events(
    session: Session, *, as_of: date
) -> tuple[list[cash_pool.TxnEvent], frozenset[int]]:
    """The cash-pool events of every non-EUR account up to ``as_of``, and the MMF ids."""
    native = {
        a.id: a.native_currency.upper()
        for a in accounts_repo.list_accounts(session)
        if a.native_currency.upper() != "EUR"
    }
    txns = list(transactions_repo.list_transactions(session, end=as_of))
    reinvest_keys = frozenset(dividends.reinvest_keys(txns))
    received = _pool_report(session).received_in_usd
    events: list[cash_pool.TxnEvent] = []
    for t in txns:
        ccy = native.get(t.account_id)
        if ccy is None:
            continue
        ev = _event(t, ccy, reinvest_keys=reinvest_keys, received_in_usd=received)
        if ev is not None:
            events.append(ev)
    return events, _money_market_ids(session)


# ------------------------------------------------------------------------ snapshot


def _ecb(session: Session) -> cash_pool.EcbRate:
    """Settled fixing, units of ``ccy`` per EUR, forward-filled; memoised per (ccy, day)."""
    memo_rates: dict[tuple[str, date], Decimal | None] = {}

    def rate(ccy: str, on: date) -> Decimal | None:
        key = (ccy.upper(), on)
        if key not in memo_rates:
            if key[0] == "EUR":
                memo_rates[key] = Decimal(1)
            else:
                memo_rates[key] = fx_service.get_settled_rate(session, on, base="EUR", quote=key[0])
        return memo_rates[key]

    return rate


_CACHE_MAX = 8
_cache_lock = threading.Lock()
_cache: OrderedDict[tuple[Any, ...], PoolSnapshot] = OrderedDict()


def _compute(session: Session, as_of: date, basis: Basis) -> PoolSnapshot:
    events, mmf = ledger_events(session, as_of=as_of)
    report = _pool_report(session)
    batches = tuple(fx_conversion_service.batches(session))
    backs = tuple(b for b in fx_conversion_service.conversions_back(session) if b.date <= as_of)
    pins = tuple(fx_conversion_service.withdrawal_pins(session))
    key = (
        read_cache.generations((read_cache.FX,)),
        id(session.get_bind()),
        as_of,
        basis,
        tuple(events),
        batches,
        backs,
        pins,
        mmf,
        report.result.deposits,
        report.result.remaining,
    )
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
            return hit
    ecb = _ecb(session)
    all_events: list[cash_pool.Event] = [*events, *backs]
    state = cash_pool.run(
        all_events,
        report.result,
        ecb,
        mmf,
        conversions=batches,
        back_pins=pins,
    )
    snap = PoolSnapshot(
        state=state,
        deposit_matches=report.result,
        cash_outs=cash_out.cash_outs(backs, state, ecb),
        basis=basis,
    )
    with _cache_lock:
        _cache[key] = snap
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)
    return snap


def build_pool_snapshot(
    ledger_session: Session, *, as_of: date | None = None, basis: Basis | None = None
) -> PoolSnapshot:
    """The cash pool through ``as_of`` (default: today), once per ledger change.

    ``basis`` defaults to the ``fx.holding_cost_basis`` setting; the pool is
    walked either way (the journey reads it), only the wiring looks at ``basis``.
    """
    on = as_of or exchange_today()
    b = basis or holding_cost_basis(ledger_session)
    return memo(
        ledger_session, ("cash_pool_snapshot", on, b), lambda: _compute(ledger_session, on, b)
    )


def clear_cache() -> None:
    """Forget the process-wide snapshots (tests)."""
    with _cache_lock:
        _cache.clear()


# ------------------------------------------------------------------------ wiring


def buy_eur_costs(snapshot: PoolSnapshot) -> Mapping[int, Decimal]:
    """Buy txn id -> positive book EUR from the pool; empty under ``buy_date``."""
    if snapshot.basis != "pool":
        return {}
    return snapshot.state.buy_cost_eur


def deposit_eur(snapshot: PoolSnapshot) -> Mapping[int, Decimal]:
    """Deposit txn id -> the euros it really cost (matched slices + ECB rest).

    Same figure as :func:`fx_conversion_service.effective_eur_overrides` (deposits
    whose fallback had no ECB rate are left out); empty without a EUR -> USD
    conversion.
    """
    if not snapshot.deposit_matches.by_conversion:  # one entry per EUR -> USD batch
        return {}
    return {
        m.deposit_id: m.eur_total for m in snapshot.deposit_matches.deposits if not m.rate_missing
    }


def pool_eur_amount(snapshot: PoolSnapshot) -> Callable[[Transaction], Decimal | None]:
    """The resolver for ``ledger_query``'s ``eur_amount`` hook (lane A).

    Signed like the cash leg (a buy is negative): a matched deposit gives the
    euros it cost, a buy (``basis == "pool"``) minus its pool book EUR. ``None``
    for every other row, which means "use the derived path" (``net_native`` at the
    row's own date's rate).
    """
    deposits = deposit_eur(snapshot)
    buys = buy_eur_costs(snapshot)

    def resolve(t: Transaction) -> Decimal | None:
        if t.id is None:
            return None
        if t.id in deposits and t.kind in kinds.CONTRIBUTION_KINDS:
            return deposits[t.id]
        if t.kind == kinds.BUY and t.id in buys:
            return -buys[t.id]
        return None

    return resolve
