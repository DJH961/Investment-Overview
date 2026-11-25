# ruff: noqa: PT018
"""Rule-by-rule tests for ``domain.cash_pool`` (contract section 3 table).

Round synthetic numbers; rates are units per 1 EUR, 1.25 unless a test says otherwise.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from investment_dashboard.domain.cash_pool import (
    OUTSIDE_ACCOUNT,
    ConversionBack,
    Event,
    PoolState,
    TxnEvent,
    run,
)
from investment_dashboard.domain.fx_pool import Batch, Pin, PoolResult, UsdDeposit, match_deposits

D = Decimal
R = D("1.25")
MMF = 99


def ecb(_ccy: str, _d: date) -> Decimal | None:
    return R


def day(n: int) -> date:
    return date(2026, 3, n)


def t(
    id_: int,
    n: int,
    kind: str,
    amount: str,
    inst: int | None = None,
    qty: str = "0",
    *,
    acc: int = 1,
    ccy: str = "USD",
    no_conversion: bool = False,
    pair: int | None = None,
) -> TxnEvent:
    return TxnEvent(id_, day(n), kind, acc, ccy, D(amount), inst, D(qty), no_conversion, pair)


EMPTY = PoolResult(deposits=(), remaining=())


def walk(events: list[Event], matches: PoolResult = EMPTY, **kw: object) -> PoolState:
    return run(events, matches, ecb, {MMF}, **kw)


def test_unmatched_deposit_is_a_flagged_fallback_lot() -> None:
    s = walk([t(1, 1, "deposit", "500")])
    (lot,) = s.lots
    assert (lot.lot_id, lot.source_kind, lot.flagged) == ("fallback:1:0", "fallback", True)
    assert lot.orig_eur == D("400") and s.uncovered == (1,)


def test_received_in_usd_enters_at_ecb_unflagged() -> None:
    s = walk([t(1, 1, "deposit", "500", no_conversion=True)])
    (lot,) = s.lots
    assert (lot.source_kind, lot.flagged, lot.orig_eur) == ("deposit", False, D("400"))
    assert lot.origins[0].conversion_id is None and s.uncovered == ()


def test_partly_matched_deposit_splits_into_two_lots() -> None:
    batches = [Batch(7, day(1), D("200"), D("250"))]
    m = match_deposits(batches, [UsdDeposit(1, day(2), D("500"))], lambda d: R)
    s = walk([t(1, 2, "deposit", "500")], m, conversions=batches)
    a, b = s.lots
    assert (a.lot_id, a.amount, a.orig_eur, a.flagged) == ("deposit:1:0", D("250"), D("200"), False)
    assert a.origins[0].conversion_id == 7 and a.origins[0].conv_date == day(1)
    assert (b.lot_id, b.amount, b.orig_eur, b.flagged) == ("fallback:1:0", D("250"), D("200"), True)


def test_uncovered_buy_falls_back_to_ecb_and_is_listed() -> None:
    s = walk([t(1, 1, "deposit", "100", no_conversion=True), t(2, 2, "buy", "350", 5, "1")])
    assert s.lots == () and s.uncovered == (2,)
    assert s.buy_cost_eur[2] == D("80") + D("200")
    virtual = [d for d in s.draws if d.lot_id == "uncovered:2:0"]
    assert virtual[0].amount == D("250") and virtual[0].flagged


def test_fifo_takes_the_oldest_lot_first() -> None:
    s = walk(
        [
            t(2, 2, "deposit", "100", no_conversion=True),
            t(1, 1, "deposit", "100", no_conversion=True),
            t(3, 3, "buy", "150", 5, "1"),
        ]
    )
    assert [d.lot_id for d in s.draws] == ["deposit:1:0", "deposit:2:0"]
    assert s.lots[0].lot_id == "deposit:2:0" and s.lots[0].amount == D("50")


def test_money_market_sweeps_are_neutral() -> None:
    s = walk(
        [
            t(1, 1, "deposit", "100", no_conversion=True),
            t(2, 2, "buy", "100", MMF, "100"),
            t(3, 3, "sell", "60", MMF, "60"),
        ]
    )
    assert [(lot.amount, lot.orig_eur) for lot in s.lots] == [(D("100"), D("80"))]
    assert s.holdings == {} and s.draws == ()


def test_money_market_dividend_is_income() -> None:
    s = walk([t(1, 1, "dividend_reinvest", "5", MMF, "5"), t(2, 2, "interest", "2.5")])
    assert [(lot.source_kind, lot.orig_eur, lot.market_eur) for lot in s.lots] == [
        ("income", D(0), D("4")),
        ("income", D(0), D("2")),
    ]


def test_reinvested_dividend_is_spent_the_same_day() -> None:
    s = walk(
        [
            t(1, 1, "deposit", "100", no_conversion=True),
            t(2, 2, "dividend_reinvest", "10", 5, "0.5"),
        ]
    )
    assert [lot.lot_id for lot in s.lots] == ["deposit:1:0"]  # net zero dollars
    h = s.holdings[(1, 5)]
    assert (h.shares, h.cost_native, h.book_eur, h.orig_eur) == (D("0.5"), D("10"), D("8"), D(0))


def test_fee_spends_dollars_at_their_book_cost() -> None:
    s = walk([t(1, 1, "deposit", "100", no_conversion=True), t(2, 2, "fee", "25")])
    assert s.fees_eur == D("20") and s.lots[0].amount == D("75")


def test_sell_keeps_the_original_cost_and_adds_only_the_gain() -> None:
    def ecb_sell(_c: str, d: date) -> Decimal | None:
        return D("2") if d == day(3) else R

    events: list[Event] = [
        t(1, 1, "deposit", "100", no_conversion=True),  # EUR 80
        t(2, 2, "buy", "100", 5, "10"),
        t(3, 3, "sell", "75", 5, "5"),  # releases $50 / EUR 40; gain $25 at 2.00 = EUR 12.5
    ]
    s = run(events, EMPTY, ecb_sell, {MMF})
    (lot,) = s.lots
    assert (lot.amount, lot.orig_eur, lot.market_eur) == (D("75"), D("40"), D("12.5"))
    assert s.sale_market_eur == {3: D("12.5")}
    h = s.holdings[(1, 5)]
    assert (h.shares, h.cost_native, h.book_eur) == (D("5"), D("50"), D("40"))


def test_sell_without_a_holding_is_flagged() -> None:
    s = walk([t(1, 1, "sell", "50", 5, "1")])
    assert s.lots[0].market_eur == D("40") and s.lots[0].flagged and s.uncovered == (1,)


def test_withdrawal_moves_lots_outside_at_unchanged_cost() -> None:
    s = walk([t(1, 1, "deposit", "100", no_conversion=True), t(2, 2, "withdrawal", "40")])
    broker, outside = s.lots
    assert (broker.account_key, broker.amount, broker.orig_eur) == ("1", D("60"), D("48"))
    assert (outside.account_key, outside.lot_id) == (OUTSIDE_ACCOUNT, "withdrawal:2:0")
    assert (outside.amount, outside.orig_eur, outside.opened) == (D("40"), D("32"), day(2))


def test_paired_transfer_moves_lots_with_their_cost() -> None:
    s = walk(
        [
            t(1, 1, "deposit", "100", no_conversion=True),
            t(2, 2, "transfer_in", "60", acc=2, pair=3),
            t(3, 2, "transfer_out", "60", pair=2),
        ]
    )
    a, b = s.lots
    assert (a.account_key, a.amount, a.orig_eur) == ("1", D("40"), D("32"))
    assert (b.account_key, b.amount, b.orig_eur, b.opened) == ("2", D("60"), D("48"), day(1))
    assert b.lot_id == "deposit:1:0:t3" and b.source_kind == "deposit"


def test_unpaired_transfers_act_as_withdrawal_and_received_deposit() -> None:
    s = walk(
        [
            t(1, 1, "deposit", "100", no_conversion=True),
            t(2, 2, "transfer_out", "60", pair=9),
            t(3, 2, "transfer_in", "50", acc=2, pair=2),  # amount differs: not a pair
        ]
    )
    keys = sorted((lot.account_key, lot.amount, lot.source_kind) for lot in s.lots)
    assert keys == [
        ("1", D("40"), "deposit"),
        ("2", D("50"), "deposit"),
        (OUTSIDE_ACCOUNT, D("60"), "withdrawal"),
    ]


def test_conversion_back_takes_pinned_withdrawals_first() -> None:
    s = walk(
        [
            t(1, 1, "deposit", "100", no_conversion=True),
            t(2, 2, "withdrawal", "30"),
            t(3, 3, "deposit", "100", no_conversion=True),
            t(4, 4, "withdrawal", "100"),  # $70 of lot 1 + $30 of lot 3
            ConversionBack(50, day(5), "USD", D("40"), D("30")),
        ],
        back_pins=[Pin(deposit_id=4, conversion_id=50, usd=D("40"))],
    )
    assert [d.lot_id for d in s.conversions_back[50]] == ["withdrawal:4:0"]
    left = sorted((lot.lot_id, lot.amount) for lot in s.lots if lot.account_key == OUTSIDE_ACCOUNT)
    assert left == [
        ("withdrawal:2:0", D("30")),
        ("withdrawal:4:0", D("30")),
        ("withdrawal:4:1", D("30")),
    ]


def test_conversion_back_uses_kept_dollars_then_ecb() -> None:
    batches = [Batch(7, day(1), D("100"), D("150"), kept_usd=D("30"))]
    m = match_deposits(batches, [UsdDeposit(1, day(2), D("100"))], lambda d: R)
    s = walk(
        [t(1, 2, "deposit", "100"), ConversionBack(50, day(5), "USD", D("70"), D("50"))],
        m,
        conversions=batches,
    )
    kept, ecb_rest = s.conversions_back[50]
    # $20 never deposited + $30 kept = $50 at the batch's EUR 100 / $150.
    assert (kept.lot_id, kept.amount, kept.orig_eur) == ("kept:7:0", D("50"), D("100") / 3)
    assert kept.origins[0].conv_date == day(1) and not kept.flagged
    assert (ecb_rest.lot_id, ecb_rest.amount, ecb_rest.orig_eur) == (
        "uncovered:50:0",
        D("20"),
        D("16"),
    )
    assert ecb_rest.flagged and s.uncovered == ()


def test_kept_dollars_dated_after_the_conversion_back_are_not_used() -> None:
    batches = [Batch(7, day(9), D("100"), D("125"))]
    s = walk([ConversionBack(50, day(5), "USD", D("10"), D("8"))], conversions=batches)
    assert [d.lot_id for d in s.conversions_back[50]] == ["uncovered:50:0"]


def test_generic_account_currency() -> None:
    def gbp(ccy: str, _d: date) -> Decimal | None:
        assert ccy == "GBP"
        return D("0.8")

    events: list[Event] = [
        t(1, 1, "deposit", "80", acc=3, ccy="GBP"),
        t(2, 2, "buy", "40", 5, "1", acc=3, ccy="GBP"),
    ]
    s = run(events, EMPTY, gbp, set())
    assert s.lots[0].ccy == "GBP" and s.lots[0].orig_eur == D("50")
    assert s.buy_cost_eur == {2: D("50")}


def test_missing_rate_flags_the_lot() -> None:
    s = run([t(1, 1, "interest", "5")], EMPTY, lambda _c, _d: None, set())
    assert s.lots[0].market_eur == 0 and s.lots[0].flagged and s.uncovered == (1,)


def test_buy_without_instrument_is_rejected() -> None:
    with pytest.raises(ValueError, match="no instrument"):
        walk([t(1, 1, "buy", "10")])
