# ruff: noqa: PT018
"""The cash pool through the ledger (7.4 contract section 7): G1 end to end, invariants.

G1 is the hand-worked golden ledger of ``docs/v7_4_contract.md`` section 3, stored
as real ledger rows, conversions and fixings; the service must give the same
figures as the pure domain test (``tests/domain/test_cash_pool_golden.py``).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.domain.settings_schema import dump
from investment_dashboard.models import Account, Transaction
from investment_dashboard.readmodels.queries.deposits_query import compute_summary
from investment_dashboard.readmodels.queries.overview_query import compute_instrument_metrics
from investment_dashboard.repositories import (
    app_config_repo,
    fx_repo,
    instruments_repo,
    prices_repo,
)
from investment_dashboard.services import (
    cash_pool_service,
    cashflows,
    fx_conversion_service,
    settings_registry,
)
from investment_dashboard.services.metrics_service import (
    build_instrument_cashflows,
    compute_portfolio_metrics,
)
from investment_dashboard.services.positions_service import compute_positions

D = Decimal
CENT = D("0.01")
AS_OF = date(2026, 4, 30)

#: Settled fixings (USD per EUR), forward-filled between the rows.
FIXINGS = {
    date(2026, 1, 1): D("1.25"),
    date(2026, 1, 10): D("1.20"),
    date(2026, 1, 11): D("1.25"),
    date(2026, 2, 10): D("1.05"),
    date(2026, 2, 11): D("1.25"),
    date(2026, 2, 15): D("1.10"),
    date(2026, 2, 16): D("1.25"),
    date(2026, 4, 10): D("1.40"),
}


def _set_basis(session: Session, value: str) -> None:
    defn = settings_registry.BY_KEY["fx.holding_cost_basis"]
    app_config_repo.set_value(session, defn.key, dump(defn, value))
    session.flush()


def _tx(session: Session, acct: Account, txn_id: int, on: date, kind: str, net: str, **kw: object):
    t = Transaction(
        id=txn_id,
        account_id=acct.id,
        date=on,
        kind=kind,
        net_native=D(net),
        source="manual",
        **kw,
    )
    session.add(t)
    return t


def seed_g1(session: Session, *, sale: str = "280", received: str = "198") -> dict[str, int]:
    acct = Account(broker="vanguard", account_label="V", native_currency="USD")
    session.add(acct)
    session.flush()
    fx_repo.upsert_rates(session, FIXINGS)
    x = instruments_repo.get_or_create(session, symbol="XXX", asset_class="etf")
    y = instruments_repo.get_or_create(session, symbol="YYY", asset_class="etf")
    z = instruments_repo.get_or_create(session, symbol="ZZZ", asset_class="etf")
    for iid, close in ((x.id, "70"), (y.id, "55"), (z.id, "52")):
        prices_repo.upsert_closes(session, iid, {AS_OF: D(close)})
    _tx(session, acct, 101, date(2026, 1, 5), "deposit", "1250")
    _tx(session, acct, 201, date(2026, 1, 10), "buy", "-500", instrument_id=x.id, quantity=D(10))
    _tx(session, acct, 102, date(2026, 2, 5), "deposit", "1000")
    _tx(session, acct, 202, date(2026, 2, 10), "buy", "-1000", instrument_id=y.id, quantity=D(20))
    _tx(session, acct, 203, date(2026, 2, 15), "buy", "-750", instrument_id=z.id, quantity=D(15))
    _tx(session, acct, 204, date(2026, 3, 1), "sell", sale, instrument_id=x.id, quantity=D(-4))
    _tx(session, acct, 205, date(2026, 3, 15), "dividend_cash", "10", instrument_id=z.id)
    _tx(session, acct, 206, date(2026, 4, 1), "withdrawal", f"-{sale}")
    session.flush()
    fx_conversion_service.create_conversion(
        session, on=date(2026, 1, 1), eur_sent=D("1000"), usd_received=D("1250")
    )
    fx_conversion_service.create_conversion(
        session, on=date(2026, 2, 1), eur_sent=D("1000"), usd_received=D("1000")
    )
    back = fx_conversion_service.create_conversion(
        session,
        on=date(2026, 4, 10),
        eur_sent=D(received),
        usd_received=D(sale),
        from_ccy="USD",
        to_ccy="EUR",
    )
    session.flush()
    return {"x": x.id, "y": y.id, "z": z.id, "back": back.id}


@pytest.fixture(autouse=True)
def _fresh_pool_cache() -> None:
    cash_pool_service.clear_cache()


def test_g1_buy_costs_through_the_service(session: Session) -> None:
    ids = seed_g1(session)
    snap = cash_pool_service.build_pool_snapshot(session, as_of=AS_OF)
    assert snap.basis == "pool"
    assert dict(snap.state.buy_cost_eur) == {201: D("400"), 202: D("850"), 203: D("750")}
    book = {k[1]: h.book_eur for k, h in snap.state.holdings.items()}
    assert book == {ids["x"]: D("240"), ids["y"]: D("850"), ids["z"]: D("750")}
    assert snap.state.sale_market_eur[204] == D("64")
    assert snap.state.uncovered == ()
    (co,) = snap.cash_outs
    assert co.conversion_id == ids["back"]
    assert (co.eur_received, co.orig_eur, co.market_eur) == (D("198"), D("160"), D("64"))
    assert (co.currency_eur, co.conversion_cost_eur, co.realised_eur) == (
        D("-24"),
        D("-2"),
        D("38"),
    )
    assert co.realised_eur == co.market_eur + co.currency_eur + co.conversion_cost_eur
    assert not co.flagged


def test_g2_sale_at_a_loss_through_the_service(session: Session) -> None:
    seed_g1(session, sale="160", received="112")
    snap = cash_pool_service.build_pool_snapshot(session, as_of=AS_OF)
    assert snap.state.sale_market_eur[204] == D("-32")
    (co,) = snap.cash_outs
    assert co.realised_eur == D("-48")
    assert co.market_eur == D("-32")
    assert co.currency_eur.quantize(CENT) == D("-13.71")
    assert co.conversion_cost_eur.quantize(CENT) == D("-2.29")


def _eur_in(snap: cash_pool_service.PoolSnapshot, ecb_income: Decimal) -> Decimal:
    deposits = sum(cash_pool_service.deposit_eur(snap).values(), D(0))
    virtual = sum(
        (d.orig_eur for d in snap.state.draws if d.lot_id.startswith(("uncovered:", "kept:"))),
        D(0),
    )
    return deposits + ecb_income + sum(snap.state.sale_market_eur.values(), D(0)) + virtual


def _eur_out(snap: cash_pool_service.PoolSnapshot) -> Decimal:
    holdings = sum((h.book_eur for h in snap.state.holdings.values()), D(0))
    lots = sum((lot.book_eur for lot in snap.state.lots), D(0))
    back = sum((d.book_eur for draws in snap.state.conversions_back.values() for d in draws), D(0))
    return holdings + lots + snap.state.fees_eur + back


def test_g1_eur_is_conserved(session: Session) -> None:
    seed_g1(session)
    snap = cash_pool_service.build_pool_snapshot(session, as_of=AS_OF)
    # 2,000 deposits + 8 income + 64 sale market = 1,840 holdings + 8 pool + 224 back
    assert _eur_in(snap, D("8")) == _eur_out(snap) == D("2072")


def test_mixed_ledger_eur_is_conserved(session: Session) -> None:
    """Fees, an MMF sweep, a reinvested dividend, interest and an uncovered buy."""
    acct = Account(broker="vanguard", account_label="V", native_currency="USD")
    eur_acct = Account(broker="savings_bank", account_label="E", native_currency="EUR")
    session.add_all([acct, eur_acct])
    session.flush()
    fx_repo.upsert_rates(session, FIXINGS)
    mmf = instruments_repo.get_or_create(
        session, symbol="VMFXX", name="Vanguard Federal Money Market", asset_class="mutual_fund"
    )
    v = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    e = instruments_repo.get_or_create(session, symbol="EUNL", asset_class="etf")
    _tx(session, acct, 1, date(2026, 1, 5), "deposit", "1250")
    _tx(session, acct, 2, date(2026, 1, 5), "buy", "-1250", instrument_id=mmf.id, quantity=D(1250))
    _tx(
        session, acct, 3, date(2026, 1, 10), "sell", "1000", instrument_id=mmf.id, quantity=D(-1000)
    )
    _tx(session, acct, 4, date(2026, 1, 10), "buy", "-1000", instrument_id=v.id, quantity=D(10))
    _tx(session, acct, 5, date(2026, 1, 12), "fee", "-5")
    _tx(
        session,
        acct,
        6,
        date(2026, 2, 15),
        "dividend_cash",
        "11",
        instrument_id=v.id,
    )
    _tx(
        session,
        acct,
        7,
        date(2026, 2, 15),
        "dividend_reinvest",
        "-11",
        instrument_id=v.id,
        quantity=D("0.1"),
        price_native=D(110),
    )
    _tx(session, acct, 8, date(2026, 3, 1), "interest", "2.5")
    _tx(session, acct, 9, date(2026, 3, 2), "buy", "-600", instrument_id=v.id, quantity=D(5))
    _tx(session, eur_acct, 10, date(2026, 3, 2), "deposit", "500")
    _tx(session, eur_acct, 11, date(2026, 3, 3), "buy", "-500", instrument_id=e.id, quantity=D(5))
    session.flush()
    fx_conversion_service.create_conversion(
        session, on=date(2026, 1, 1), eur_sent=D("1000"), usd_received=D("1250")
    )
    session.flush()
    snap = cash_pool_service.build_pool_snapshot(session, as_of=AS_OF)
    # MMF sweeps neutral, EUR account outside the pool
    assert set(snap.state.buy_cost_eur) == {4, 9}
    assert 9 in snap.state.uncovered  # $600 with $245 of pool left: the rest at ECB
    assert snap.state.fees_eur == D("4")  # $5 of C1's dollars at 1.25 per EUR
    income = D("11") / D("1.10") + D("2.5") / D("1.25")
    assert _eur_in(snap, income) == _eur_out(snap)


def test_pool_eur_amount_for_ledger_query(session: Session) -> None:
    seed_g1(session)
    snap = cash_pool_service.build_pool_snapshot(session, as_of=AS_OF)
    resolve = cash_pool_service.pool_eur_amount(snap)
    rows = {t.id: t for t in session.query(Transaction).all()}
    assert resolve(rows[101]) == D("1000")
    assert resolve(rows[201]) == D("-400")
    assert resolve(rows[204]) is None  # a sale: derived path
    assert resolve(rows[206]) is None
    _set_basis(session, "buy_date")
    old = cash_pool_service.pool_eur_amount(
        cash_pool_service.build_pool_snapshot(session, as_of=AS_OF)
    )
    assert old(rows[201]) is None and old(rows[101]) == D("1000")


def _holding_figures(session: Session) -> dict[int, tuple[Decimal, ...]]:
    positions = compute_positions(session, as_of=AS_OF)
    out = {}
    for iid, m in compute_instrument_metrics(session, positions, as_of=AS_OF).items():
        out[iid] = (
            m.cost_basis_eur,
            m.capital_gain_eur,
            m.xirr_eur,
            m.cost_basis_usd,
            m.capital_gain_usd,
            m.xirr_usd,
        )
    return out


def test_holding_eur_cost_from_the_pool_usd_unchanged(session: Session) -> None:
    ids = seed_g1(session)
    pool = _holding_figures(session)
    assert pool[ids["x"]][0] == D("240.00")
    assert pool[ids["y"]][0] == D("850.00")
    assert pool[ids["z"]][0] == D("750.00")
    _set_basis(session, "buy_date")
    session.expire_all()
    old = _holding_figures(session)
    # 7.3.1: ECB on the buy date (X 500/1.20 x 0.6, Y 1000/1.05, Z 750/1.10)
    assert old[ids["x"]][0] == D("250.00")
    assert old[ids["y"]][0] == D("952.38")
    assert old[ids["z"]][0] == D("681.82")
    for iid in ids.values():
        if iid in pool:
            assert pool[iid][3:] == old[iid][3:], "USD figures never read the pool"


def test_buy_date_reproduces_the_pre_pool_figures_exactly(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Rollback: ``buy_date`` equals the walk with no pool at all (the 7.3.1 code path)."""
    seed_g1(session)
    _set_basis(session, "buy_date")
    with_switch = _holding_figures(session)
    flows_switch = build_instrument_cashflows(session, as_of=AS_OF)
    session.expire_all()
    monkeypatch.setattr(cash_pool_service, "buy_eur_costs", lambda _snap: {})
    no_pool = _holding_figures(session)
    flows_no_pool = build_instrument_cashflows(session, as_of=AS_OF)
    assert with_switch == no_pool
    assert flows_switch == flows_no_pool


