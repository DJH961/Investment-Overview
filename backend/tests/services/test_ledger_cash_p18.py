"""P18 (7.4): one ledger-cash rule; broker cash outside money-market funds is in the total."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Account, Transaction
from investment_dashboard.repositories import fx_repo, instruments_repo, prices_repo
from investment_dashboard.services import positions_service

D = Decimal
AS_OF = date(2026, 3, 31)


def _tx(session: Session, acct: Account, on: date, kind: str, net: str, **kw: object) -> None:
    session.add(
        Transaction(
            account_id=acct.id, date=on, kind=kind, net_native=D(net), source="manual", **kw
        )
    )


def _accounts(session: Session) -> tuple[Account, Account, Account]:
    unswept = Account(broker="fidelity", account_label="F", native_currency="USD")
    swept = Account(broker="vanguard", account_label="V", native_currency="USD")
    savings = Account(
        broker="savings_bank", account_label="S", native_currency="EUR", account_type="savings"
    )
    session.add_all([unswept, swept, savings])
    session.flush()
    fx_repo.upsert_rates(session, {date(2026, 1, 1): D("1.25")})
    return unswept, swept, savings


def test_broker_cash_counts_in_the_total(session: Session) -> None:
    unswept, swept, savings = _accounts(session)
    vti = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    mmf = instruments_repo.get_or_create(
        session, symbol="VMFXX", name="Federal Money Market", asset_class="mutual_fund"
    )
    prices_repo.upsert_closes(session, vti.id, {AS_OF: D("100")})
    # unswept: deposit 1,000, buy 6 VTI for 600 -> 400 waiting as cash
    _tx(session, unswept, date(2026, 1, 5), "deposit", "1000")
    _tx(session, unswept, date(2026, 1, 6), "buy", "-600", instrument_id=vti.id, quantity=D(6))
    # swept: every cash move has its money-market leg -> no ledger cash
    _tx(session, swept, date(2026, 1, 5), "deposit", "500")
    _tx(session, swept, date(2026, 1, 5), "buy", "-500", instrument_id=mmf.id, quantity=D(500))
    _tx(session, savings, date(2026, 1, 7), "deposit", "250")
    session.flush()
    balances = {a.id: b for a, b in positions_service.ledger_cash_balances(session, as_of=AS_OF)}
    assert balances == {unswept.id: D("400"), savings.id: D("250")}
    # 6 x 100 + MMF 500 + cash 400 = $1,500 = EUR 1,200; + EUR 250 savings
    total_eur = positions_service.total_portfolio_value(session, as_of=AS_OF)
    assert total_eur == D("1450")
    total_usd = positions_service.total_portfolio_value_usd(session, as_of=AS_OF)
    assert total_usd == D("1500") + D("250") * D("1.25")


def test_negative_broker_cash_counts_as_zero_and_is_flagged(session: Session) -> None:
    unswept, _swept, savings = _accounts(session)
    vti = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    # a buy with no deposit before it (an in-kind transfer missing from the ledger)
    _tx(session, unswept, date(2026, 1, 6), "buy", "-300", instrument_id=vti.id, quantity=D(3))
    _tx(session, unswept, date(2026, 2, 1), "deposit", "100")
    _tx(session, savings, date(2026, 1, 7), "withdrawal", "-20")  # savings keeps its sign
    session.flush()
    cash = positions_service.ledger_cash(session, end=AS_OF)
    assert cash.at(unswept.id, date(2026, 1, 31)) == 0
    assert cash.at(unswept.id, AS_OF) == D("100")  # counted from zero after the shortfall
    (gap,) = positions_service.broker_cash_shortfalls(session, as_of=AS_OF)
    assert (gap.account_id, gap.on, gap.currency, gap.native) == (
        unswept.id,
        date(2026, 1, 6),
        "USD",
        D("300"),
    )
    balances = dict(positions_service.ledger_cash_balances(session, as_of=AS_OF))
    assert {a.id: b for a, b in balances.items()} == {unswept.id: D("100"), savings.id: D("-20")}


def test_reinvested_dividend_never_touches_broker_cash(session: Session) -> None:
    unswept, _swept, _savings = _accounts(session)
    vti = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    _tx(session, unswept, date(2026, 1, 5), "deposit", "100")
    _tx(session, unswept, date(2026, 2, 1), "dividend_cash", "5", instrument_id=vti.id)
    # the reinvest leg carries no cash amount: the paired cash leg must not count
    _tx(
        session,
        unswept,
        date(2026, 2, 1),
        "dividend_reinvest",
        "0",
        instrument_id=vti.id,
        quantity=D("0.05"),
        price_native=D("100"),
    )
    _tx(session, unswept, date(2026, 3, 1), "interest", "1")
    session.flush()
    balances = {a.id: b for a, b in positions_service.ledger_cash_balances(session, as_of=AS_OF)}
    assert balances == {unswept.id: D("101")}
