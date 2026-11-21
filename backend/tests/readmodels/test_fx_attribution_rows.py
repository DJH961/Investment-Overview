"""Attribution input rows (readmodels.fx_attribution_rows) on synthetic ledgers.

Also pins down how the lifetime currency effect from attribution relates to the
Overview's lifetime ``fx_pnl_eur`` (they differ by definition; see
:func:`test_lifetime_effect_vs_overview_fx_pnl_general_relationship`).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.domain import fx_attribution as fa
from investment_dashboard.domain.currency_effect import compute_currency_effect
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import fx_attribution_rows as rows_rm
from investment_dashboard.readmodels.fx_attribution_rows import (
    HoldingDayDividend,
    HoldingDayValue,
)
from investment_dashboard.repositories import accounts_repo, fx_repo, transactions_repo
from investment_dashboard.services import cashflows

D = Decimal
DAY0 = date(2024, 3, 1)


class FakeHoldings:
    """Stands in for 7.1's ``holding_values_service``: one USD fund, values given per day."""

    def __init__(self, account_id: int, values: dict[date, Decimal], ccy: str = "USD") -> None:
        self.account_id = account_id
        self.values = values
        self.ccy = ccy

    def holding_values(
        self,
        session: Session,
        start: date,
        end: date,
        instrument_ids: Sequence[int] | None = None,
    ) -> Sequence[HoldingDayValue]:
        return [
            HoldingDayValue(d, 1, self.account_id, v, D(1), v, self.ccy)
            for d, v in sorted(self.values.items())
            if start <= d <= end and v
        ]

    def holding_dividends(
        self,
        session: Session,
        start: date,
        end: date,
        instrument_ids: Sequence[int] | None = None,
    ) -> Sequence[HoldingDayDividend]:
        return []


def _source_check(src: rows_rm.HoldingValuesSource) -> rows_rm.HoldingValuesSource:
    return src  # mypy: the fake satisfies the protocol


def _account(session: Session, ccy: str = "USD", kind: str = "brokerage") -> int:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label=f"{ccy} {kind}",
        native_currency=ccy,
        account_type=kind,
    )
    return acct.id


def _deposit(session: Session, account_id: int, on: date, amount: str) -> None:
    session.add(
        Transaction(
            account_id=account_id,
            date=on,
            kind="deposit",
            net_native=D(amount),
            source=TransactionSource.MANUAL,
        )
    )


def _ledger(
    session: Session, rates: list[str], deposits: dict[int, str], market: dict[int, str]
) -> tuple[int, FakeHoldings]:
    """Day i has rate ``rates[i]``; deposits/market moves (USD) by day index."""
    acct = _account(session)
    fx_repo.upsert_rates(session, {DAY0 + timedelta(i): D(r) for i, r in enumerate(rates)})
    values: dict[date, Decimal] = {}
    held = D(0)
    for i in range(len(rates)):
        on = DAY0 + timedelta(i)
        if i in deposits:
            _deposit(session, acct, on, deposits[i])
            held += D(deposits[i])
        held += D(market.get(i, "0"))
        values[on] = held
    session.flush()
    return acct, FakeHoldings(acct, values)


def test_rows_book_rates_and_flows(session: Session) -> None:
    _, src = _ledger(session, ["1.25", "1.25", "1.00", "1.00"], {1: "1000", 3: "500"}, {2: "50"})
    rows = rows_rm.build_attribution_rows(
        session, DAY0, DAY0 + timedelta(3), "EUR", source=_source_check(src)
    )
    assert [r.on for r in rows] == [DAY0 + timedelta(i) for i in range(4)]
    assert rows[0].book == {}
    assert rows[0].flow == 0
    assert rows[1].book == {"USD": D(1000)}
    assert rows[1].flow == D(800)
    assert rows[3].flow == D(500)  # 500 / 1.00
    assert rows[2].rates["USD"] == fa.FxRate(divide_by=D("1.00"))
    parts = fa.attribute_days(rows, "EUR")
    assert parts[1].currency == D(1050) - D(840)  # the 1050 USD close book, 1.25 -> 1.00
    assert parts[1].market == D(40)  # 50 USD at the previous close rate (1.25)
    usd = rows_rm.build_attribution_rows(session, DAY0, DAY0 + timedelta(3), "USD", source=src)
    assert all(p.currency == 0 for p in fa.attribute_days(usd, "USD"))  # no EUR holdings
    assert usd[1].flow == D(1000)


def test_usd_view_carries_the_effect_on_euro_cash(session: Session) -> None:
    savings = _account(session, "EUR", "savings")
    fx_repo.upsert_rates(session, {DAY0: D("1.10"), DAY0 + timedelta(1): D("1.20")})
    _deposit(session, savings, DAY0, "1000")
    session.flush()
    empty = FakeHoldings(savings, {})
    rows = rows_rm.build_attribution_rows(
        session, DAY0 - timedelta(1), DAY0 + timedelta(1), "USD", source=empty
    )
    assert rows[1].book == {"EUR": D(1000)}
    assert rows[1].flow == D(1100)
    parts = fa.attribute_days(rows, "USD")
    assert parts[-1].currency == D(100)  # 1000 EUR x (1.20 - 1.10)
    eur_parts = fa.attribute_days(
        rows_rm.build_attribution_rows(
            session, DAY0 - timedelta(1), DAY0 + timedelta(1), "EUR", source=empty
        ),
        "EUR",
    )
    assert all(p.currency == 0 for p in eur_parts)