def test_buy_flows_use_the_pool_sales_their_own_date(session: Session) -> None:
    ids = seed_g1(session)
    eur, usd = build_instrument_cashflows(session, as_of=AS_OF)
    x = [(cf.date, cf.amount) for cf in eur[ids["x"]]]
    assert x == [(date(2026, 1, 10), D("-400")), (date(2026, 3, 1), D("280") / D("1.25"))]
    assert [cf.amount for cf in usd[ids["x"]]] == [D("-500"), D("280")]


def test_overview_eur_invested_equals_the_deposits_page(session: Session) -> None:
    seed_g1(session)
    ov = cashflows.eur_overrides_for(session)
    metrics = compute_portfolio_metrics(session, as_of=AS_OF)
    summary = compute_summary(session, today=AS_OF, eur_overrides=ov)
    snap = cash_pool_service.build_pool_snapshot(session, as_of=AS_OF)
    assert sum(cash_pool_service.deposit_eur(snap).values(), D(0)) == D("2000")
    assert metrics.total_contributions_eur.quantize(CENT) == summary.total_contrib_eur.quantize(
        CENT
    )


def test_snapshot_is_cached_per_ledger_change(session: Session) -> None:
    seed_g1(session)
    first = cash_pool_service.build_pool_snapshot(session, as_of=AS_OF)
    assert cash_pool_service.build_pool_snapshot(session, as_of=AS_OF) is first
    session.expire_all()
    session.commit()  # clears the session memo; the inputs are unchanged
    assert cash_pool_service.build_pool_snapshot(session, as_of=AS_OF) is first
    acct = session.query(Account).first()
    assert acct is not None
    _tx(session, acct, 300, date(2026, 4, 20), "fee", "-1")
    session.flush()
    after = cash_pool_service.build_pool_snapshot(session, as_of=AS_OF)
    assert after is not first and after.state.fees_eur > 0


def test_tranche_eur_cost_from_the_pool(session: Session) -> None:
    from investment_dashboard.readmodels import tranches  # noqa: PLC0415

    ids = seed_g1(session)
    view = tranches.build(session, ids["x"])
    assert view is not None and view["eur_basis"] == "pool"
    (row,) = view["rows"]  # 6 of the 10 X shares left (FIFO), $300
    assert D(row["cost_native"]) == D("300")
    assert D(row["cost_eur"]) == D("240") and D(row["orig_eur"]) == D("240")
    z = tranches.build(session, ids["z"])
    assert z is not None and D(z["rows"][0]["cost_eur"]) == D("750")
    _set_basis(session, "buy_date")
    old = tranches.build(session, ids["x"])
    assert old is not None and old["eur_basis"] == "buy_date"
    assert D(old["rows"][0]["cost_eur"]).quantize(CENT) == D("250.00")  # $300 / 1.20
