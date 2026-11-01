"""The single ledger walk: per-account lots, summed per instrument."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Account, Transaction
from investment_dashboard.readmodels.queries.overview_query import compute_instrument_metrics
from investment_dashboard.repositories import fx_repo, instruments_repo, prices_repo
from investment_dashboard.services import ledger_walk
from investment_dashboard.services.positions_service import compute_positions

D = Decimal
AS_OF = date(2024, 6, 28)


def _txn(acct: Account, iid: int, kind: str, on: date, qty: str, net: str) -> Transaction:
    return Transaction(
        account_id=acct.id,
        instrument_id=iid,
        date=on,
        kind=kind,
        quantity=D(qty),
        net_native=D(net),
        source="manual",
    )


def _seed_two_accounts(session: Session) -> int:
    a = Account(broker="vanguard", account_label="A", native_currency="USD")
    b = Account(broker="fidelity", account_label="B", native_currency="USD")
    session.add_all([a, b])
    session.flush()
    vti = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    prices_repo.upsert_closes(session, vti.id, {AS_OF: D("20")})
    fx_repo.upsert_rates(session, {date(2024, 1, 2): D("1.25"), AS_OF: D("1.25")})
    session.add_all(
        [
            # A buys 10 @ 10 (cost 100); B buys 10 @ 30 (cost 300).
            _txn(a, vti.id, "buy", date(2024, 1, 2), "10", "-100"),
            _txn(b, vti.id, "buy", date(2024, 1, 2), "10", "-300"),
            # A sells 5: releases A's own average cost (50), not the pooled one.
            _txn(a, vti.id, "sell", date(2024, 2, 1), "-5", "100"),
        ]
    )
    session.flush()
    return vti.id


def test_lots_apply_average_cost_per_account(session: Session) -> None:
    iid = _seed_two_accounts(session)
    from investment_dashboard.repositories import transactions_repo

    lots = ledger_walk.walk(
        transactions_repo.list_transactions(session), reinvest_keys=set(), money_market_ids=set()
    )
    by_acct = {k[0]: lot for k, lot in lots.items() if k[1] == iid}
    costs = sorted(lot.cost_native for lot in by_acct.values())
    assert costs == [D("50"), D("300")]


def test_instrument_metrics_sum_every_account(session: Session) -> None:
    iid = _seed_two_accounts(session)
    positions = compute_positions(session, as_of=AS_OF)
    assert len(positions) == 2
    im = compute_instrument_metrics(session, positions, as_of=AS_OF)[iid]
    # 5 shares left in A (value 100, cost 50) + 10 in B (value 200, cost 300).
    assert im.capital_gain_native == D("300") - D("350")
    assert im.cost_basis_usd == D("350.00")
    assert im.current_value_eur == (D("300") / D("1.25")).quantize(D("0.01"))