def test_flow_between_rows_lands_on_the_next_row(session: Session) -> None:
    acct = _account(session)
    fx_repo.upsert_rates(session, {DAY0: D("1.25")})
    _deposit(session, acct, DAY0 + timedelta(1), "100")  # no value row that day
    session.flush()
    src = FakeHoldings(acct, {DAY0: D(10), DAY0 + timedelta(2): D(110)})
    rows = rows_rm.build_attribution_rows(session, DAY0, DAY0 + timedelta(2), "EUR", source=src)
    assert [r.on for r in rows] == [DAY0, DAY0 + timedelta(2)]
    assert rows[1].flow == D(80)
    (p,) = fa.attribute_days(rows, "EUR")
    assert p.market == 0
    assert p.currency == 0


def test_missing_rate_for_a_held_currency_is_an_error(session: Session) -> None:
    acct = _account(session)
    session.flush()
    src = FakeHoldings(acct, {DAY0: D(10)})
    with pytest.raises(ValueError, match="no USD rate"):
        rows_rm.build_attribution_rows(session, DAY0, DAY0, "EUR", source=src)


def _overview_fx_pnl(session: Session, end_value_usd: Decimal, end_rate: Decimal) -> Decimal:
    txns = transactions_repo.list_transactions(session)
    rates = fx_repo.get_rates(session)
    effect = compute_currency_effect(
        contributions_eur=cashflows.sum_amounts(
            txns, cashflows.EXTERNAL_FLOW_KINDS, "EUR", eur_to_usd=rates
        ),
        contributions_usd=cashflows.sum_amounts(
            txns, cashflows.EXTERNAL_FLOW_KINDS, "USD", eur_to_usd=rates
        ),
        value_eur=end_value_usd / end_rate,
        value_usd=end_value_usd,
        growth_eur=None,
        growth_usd=None,
    )
    assert effect.fx_pnl_eur is not None
    return effect.fx_pnl_eur


TOL = D("1e-18")


def test_lifetime_effect_equals_overview_fx_pnl_when_definitions_coincide(session: Session) -> None:
    """Equal exactly when the book changes only by deposits made on flat-rate days.

    Rates move only on days with no deposit and there is no market move, so
    every dollar entered at the rate it is then revalued from: both figures are
    ``E_T - sum(deposit EUR legs)``.
    """
    rates = ["1.25", "1.25", "1.10", "1.10", "1.20", "1.20", "1.05"]
    _, src = _ledger(session, rates, {1: "1000", 3: "2000", 5: "500"}, {})
    end = DAY0 + timedelta(len(rates) - 1)
    rows = rows_rm.build_attribution_rows(session, DAY0, end, "EUR", source=src)
    lifetime = fa.bridge(fa.attribute_days(rows, "EUR")).currency
    fx_pnl = _overview_fx_pnl(session, D(3500), D("1.05"))
    assert abs(lifetime - fx_pnl) <= TOL
    assert lifetime != 0


def test_lifetime_effect_vs_overview_fx_pnl_general_relationship(session: Session) -> None:
    """In general they differ by definition; the gap is exactly known.

    With x_t = 1/r_t, an empty book before the first deposit and dN_t the
    day's change in the dollar book (deposits *and* market moves), summation by
    parts gives

        attribution lifetime  C = sum_t N_t (x_t - x_{t-1}) = E_T - sum_t dN_t x_{t-1}
        Overview fx_pnl_eur   P = E_T - N_T / r_avg,  r_avg = sum D_usd / sum D_eur

    so  P - C = sum_t dN_t (x_{t-1} - 1 / r_avg): each dollar change valued at
    the previous close's rate versus at the average deposit rate. They differ
    whenever the book grows by market moves (valued at r_avg by P, at the rate
    of the day by C) or a deposit lands on a day the rate moved.
    """
    rates = ["1.25", "1.20", "1.10", "1.15", "1.20", "1.00", "1.05"]
    deposits = {1: "1000", 3: "2000", 5: "500"}
    market = {2: "100", 4: "-300", 6: "250"}
    _, src = _ledger(session, rates, deposits, market)
    end = DAY0 + timedelta(len(rates) - 1)
    rows = rows_rm.build_attribution_rows(session, DAY0, end, "EUR", source=src)
    c = fa.bridge(fa.attribute_days(rows, "EUR")).currency

    n = [D(0)]
    for i in range(1, len(rates)):
        n.append(n[-1] + D(deposits.get(i, "0")) + D(market.get(i, "0")))
    n_end = n[-1]
    dep_usd = sum((D(v) for v in deposits.values()), D(0))
    dep_eur = sum((D(v) / D(rates[i]) for i, v in deposits.items()), D(0))
    r_avg = dep_usd / dep_eur
    gap = sum(
        (((n[i] - n[i - 1]) * (1 / D(rates[i - 1]) - 1 / r_avg)) for i in range(1, len(rates))),
        D(0),
    )

    p = _overview_fx_pnl(session, n_end, D(rates[-1]))
    assert abs((p - c) - gap) <= D("1e-15")
    assert abs(p - c) > D(1)  # they really differ here
