"""Synthetic journey inputs built on golden ledger G1 (docs/v7_4_contract.md §3).

G1 as in ``tests/domain/test_cash_pool_golden.py``, plus C3 (1 Mar, EUR 500 -> $600,
never deposited: idle in the USD account) and a valuation on 1 May 2026 at 1.10 USD
per EUR: X 6 sh at $80, Y $1,100, Z 15 sh at $55. Lane C builds its own
``PoolSnapshot`` stand-in here (contract §7: B2 owns the real one).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import date
from decimal import Decimal

from investment_dashboard.domain.cash_out import CashOut, cash_outs
from investment_dashboard.domain.cash_pool import (
    ConversionBack,
    Event,
    PoolState,
    TxnEvent,
    run,
)
from investment_dashboard.domain.fx_pool import Batch, PoolResult, UsdDeposit, match_deposits
from investment_dashboard.readmodels.currency_journey import JourneyInputs, TxnInfo

D = Decimal
ONE = D(1)
RATE_NOW = D("1.10")
ACC = 1
X, Y, Z = 11, 12, 13
SYMBOLS = {X: "XXX", Y: "YYY", Z: "ZZZ"}
TODAY = date(2026, 5, 1)

ECB = {
    date(2026, 1, 10): D("1.20"),
    date(2026, 2, 10): D("1.05"),
    date(2026, 2, 15): D("1.10"),
    date(2026, 3, 1): D("1.25"),
    date(2026, 3, 15): D("1.25"),
    date(2026, 4, 10): D("1.40"),
}


def make_ecb(scale: Decimal = ONE) -> Callable[[str, date], Decimal | None]:
    def ecb(ccy: str, d: date) -> Decimal | None:
        if ccy != "USD":
            return None
        return ECB.get(d, D("1.25")) * scale

    return ecb


@dataclass(frozen=True)
class FakeSnapshot:
    state: PoolState
    deposit_matches: PoolResult
    cash_outs: tuple[CashOut, ...]
    basis: str = "pool"


def batches() -> list[Batch]:
    return [
        Batch(1, date(2026, 1, 1), D("1000"), D("1250")),
        Batch(2, date(2026, 2, 1), D("1000"), D("1000")),
        Batch(3, date(2026, 3, 1), D("500"), D("600")),
    ]


def _t(
    id_: int, d: date, kind: str, amount: str, inst: int | None = None, qty: str = "0"
) -> TxnEvent:
    return TxnEvent(id_, d, kind, ACC, "USD", D(amount), inst, D(qty))


def events(*, sale: str = "280", back: bool = True) -> list[Event]:
    evs: list[Event] = [
        _t(101, date(2026, 1, 5), "deposit", "1250"),
        _t(201, date(2026, 1, 10), "buy", "500", X, "10"),
        _t(102, date(2026, 2, 5), "deposit", "1000"),
        _t(202, date(2026, 2, 10), "buy", "1000", Y, "20"),
        _t(203, date(2026, 2, 15), "buy", "750", Z, "15"),
        _t(204, date(2026, 3, 1), "sell", sale, X, "4"),
        _t(205, date(2026, 3, 15), "dividend_cash", "10", Z),
        _t(206, date(2026, 4, 1), "withdrawal", sale),
    ]
    if back:
        evs.append(
            ConversionBack(
                301, date(2026, 4, 10), "USD", D(sale), D("198") if sale == "280" else D("112")
            )
        )
    return evs


def inputs(
    *,
    sale: str = "280",
    back: bool = True,
    ecb_scale: Decimal = ONE,
    rate_now: Decimal | None = RATE_NOW,
) -> JourneyInputs:
    ecb = make_ecb(ecb_scale)
    bs = batches()
    matches = match_deposits(
        bs,
        [
            UsdDeposit(101, date(2026, 1, 5), D("1250")),
            UsdDeposit(102, date(2026, 2, 5), D("1000")),
        ],
        lambda d: ecb("USD", d),
    )
    evs = events(sale=sale, back=back)
    state = run(evs, matches, ecb, (), conversions=bs)
    backs = [e for e in evs if isinstance(e, ConversionBack)]
    snap = FakeSnapshot(state, matches, cash_outs(backs, state, ecb))
    txns = {
        e.id: TxnInfo(
            e.id,
            e.date,
            e.kind,
            e.account_id,
            e.ccy,
            e.amount,
            e.instrument_id,
            SYMBOLS.get(e.instrument_id) if e.instrument_id else None,
            e.quantity,
        )
        for e in evs
        if isinstance(e, TxnEvent)
    }
    return JourneyInputs(
        snapshot=snap,
        conversions=tuple(bs),
        values={(ACC, X): D("480"), (ACC, Y): D("1100"), (ACC, Z): D("825")},
        rate_now=None if rate_now is None else rate_now * ecb_scale,
        ecb_rate=ecb,
        today=TODAY,
        txns=txns,
    )


def with_rate(base: JourneyInputs, rate_now: Decimal | None) -> JourneyInputs:
    return replace(base, rate_now=rate_now)
