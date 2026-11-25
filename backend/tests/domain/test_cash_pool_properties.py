"""Property tests for ``domain.cash_pool`` and ``domain.cash_out`` (contract section 3).

Random synthetic ledgers (two broker accounts, two instruments and a money-market fund,
conversions with fees and kept dollars, conversions back with fees):

* dollars are conserved per account (the units no lot covered are counted in);
* EUR is conserved: deposits + income + sale market (+ ECB fallbacks and kept units
  taken by a conversion back) = holdings book + lots book + fees + conversion-back book;
* the result does not depend on the input order;
* with one rate everywhere, every book cost is the amount at that rate and the cash-out
  has no currency part and no conversion cost;
* every cash-out satisfies realised == market + currency + conversion cost, exactly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from hypothesis import given, settings
from hypothesis import strategies as st

from investment_dashboard.domain.cash_out import cash_outs
from investment_dashboard.domain.cash_pool import (
    OUTSIDE_ACCOUNT,
    ConversionBack,
    EcbRate,
    Event,
    PoolState,
    TxnEvent,
    run,
)
from investment_dashboard.domain.fx_pool import Batch, PoolResult, UsdDeposit, match_deposits

D = Decimal
MMF = 99
START = date(2026, 1, 1)
BACK_ID = 10_000
_RATES = (D("1.05"), D("1.1"), D("1.25"), D("1.4"))
_KINDS = (
    "deposit",
    "deposit",
    "buy",
    "buy",
    "sell",
    "dividend_cash",
    "interest",
    "dividend_reinvest",
    "fee",
    "withdrawal",
    "back",
)

_amount = st.decimals(min_value=D("0.01"), max_value=D("3000"), places=2)
_qty = st.decimals(min_value=D("0.001"), max_value=D("40"), places=3)
_day = st.integers(0, 90)


@dataclass(frozen=True)
class Ledger:
    events: list[Event]
    batches: list[Batch]
    matches: PoolResult
    ecb: EcbRate


def _rate_fn(rates: list[Decimal]) -> EcbRate:
    def ecb(ccy: str, d: date) -> Decimal | None:
        assert ccy == "USD"
        return rates[d.toordinal() % len(rates)]

    return ecb


@st.composite
def ledgers(draw: st.DrawFn, *, flat: Decimal | None = None) -> Ledger:
    """A random ledger; ``flat`` = one rate for every conversion and ECB fixing, no fees."""
    rates = (
        [flat]
        if flat is not None
        else draw(st.lists(st.sampled_from(_RATES), min_size=1, max_size=4))
    )
    ecb = _rate_fn(rates)
    batches: list[Batch] = []
    for i, (day, eur, rate, fee, kept_pct) in enumerate(
        draw(
            st.lists(
                st.tuples(
                    _day,
                    _amount,
                    st.sampled_from(_RATES),
                    st.decimals(min_value=D(0), max_value=D(5), places=2),
                    st.sampled_from((D(0), D(0), D("0.1"), D("0.5"))),
                ),
                max_size=5,
            )
        )
    ):
        r = flat if flat is not None else rate
        usd = eur * r if flat is not None else (eur * r).quantize(D("0.01"))
        batches.append(
            Batch(
                i + 1,
                START + timedelta(days=day),
                eur,
                usd,
                D(0) if flat is not None else fee,
                (usd * kept_pct).quantize(D("0.01")),
            )
        )
    events: list[Event] = []
    rows = draw(
        st.lists(
            st.tuples(
                _day,
                st.sampled_from(_KINDS),
                st.sampled_from((1, 2)),
                st.sampled_from((11, 12, MMF)),
                _amount,
                _qty,
                st.decimals(min_value=D(0), max_value=D("0.05"), places=2),
            ),
            max_size=25,
        )
    )
    for n, (day, kind, acc, inst, amount, qty, fee_pct) in enumerate(rows):
        d = START + timedelta(days=day)
        if kind == "back":
            rate = ecb("USD", d)
            assert rate is not None
            received = (amount / rate).quantize(D("0.01")) if flat is None else amount / rate
            fees = D(0) if flat is not None else (received * fee_pct).quantize(D("0.01"))
            events.append(ConversionBack(BACK_ID + n, d, "USD", amount, received, fees))
            continue
        instrument = None if kind in {"deposit", "withdrawal", "fee", "interest"} else inst
        events.append(TxnEvent(n + 1, d, kind, acc, "USD", amount, instrument, qty))  # type: ignore[arg-type]
    deposits = [
        UsdDeposit(e.id, e.date, e.amount)
        for e in events
        if isinstance(e, TxnEvent) and e.kind == "deposit"
    ]
    matches = match_deposits(batches, deposits, lambda d: ecb("USD", d))
    return Ledger(events, batches, matches, ecb)


def walk(lg: Ledger, events: list[Event] | None = None) -> PoolState:
    return run(
        events if events is not None else lg.events,
        lg.matches,
        lg.ecb,
        {MMF},
        conversions=lg.batches,
    )


def _virtual(lot_id: str) -> bool:
    return lot_id.startswith(("uncovered:", "kept:"))


@settings(max_examples=200, deadline=None)
@given(ledgers())
def test_dollars_are_conserved_per_account(lg: Ledger) -> None:
    s = walk(lg)
    expected: dict[str, Decimal] = {}
    where: dict[int, str] = {}

    def add(key: str, amount: Decimal) -> None:
        expected[key] = expected.get(key, D(0)) + amount

    for e in lg.events:
        if isinstance(e, ConversionBack):
            where[e.id] = OUTSIDE_ACCOUNT
            add(OUTSIDE_ACCOUNT, -e.sent)
            continue
        key = str(e.account_id)
        where[e.id] = key
        mmf = e.instrument_id == MMF
        if e.kind in {"deposit", "dividend_cash", "interest"} or (e.kind == "sell" and not mmf) or (e.kind == "dividend_reinvest" and mmf):
            add(key, e.amount)
        elif e.kind == "fee" or (e.kind == "buy" and not mmf):
            add(key, -e.amount)
        elif e.kind == "withdrawal":
            add(key, -e.amount)
            add(OUTSIDE_ACCOUNT, e.amount)
    for d in s.draws:
        if _virtual(d.lot_id):
            assert d.event_txn_id is not None
            add(where[d.event_txn_id], d.amount)
    held: dict[str, Decimal] = {}
    for lot in s.lots:
        assert lot.amount > 0
        held[lot.account_key] = held.get(lot.account_key, D(0)) + lot.amount
    for key in set(expected) | set(held):
        assert held.get(key, D(0)) == expected.get(key, D(0)), key


@settings(max_examples=200, deadline=None)
@given(ledgers())
def test_eur_is_conserved(lg: Ledger) -> None:
    s = walk(lg)
    income = D(0)
    for e in lg.events:
        if isinstance(e, TxnEvent) and e.kind in {"dividend_cash", "interest", "dividend_reinvest"}:
            rate = lg.ecb(e.ccy, e.date)
            assert rate is not None
            income += e.amount / rate
    eur_in = (
        sum((m.eur_total for m in lg.matches.deposits), D(0))
        + income
        + sum(s.sale_market_eur.values(), D(0))
        + sum((d.orig_eur for d in s.draws if _virtual(d.lot_id)), D(0))
    )
    eur_now = (
        sum((h.book_eur for h in s.holdings.values()), D(0))
        + sum((lot.book_eur for lot in s.lots), D(0))
        + s.fees_eur
        + sum((d.book_eur for ds in s.conversions_back.values() for d in ds), D(0))
    )
    assert abs(eur_in - eur_now) < D("1e-12")
    # Origins pro-rate with the original euros.
    for lot in s.lots:
        assert abs(sum((o.eur for o in lot.origins), D(0)) - lot.orig_eur) < D("1e-12")


@settings(max_examples=150, deadline=None)
@given(st.data())
def test_result_does_not_depend_on_input_order(data: st.DataObject) -> None:
    lg = data.draw(ledgers())
    shuffled = data.draw(st.permutations(lg.events))
    assert walk(lg, list(shuffled)) == walk(lg)


@settings(max_examples=150, deadline=None)
@given(st.sampled_from((D("1.25"), D("0.8"))).flatmap(lambda r: ledgers(flat=r)))
def test_zero_rate_moves_give_zero_currency_part(lg: Ledger) -> None:
    rate = lg.ecb("USD", START)
    assert rate is not None
    s = walk(lg)
    tol = D("1e-9")
    for lot in s.lots:
        assert abs(lot.book_eur * rate - lot.amount) < tol
    for h in s.holdings.values():
        assert abs(h.book_eur * rate - h.cost_native) < tol
    backs = [e for e in lg.events if isinstance(e, ConversionBack)]
    for co in cash_outs(backs, s, lg.ecb):
        assert abs(co.currency_eur) < tol
        assert co.conversion_cost_eur == 0
        assert abs(co.realised_eur - co.market_eur) < tol


@settings(max_examples=200, deadline=None)
@given(ledgers())
def test_cash_out_identity_is_exact(lg: Ledger) -> None:
    s = walk(lg)
    backs = [e for e in lg.events if isinstance(e, ConversionBack)]
    outs = cash_outs(backs, s, lg.ecb)
    assert len(outs) == len(backs)
    for co in outs:
        assert co.realised_eur == co.market_eur + co.currency_eur + co.conversion_cost_eur
        assert sum((d.amount for d in co.draws), D(0)) == co.usd_sent
