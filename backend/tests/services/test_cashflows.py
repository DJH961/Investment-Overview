# ruff: noqa: PT018
"""Tests for the canonical ``services.cashflows`` module (and its FX-pool wiring)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain.returns import xirr
from investment_dashboard.models import Account, FxHistory, Transaction
from investment_dashboard.repositories import instruments_repo, prices_repo
from investment_dashboard.services import (
    benchmark_service,
    cashflows,
    fx_conversion_service,
    metrics_service,
)

D = Decimal
AS_OF = date(2024, 6, 30)
ECB = D("1.25")


def _acct(session: Session, ccy: str) -> Account:
    a = Account(broker="vanguard", account_label=f"A-{ccy}", native_currency=ccy)
    session.add(a)
    session.flush()
    return a


def _txn(account: Account, kind: str, on: date, **kw: object) -> Transaction:
    return Transaction(account_id=account.id, date=on, kind=kind, source="manual", **kw)


# --- missing-FX policy -------------------------------------------------------


def test_usd_native_without_net_eur_converts_at_trade_date_rate(session: Session) -> None:
    usd = _acct(session, "USD")
    t = _txn(usd, "deposit", date(2024, 2, 1), net_native=D("1000"))
    session.add(t)
    session.flush()
    rates = {date(2024, 1, 1): D("1.25")}
    assert cashflows.txn_eur_amount(t, eur_to_usd=rates) == D("800")
    assert cashflows.txn_usd_amount(t, eur_to_usd=rates) == D("1000")


def test_usd_native_without_net_eur_and_without_rate_is_none_not_usd_as_eur(
    session: Session,
) -> None:
    usd = _acct(session, "USD")
    t = _txn(usd, "deposit", date(2024, 2, 1), net_native=D("1000"))
    session.add(t)
    session.flush()
    assert cashflows.txn_eur_amount(t, eur_to_usd={}) is None
    assert cashflows.txn_usd_amount(t, eur_to_usd={}) == D("1000")  # booked amount is exact


def test_eur_native_without_net_usd_and_without_rate_has_no_usd_leg(session: Session) -> None:
    eur = _acct(session, "EUR")
    t = _txn(eur, "deposit", date(2024, 2, 1), net_native=D("500"))
    session.add(t)
    session.flush()
    assert cashflows.txn_eur_amount(t, eur_to_usd={}) == D("500")
    assert cashflows.txn_usd_amount(t, eur_to_usd={}) is None
    assert cashflows.txn_amount(t, "GBP", eur_to_usd={}) is None


def test_streams_and_sums_omit_unknown_legs(session: Session) -> None:
    usd = _acct(session, "USD")
    eur = _acct(session, "EUR")
    a = _txn(usd, "deposit", date(2024, 2, 1), net_native=D("1000"))
    b = _txn(eur, "deposit", date(2024, 2, 2), net_native=D("500"))
    session.add_all([a, b])
    session.flush()
    eur_flows, usd_flows = cashflows.build_portfolio_cashflows_dual([a, b], eur_to_usd={})
    assert [(f.date, f.amount) for f in eur_flows] == [(date(2024, 2, 2), D("-500"))]
    assert [(f.date, f.amount) for f in usd_flows] == [(date(2024, 2, 1), D("-1000"))]
    assert cashflows.sum_amounts([a, b], cashflows.CONTRIBUTION_KINDS, "EUR", eur_to_usd={}) == 500


def test_frozen_legs_are_returned_verbatim(session: Session) -> None:
    usd = _acct(session, "USD")
    t = _txn(
        usd, "deposit", date(2024, 2, 1), net_native=D("1000"), net_eur=D("900"), net_usd=D("1000")
    )
    session.add(t)
    session.flush()
    assert cashflows.txn_eur_amount(t, eur_to_usd={}) == D("900")
    assert cashflows.txn_eur_amount(t, eur_overrides={t.id: D("950")}) == D("950")
    assert cashflows.txn_usd_amount(t, eur_to_usd={}) == D("1000")  # USD never overridden


# --- plan section 7: two batches, three deposits -----------------------------


def _seed_pool_ledger(session: Session, *, with_conversions: bool) -> None:
    session.add(FxHistory(date=date(2024, 1, 1), base="EUR", quote="USD", rate=ECB))
    usd = _acct(session, "USD")
    vti = instruments_repo.get_or_create(session, symbol="VTI", native_currency="USD")
    for on, amt in (
        (date(2024, 2, 1), "1000"),
        (date(2024, 5, 1), "600"),
        (date(2024, 6, 1), "700"),
    ):
        session.add(
            _txn(
                usd,
                "deposit",
                on,
                net_native=D(amt),
                net_eur=D(amt) / ECB,
                net_usd=D(amt),
            )
        )
    session.add(
        _txn(
            usd,
            "buy",
            date(2024, 6, 2),
            instrument_id=vti.id,
            quantity=D("20"),
            price_native=D("115"),
            net_native=D("-2300"),
            net_eur=D("-1840"),
            net_usd=D("-2300"),
        )
    )
    prices_repo.upsert_closes(
        session, vti.id, {date(2024, 6, 2): D("115"), date(2024, 6, 28): D("130")}
    )
    if with_conversions:
        fx_conversion_service.create_conversion(
            session, on=date(2024, 1, 10), eur_sent=D("1000"), usd_received=D("1100")
        )
        fx_conversion_service.create_conversion(
            session,
            on=date(2024, 4, 10),
            eur_sent=D("1000"),
            usd_received=D("1200"),
            fees_eur=D("10"),
        )
    session.flush()


def test_fx_pool_overrides_drive_eur_xirr_but_not_usd(session: Session) -> None:
    # Baseline: no conversions -> overrides are empty and EUR uses the frozen ECB legs.
    _seed_pool_ledger(session, with_conversions=False)
    assert fx_conversion_service.effective_eur_overrides(session) == {}
    base = metrics_service.compute_portfolio_metrics(session, as_of=AS_OF)
    assert base.total_contributions_eur == D("2300") / ECB  # 1840
    assert base == metrics_service.compute_portfolio_metrics(session, as_of=AS_OF, eur_overrides={})

    # Now the same ledger with the two batches entered.
    fx_conversion_service.create_conversion(
        session, on=date(2024, 1, 10), eur_sent=D("1000"), usd_received=D("1100")
    )
    fx_conversion_service.create_conversion(
        session, on=date(2024, 4, 10), eur_sent=D("1000"), usd_received=D("1200"), fees_eur=D("10")
    )
    session.flush()
    with_pool = metrics_service.compute_portfolio_metrics(session, as_of=AS_OF)

    # Hand-worked FIFO: deposit 1 (1000 USD) takes 1000/1100 of batch A.
    eur1 = D("1000") * D("1000") / D("1100")
    left_a = D("1000") - eur1  # 100 USD left in A
    eur2 = left_a + D("1010") * D("500") / D("1200")  # + 500 USD from B
    eur3 = D("1010") - D("1010") * D("500") / D("1200")  # the remaining 700 USD of B
    assert abs(eur1 + eur2 + eur3 - D("2010")) < D("1e-20")  # the EUR actually sent

    assert abs(with_pool.total_contributions_eur - D("2010")) < D("1e-9")
    # USD contributions and the USD return are untouched by the pool.
    assert with_pool.total_contributions_usd == base.total_contributions_usd == D("2300")
    assert with_pool.xirr_usd == base.xirr_usd
    assert with_pool.total_growth_compounded_usd == base.total_growth_compounded_usd

    # EUR XIRR = XIRR of the EUR actually spent (terminal 2600 USD / 1.25 = 2080 EUR).
    expected = xirr(
        [
            cashflows.Cashflow(date(2024, 2, 1), -eur1),
            cashflows.Cashflow(date(2024, 5, 1), -eur2),
            cashflows.Cashflow(date(2024, 6, 1), -eur3),
        ],
        as_of=AS_OF,
        terminal_value=D("2080"),
    )
    assert expected is not None and with_pool.xirr is not None and base.xirr is not None
    assert abs(with_pool.xirr - expected) < D("1e-9")
    assert with_pool.xirr != base.xirr

    # The funded EUR benchmark uses the same EUR stream; USD benchmark is USD-only.
    sym = benchmark_service.get_symbol(session)
    bench = instruments_repo.get_or_create(session, symbol=sym, native_currency="USD")
    prices_repo.upsert_closes(
        session,
        bench.id,
        {date(2024, 1, 2): D("100"), date(2024, 2, 1): D("100"), date(2024, 6, 28): D("120")},
    )
    session.flush()
    usd_b = benchmark_service.simulate_benchmark_xirr(session, as_of=AS_OF, currency="USD")
    eur_b = benchmark_service.simulate_benchmark_xirr(session, as_of=AS_OF, currency="EUR")
    assert usd_b is not None and eur_b is not None
    # USD path never touches FX: same closes in/out, so only the USD stream matters.
    assert usd_b == benchmark_service.simulate_benchmark_xirr(
        session, as_of=AS_OF, currency="USD", eur_overrides={}
    )
    assert eur_b != benchmark_service.simulate_benchmark_xirr(
        session, as_of=AS_OF, currency="EUR", eur_overrides={}
    )


# --- B1: derived legs are canonical, frozen legs are cross-checks ------------


def test_cashflow_conversion_uses_each_dates_own_rate_not_frozen_leg(session: Session) -> None:
    usd = _acct(session, "USD")
    t1 = _txn(
        usd, "deposit", date(2024, 1, 10), net_native=D("1000"), net_eur=D("1"), net_usd=D("1000")
    )
    t2 = _txn(usd, "deposit", date(2024, 3, 10), net_native=D("1000"))
    session.add_all([t1, t2])
    session.flush()
    rates = {date(2024, 1, 10): D("1.25"), date(2024, 3, 10): D("2")}
    flows = cashflows.build_portfolio_cashflows([t1, t2], currency="EUR", eur_to_usd=rates)
    assert [f.amount for f in flows] == [D("-800"), D("-500")]


def test_frozen_leg_is_fallback_when_no_rate_on_file(session: Session) -> None:
    usd = _acct(session, "USD")
    t = _txn(usd, "deposit", date(2024, 1, 10), net_native=D("1000"), net_eur=D("900"))
    session.add(t)
    session.flush()
    assert cashflows.txn_eur_amount(t, eur_to_usd={}) == D("900")


def test_eur_xirr_golden_uses_per_date_rates(session: Session) -> None:
    usd = _acct(session, "USD")
    t = _txn(usd, "deposit", date(2023, 1, 1), net_native=D("1000"))
    session.add(t)
    session.flush()
    rates = {date(2023, 1, 1): D("1.25")}  # EUR 800 in
    flows = cashflows.build_portfolio_cashflows([t], currency="EUR", eur_to_usd=rates)
    # Terminal EUR value 880 one year later => exactly 10 % (365 days).
    result = xirr(flows, date(2024, 1, 1), terminal_value=D("880"))
    assert result is not None and abs(result - D("0.10")) < D("0.0001")


def test_instant_valuation_in_eur_is_usd_over_fx() -> None:
    from investment_dashboard.domain.currency import usd_to_eur_at

    assert usd_to_eur_at(D("1100"), D("1.1")) == D("1000")
