# ruff: noqa: PT018
"""Golden ledgers G1 and G2 for ``domain.cash_pool`` and ``domain.cash_out``.

Worked by hand in ``docs/v7_4_contract.md`` section 3 (the owner checks them). Rates are
USD per 1 EUR. Year 2026 (not a leap year: 1 Jan -> 10 Apr is 99 days).

G1:
  C1 1 Jan  EUR 1,000 -> $1,250 (1.25)     C2 1 Feb  EUR 1,000 -> $1,000 (1.00)
  D1 5 Jan  deposit $1,250 = C1             L1 $1,250 / EUR 1,000
  B1 10 Jan buy 10 X, $500 from L1          L1 $750 / EUR 600;   X book EUR 400
  D2 5 Feb  deposit $1,000 = C2             L2 $1,000 / EUR 1,000
  B2 10 Feb buy Y $1,000: L1 $750 (EUR 600) + L2 $250 (EUR 250) -> Y book EUR 850
  B3 15 Feb buy 15 Z, $750 from L2 (EUR 750); the pool is empty
  S1 1 Mar  sell 4 X at $70 = $280: frac 0.4 releases $200, book EUR 160, orig EUR 160;
            gain $80 at ECB 1.25 = EUR 64 -> L3 $280, orig 160, market 64, book 224
  15 Mar    dividend Z $10 at ECB 1.25 -> L4 $10, market EUR 8
  W1 1 Apr  withdraw $280: all of L3 -> outside lot $280, book EUR 224
  CB1 10 Apr convert $280 -> EUR 198 (ECB 1.40: $280 = EUR 200)
G2: the same, but S1 sells at $40 = $160: loss $40 at ECB 1.25 = -EUR 32.

The ECB rates on the buy dates differ from the conversions' rates, so the old
ECB-on-the-buy-date basis gives other buy costs (asserted below).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from investment_dashboard.domain.cash_out import cash_out, cash_outs
from investment_dashboard.domain.cash_pool import (
    OUTSIDE_ACCOUNT,
    ConversionBack,
    Event,
    PoolState,
    TxnEvent,
    run,
)
from investment_dashboard.domain.fx_pool import Batch, UsdDeposit, match_deposits
from investment_dashboard.domain.returns import Cashflow, xirr

D = Decimal
ACC = 1
X, Y, Z = 11, 12, 13
CENT = D("0.01")

_ECB = {
    date(2026, 1, 10): D("1.20"),
    date(2026, 2, 10): D("1.05"),
    date(2026, 2, 15): D("1.10"),
    date(2026, 3, 1): D("1.25"),
    date(2026, 3, 15): D("1.25"),
    date(2026, 4, 10): D("1.40"),
}


def ecb(ccy: str, d: date) -> Decimal | None:
    assert ccy == "USD"
    return _ECB.get(d, D("1.25"))


BATCHES = [
    Batch(1, date(2026, 1, 1), D("1000"), D("1250")),
    Batch(2, date(2026, 2, 1), D("1000"), D("1000")),
]
MATCHES = match_deposits(
    BATCHES,
    [UsdDeposit(101, date(2026, 1, 5), D("1250")), UsdDeposit(102, date(2026, 2, 5), D("1000"))],
    lambda d: ecb("USD", d),
)


def _t(
    id_: int, d: date, kind: str, amount: str, inst: int | None = None, qty: str = "0"
) -> TxnEvent:
    return TxnEvent(id_, d, kind, ACC, "USD", D(amount), inst, D(qty))


def ledger(sale_usd: str) -> list[Event]:
    sale = D(sale_usd)
    return [
        _t(101, date(2026, 1, 5), "deposit", "1250"),
        _t(201, date(2026, 1, 10), "buy", "500", X, "10"),
        _t(102, date(2026, 2, 5), "deposit", "1000"),
        _t(202, date(2026, 2, 10), "buy", "1000", Y, "20"),
        _t(203, date(2026, 2, 15), "buy", "750", Z, "15"),
        _t(204, date(2026, 3, 1), "sell", sale_usd, X, "4"),
        _t(205, date(2026, 3, 15), "dividend_cash", "10", Z),
        _t(206, date(2026, 4, 1), "withdrawal", str(sale)),
        ConversionBack(
            301, date(2026, 4, 10), "USD", sale, D("198") if sale_usd == "280" else D("112")
        ),
    ]


def walk(events: list[Event], upto: date | None = None) -> PoolState:
    evs = [e for e in events if upto is None or e.date <= upto]
    return run(evs, MATCHES, ecb, (), conversions=BATCHES)


def broker(state: PoolState) -> list[tuple[Decimal, Decimal]]:
    return [(lot.amount, lot.book_eur) for lot in state.lots if lot.account_key == str(ACC)]


def test_g1_pool_after_each_step() -> None:
    g1 = ledger("280")
    assert broker(walk(g1, date(2026, 1, 5))) == [(D("1250"), D("1000"))]
    assert broker(walk(g1, date(2026, 1, 10))) == [(D("750"), D("600"))]
    assert broker(walk(g1, date(2026, 2, 5))) == [(D("750"), D("600")), (D("1000"), D("1000"))]
    assert broker(walk(g1, date(2026, 2, 10))) == [(D("750"), D("750"))]
    assert broker(walk(g1, date(2026, 2, 15))) == []
    s = walk(g1, date(2026, 3, 1))
    (l3,) = s.lots
    assert (l3.lot_id, l3.amount, l3.orig_eur, l3.market_eur, l3.book_eur) == (
        "sale:204:0",
        D("280"),
        D("160"),
        D("64"),
        D("224"),
    )
    assert [(o.conversion_id, o.conv_date, o.eur) for o in l3.origins] == [
        (1, date(2026, 1, 1), D("160"))
    ]
    assert broker(walk(g1, date(2026, 3, 15))) == [(D("280"), D("224")), (D("10"), D("8"))]
    s = walk(g1, date(2026, 4, 1))
    assert broker(s) == [(D("10"), D("8"))]
    (w,) = [lot for lot in s.lots if lot.account_key == OUTSIDE_ACCOUNT]
    assert (w.source_kind, w.amount, w.orig_eur, w.market_eur) == (
        "withdrawal",
        D("280"),
        D("160"),
        D("64"),
    )


def test_g1_buy_costs_holdings_and_conservation() -> None:
    s = walk(ledger("280"))
    assert s.buy_cost_eur == {201: D("400"), 202: D("850"), 203: D("750")}
    # The old basis (ECB on the buy date) differs: 416.67, 952.38, 681.82.
    old = [D("500") / D("1.20"), D("1000") / D("1.05"), D("750") / D("1.10")]
    assert [x.quantize(CENT) for x in old] == [D("416.67"), D("952.38"), D("681.82")]
    hx, hy, hz = s.holdings[(ACC, X)], s.holdings[(ACC, Y)], s.holdings[(ACC, Z)]
    assert (hx.shares, hx.cost_native, hx.book_eur) == (D("6"), D("300"), D("240"))
    assert (hy.book_eur, hz.book_eur) == (D("850"), D("750"))
    assert hy.origins[0].conversion_id == 1 and hy.origins[0].eur == D("600")
    assert hy.origins[1].conversion_id == 2 and hy.origins[1].eur == D("250")
    holdings = sum((h.book_eur for h in s.holdings.values()), D(0))
    assert holdings == D("1840")
    assert s.sale_market_eur == {204: D("64")}
    assert [(lot.lot_id, lot.amount, lot.book_eur) for lot in s.lots] == [
        ("income:205:0", D("10"), D("8"))
    ]
    back = sum((d.book_eur for d in s.conversions_back[301]), D(0))
    assert back == D("224")
    assert s.fees_eur == 0 and s.uncovered == ()
    # EUR in = EUR where it is now: 2,000 + 8 + 64 = 1,840 + 8 + 224 = 2,072.
    assert D("2000") + D("8") + D("64") == holdings + s.lots[0].book_eur + back == D("2072")


def test_g1_cash_out() -> None:
    events = ledger("280")
    s = walk(events)
    (co,) = cash_outs([e for e in events if isinstance(e, ConversionBack)], s, ecb)
    assert co.eur_received == D("198") and co.usd_sent == D("280")
    assert co.orig_eur == D("160")
    assert co.market_eur == D("64")
    assert co.currency_eur == D("-24")  # $280 at ECB = EUR 200, less book EUR 224
    assert co.conversion_cost_eur == D("-2")  # EUR 198 received, less EUR 200 at ECB
    assert co.realised_eur == D("38")
    assert co.realised_eur == co.market_eur + co.currency_eur + co.conversion_cost_eur
    assert not co.flagged
    expected = (D("198") / D("160")) ** (D("365") / D("99")) - 1  # about +119 % a year
    assert co.xirr_eur is not None and abs(co.xirr_eur - expected) < D("1e-6")
    same = xirr(
        [Cashflow(date(2026, 1, 1), D("-160")), Cashflow(date(2026, 4, 10), D("198"))],
        date(2026, 4, 10),
    )
    assert co.xirr_eur == same


def test_g2_sale_at_a_loss() -> None:
    events = ledger("160")
    s = walk(events, date(2026, 3, 1))
    (l3,) = s.lots
    assert (l3.amount, l3.orig_eur, l3.market_eur, l3.book_eur) == (
        D("160"),
        D("160"),
        D("-32"),
        D("128"),
    )
    s = walk(events)
    assert s.sale_market_eur == {204: D("-32")}
    holdings = sum((h.book_eur for h in s.holdings.values()), D(0))
    back = sum((d.book_eur for d in s.conversions_back[301]), D(0))
    assert (holdings, back) == (D("1840"), D("128"))
    assert D("2000") + D("8") - D("32") == holdings + s.lots[0].book_eur + back

    co = cash_out(
        next(e for e in events if isinstance(e, ConversionBack)), s.conversions_back[301], ecb
    )
    assert co.eur_received == D("112") and co.orig_eur == D("160")
    assert co.market_eur == D("-32")
    assert co.currency_eur.quantize(CENT) == D("-13.71")  # $160 at ECB = EUR 114.29, less 128
    assert co.conversion_cost_eur.quantize(CENT) == D("-2.29")  # EUR 112 less EUR 114.29
    assert co.realised_eur == D("-48")
    assert co.realised_eur == co.market_eur + co.currency_eur + co.conversion_cost_eur
    expected = (D("112") / D("160")) ** (D("365") / D("99")) - 1
    assert co.xirr_eur is not None and abs(co.xirr_eur - expected) < D("1e-6")
