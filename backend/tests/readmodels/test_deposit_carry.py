"""7.3.1: a matched deposit's currency part is currency, never market.

Dollars bought in January at 1.03 and deposited in July at 1.17 grow the EUR book by
``usd / 1.17`` while the FX pool says they cost ``eur_sent``. That gap is the rate move
while the dollars waited plus the conversion cost; it lands in the currency part (split
into its lines), the market part stays zero for a cash-only book, and the EUR return
(built on what the money cost) is unchanged. Synthetic ledgers, hand-worked values.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from datetime import date
from decimal import Decimal

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from sqlalchemy.orm import Session

from investment_dashboard.domain import fx_attribution as fa
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import currency_effect as ce
from investment_dashboard.readmodels import fx_attribution_rows as rows_rm
from investment_dashboard.repositories import accounts_repo, fx_repo
from investment_dashboard.services import fx_conversion_service, fx_cost_service
from investment_dashboard.services.holding_values_service import (
    HoldingDayDividend,
    HoldingDayValue,
)

D = Decimal
CENT = D("0.005")


class NoHoldings:
    def holding_values(
        self,
        session: Session,
        start: date,
        end: date,
        instrument_ids: Collection[int] | None = None,
    ) -> Sequence[HoldingDayValue]:
        return []

    def holding_dividends(
        self,
        session: Session,
        start: date,
        end: date,
        instrument_ids: Collection[int] | None = None,
    ) -> Sequence[HoldingDayDividend]:
        return []


def _ledger(session: Session) -> int:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="USD brokerage",
        native_currency="USD",
        account_type="brokerage",
    ).id
    fx_repo.upsert_rates(
        session,
        {
            date(2024, 1, 2): D("1.03"),
            date(2024, 1, 5): D("1.03"),  # Friday: a Saturday conversion's fixing
            date(2024, 6, 28): D("1.17"),
            date(2024, 7, 1): D("1.17"),
            date(2024, 7, 2): D("1.17"),
        },
    )
    return acct


def _deposit(session: Session, account_id: int, on: date, usd: str) -> None:
    session.add(
        Transaction(
            account_id=account_id,
            date=on,
            kind="deposit",
            net_native=D(usd),
            source=TransactionSource.MANUAL,
        )
    )
    session.flush()


def _parts(session: Session) -> list[fa.DayParts]:
    book = rows_rm.build_book_rows(
        session, date(2024, 1, 1), date(2024, 7, 2), "EUR", source=NoHoldings()
    )
    return fa.attribute_days(book.rows, "EUR")


def _split(session: Session) -> tuple[Decimal, Decimal, Decimal, Decimal, Decimal]:
    parts = _parts(session)
    b = fa.bridge(parts)
    reval, waiting, cost = ce.carry_split(parts, fx_cost_service.deposit_costs(session))
    return b.market, b.currency, reval, waiting, cost


def test_convert_at_103_deposit_at_117_is_currency_not_market(session: Session) -> None:
    acct = _ledger(session)
    fx_conversion_service.create_conversion(
        session, on=date(2024, 1, 2), eur_sent=D(1000), usd_received=D(1030)
    )
    _deposit(session, acct, date(2024, 7, 1), "1030")
    market, currency, reval, waiting, cost = _split(session)
    # The book grows 1030 / 1.17 = 880.34; the dollars cost EUR 1,000.
    assert abs(currency - (D(1030) / D("1.17") - D(1000))) < CENT  # -119.66
    assert abs(market) < CENT
    assert abs(reval) < CENT
    assert cost == 0  # converted exactly at the fixing
    assert abs(waiting - currency) < CENT


def test_weekend_conversion_with_spread_and_fee_splits_waiting_from_cost(
    session: Session,
) -> None:
    acct = _ledger(session)
    # Saturday 2024-01-06: measured against Friday's 1.03. EUR 1,005 + EUR 5 fee
    # bought $1,030, worth EUR 1,000 at the fixing: cost EUR 10.
    fx_conversion_service.create_conversion(
        session, on=date(2024, 1, 6), eur_sent=D(1005), usd_received=D(1030), fees_eur=D(5)
    )
    _deposit(session, acct, date(2024, 7, 1), "1030")
    market, currency, reval, waiting, cost = _split(session)
    assert abs(cost - D(-10)) < CENT
    assert abs(waiting - (D(1030) / D("1.17") - D(1000))) < CENT  # -119.66
    assert abs(currency - (waiting + cost)) < CENT  # -129.66
    assert abs(market) < CENT
    assert abs(reval) < CENT


def test_part_kept_in_usd_only_the_deposited_dollars_carry(session: Session) -> None:
    acct = _ledger(session)
    fx_conversion_service.create_conversion(
        session, on=date(2024, 1, 2), eur_sent=D(1030), usd_received=D(1060.90), kept_usd=D(30.90)
    )
    _deposit(session, acct, date(2024, 7, 1), "1030")
    market, currency, _reval, waiting, cost = _split(session)
    # $1,030 of the $1,060.90 went to the pool: EUR 1,000 of it, at the fixing.
    assert abs(currency - (D(1030) / D("1.17") - D(1000))) < CENT
    assert abs(cost) < CENT
    assert abs(waiting - currency) < CENT
    assert abs(market) < CENT


def test_ecb_only_deposit_has_no_waiting_and_no_cost(session: Session) -> None:
    acct = _ledger(session)
    _deposit(session, acct, date(2024, 7, 1), "1030")
    market, currency, reval, waiting, cost = _split(session)
    assert (waiting, cost) == (0, 0)
    assert abs(market) < CENT
    assert abs(currency - reval) < CENT


def test_eur_return_still_counts_what_the_money_cost(session: Session) -> None:
    """The waiting loss is real: the EUR chain sees EUR 1,000 in and EUR 880 of book."""
    acct = _ledger(session)
    fx_conversion_service.create_conversion(
        session, on=date(2024, 1, 2), eur_sent=D(1000), usd_received=D(1030)
    )
    _deposit(session, acct, date(2024, 7, 1), "1030")
    parts = _parts(session)
    assert sum((p.flow for p in parts), D(0)) == D(1000)
    # Signs agree: the money figure and the return both say the currency hurt.
    assert fa.bridge(parts).currency < 0


@settings(deadline=None)
@given(
    eur=st.decimals(min_value=D(100), max_value=D(10**5), places=2),
    conv_rate=st.decimals(min_value=D("0.9"), max_value=D("1.4"), places=4),
    spread=st.decimals(min_value=D(0), max_value=D("0.02"), places=4),
    prev_rate=st.decimals(min_value=D("0.9"), max_value=D("1.4"), places=4),
    dep_rate=st.decimals(min_value=D("0.9"), max_value=D("1.4"), places=4),
)
def test_lines_add_up_exactly(
    eur: Decimal, conv_rate: Decimal, spread: Decimal, prev_rate: Decimal, dep_rate: Decimal
) -> None:
    """Property: revaluation + waiting + cost == currency, and parts sum to the change.

    One USD cash book, one deposit of dollars bought at ``conv_rate`` with a spread,
    deposited on a day at ``dep_rate`` (the day before at ``prev_rate``).
    """
    usd = eur * conv_rate * (1 - spread)
    paid = eur
    cost_eur = paid - usd / conv_rate  # what slice_cost gives for this conversion
    d0, d1, d2 = date(2025, 5, 5), date(2025, 5, 6), date(2025, 5, 7)
    days = [
        fa.AttributionDay(d0, {}, {"USD": fa.FxRate(divide_by=prev_rate)}),
        fa.AttributionDay(
            d1,
            {"USD": usd},
            {"USD": fa.FxRate(divide_by=dep_rate)},
            flow=paid,
            carry=usd / dep_rate - paid,
        ),
        fa.AttributionDay(d2, {"USD": usd}, {"USD": fa.FxRate(divide_by=prev_rate)}),
    ]
    parts = fa.attribute_days(days, "EUR")
    b = fa.bridge(parts)
    reval, waiting, cost = ce.carry_split(parts, {d1: cost_eur})
    with fa.exact_context():
        assert reval + waiting + cost == b.currency
        assert b.start + b.flows + b.market + b.currency == b.end
    assert cost <= 0
    # The carry brings the deposit to its own day's value, so the market part is only
    # the day-of-deposit convention (today's book revalued from yesterday's rate,
    # as the Overview's day split does), never the waiting or the cost.
    with fa.exact_context():
        assert abs(b.market + (usd / dep_rate - usd / prev_rate)) < D("1e-20")


@pytest.mark.parametrize("deposit_day", [date(2024, 7, 1), date(2024, 7, 2)])
def test_bridge_payload_lines_add_up_as_displayed(session: Session, deposit_day: date) -> None:
    acct = _ledger(session)
    fx_conversion_service.create_conversion(
        session, on=date(2024, 1, 6), eur_sent=D(1005), usd_received=D(1030), fees_eur=D(5)
    )
    _deposit(session, acct, deposit_day, "1030")
    parts = _parts(session)
    out = ce._bridge(parts, fx_cost_service.deposit_costs(session))
    assert out is not None
    assert D(out["revaluation"]) + D(out["waiting"]) + D(out["conversion_cost"]) == D(
        out["currency"]
    )
    assert D(out["conversion_cost"]) < 0
