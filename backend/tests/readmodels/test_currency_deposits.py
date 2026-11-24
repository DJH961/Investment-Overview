"""The investing view (Impact, USD side): what the rate did to your deposits.

Synthetic ledgers and hand-worked values only; no real data.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from sqlalchemy.orm import Session

from investment_dashboard.domain import deposit_effect as de
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import currency_deposits as cd
from investment_dashboard.repositories import accounts_repo, fx_repo
from investment_dashboard.services import fx_conversion_service

D = Decimal


# -- domain golden values ------------------------------------------------------------------


def test_two_deposits_at_different_rates() -> None:
    # Start rate 1.10. A: $1,100 for EUR 1,000 (rate 1.10): 1100 - 1000 * 1.10 = 0.
    # B: $1,200 for EUR 1,000 (rate 1.20, a stronger euro): 1200 - 1100 = +100.
    a = de.Deposit(1, date(2024, 1, 5), D(1100), D(1000))
    b = de.Deposit(2, date(2024, 2, 5), D(1200), D(1000))
    items = de.effects([b, a], D("1.10"))
    assert [e.effect for e in items] == [D(0), D(100)]
    tot = de.totals(items)
    assert (tot.eur, tot.usd, tot.usd_at_start, tot.effect) == (D(2000), D(2300), D(2200), D(100))
    series = de.cumulative(items, date(2024, 1, 1))
    assert [(p.usd, p.usd_at_start, p.effect) for p in series] == [
        (D(0), D(0), D(0)),
        (D(1100), D(1100), D(0)),
        (D(2300), D(2200), D(100)),
    ]
    assert de.month_totals(items) == [("2024-01", D(0)), ("2024-02", D(100))]
    assert de.year_totals(items) == [("2024", D(100))]


@settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(
    rate=st.decimals(min_value=D("0.8"), max_value=D("1.6"), places=4),
    amounts=st.lists(st.decimals(min_value=D(1), max_value=D(10**6), places=2), max_size=20),
)
def test_effect_is_zero_when_the_rate_never_moves(rate: Decimal, amounts: list[Decimal]) -> None:
    deps = [
        de.Deposit(i, date(2024, 1, 1) + timedelta(i), usd, usd / rate)
        for i, usd in enumerate(amounts)
    ]
    tot = de.totals(de.effects(deps, rate))
    assert abs(tot.effect) < D("1e-15") * (1 + len(amounts))
    rolled = de.rolling(deps, lambda _d: rate, [date(2024, 3, 1)])
    assert all(abs(v) < D("1e-15") * (1 + len(amounts)) for _t, v in rolled)


@settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(
    r0=st.decimals(min_value=D("0.8"), max_value=D("1.6"), places=4),
    rows=st.lists(
        st.tuples(
            st.decimals(min_value=D(1), max_value=D(10**5), places=2),
            st.decimals(min_value=D("0.8"), max_value=D("1.6"), places=4),
        ),
        max_size=20,
    ),
)
def test_effect_is_eur_times_rate_gap_and_months_add_up(
    r0: Decimal, rows: list[tuple[Decimal, Decimal]]
) -> None:
    deps = [
        de.Deposit(i, date(2024, 1, 1) + timedelta(10 * i), eur * r, eur)
        for i, (eur, r) in enumerate(rows)
    ]
    items = de.effects(deps, r0)
    for e in items:
        assert abs(e.effect - e.deposit.eur * (e.deposit.rate - r0)) < D("1e-18")
    tot = de.totals(items)
    assert abs(sum((v for _k, v in de.month_totals(items)), D(0)) - tot.effect) < D("1e-18")


# -- the readmodel on a synthetic ledger ------------------------------------------------------


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


def test_matched_weekend_and_partly_matched_deposits(session: Session) -> None:
    """Start close Mon 2024-03-04 at 1.10.

    A (Tue 03-05, $1,000): matched to a conversion of EUR 900 -> $1,000 (rate 1.1111):
      1000 - 900 * 1.10 = +10.
    B (Sat 03-09, $550): unmatched, Friday's fixing 1.00 -> EUR 550:
      550 - 550 * 1.10 = -55.
    C (Thu 03-14, $1,000): $600 matched to EUR 500 (1.20), $400 at that day's 1.25
      (EUR 320) -> EUR 820: 1000 - 820 * 1.10 = +98.
    Total +53 on EUR 2,270 sent; EUR 1,000 bought $1,100 at the start, $1,250 at the end.
    """
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
            date(2024, 3, 4): D("1.10"),
            date(2024, 3, 5): D("1.12"),
            date(2024, 3, 8): D("1.00"),
            date(2024, 3, 11): D("1.05"),
            date(2024, 3, 14): D("1.25"),
        },
    )
    fx_conversion_service.create_conversion(
        session, on=date(2024, 3, 4), eur_sent=D(900), usd_received=D(1000)
    )
    fx_conversion_service.create_conversion(
        session, on=date(2024, 3, 13), eur_sent=D(500), usd_received=D(600)
    )
    _deposit(session, acct, date(2024, 3, 5), "1000")
    _deposit(session, acct, date(2024, 3, 9), "550")
    _deposit(session, acct, date(2024, 3, 14), "1000")
    session.flush()

    deps = {d.on: d for d in cd.usd_deposits(session=session)}
    assert deps[date(2024, 3, 5)].eur == D(900)
    assert deps[date(2024, 3, 5)].source == "matched"
    assert deps[date(2024, 3, 9)].eur == D(550)
    assert deps[date(2024, 3, 9)].source == "ecb"
    assert deps[date(2024, 3, 14)].eur == D(820)
    assert deps[date(2024, 3, 14)].source == "partly"

    out = cd.build_investing(session, date(2024, 3, 4), date(2024, 3, 15), first=date(2024, 3, 4))
    assert out is not None
    effects = {r["on"]: D(r["effect"]) for r in out["deposits"]}
    assert effects == {"2024-03-05": D(10), "2024-03-09": D(-55), "2024-03-14": D(98)}
    assert D(out["effect"]) == D(53)
    assert out["kind"] == "tailwind"
    assert D(out["eur_sent"]) == D(2270)
    assert D(out["usd_received"]) == D(2550)
    bridge_sum = D(out["usd_at_start"]) + D(out["effect"])
    assert bridge_sum == D(out["usd_received"])
    # The regular amount (default EUR 100), not a fixed 1,000.
    assert D(out["rate_only"]["usd_at_start"]) == D(110)
    assert D(out["rate_only"]["usd_now"]) == D(125)
    assert out["records"]["best_day"] == {"label": "2024-03-14", "currency": "98.000000"}
    assert out["records"]["worst_day"] == {"label": "2024-03-09", "currency": "-55.000000"}
    assert out["series"][-1]["currency"] == "53.000000"
    # All: measured from the first transaction day's rate (1.10 here too).
    assert cd.window_effect(session, date.min, date(2024, 3, 15), date(2024, 3, 4)) == D(53)


def test_a_range_that_starts_before_you_did_is_measured_from_your_first_day(
    session: Session,
) -> None:
    """Max: no rate exists before the first deposit's day, yet the figures are yours."""
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="USD brokerage",
        native_currency="USD",
        account_type="brokerage",
    ).id
    fx_repo.upsert_rates(
        session,
        {date(2023, 12, 29): D("1.10"), date(2024, 1, 2): D("1.11"), date(2024, 6, 3): D("1.08")},
    )
    _deposit(session, acct, date(2024, 1, 2), "1000")
    session.flush()
    out = cd.build_investing(session, date(1998, 12, 31), date(2024, 6, 4), first=date(2024, 1, 2))
    assert out is not None
    assert D(out["start_rate"]) == D("1.10")
    assert D(out["rate_only"]["change"]) == D(-2)  # EUR 100: $110 -> $108


def test_no_deposits_in_the_range_still_answers(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="USD brokerage",
        native_currency="USD",
        account_type="brokerage",
    ).id
    fx_repo.upsert_rates(session, {date(2024, 1, 2): D("1.10"), date(2024, 6, 3): D("1.08")})
    _deposit(session, acct, date(2024, 1, 2), "1000")
    session.flush()
    out = cd.build_investing(session, date(2024, 5, 1), date(2024, 6, 4), first=date(2024, 1, 2))
    assert out is not None
    assert out["deposit_count"] == 0
    assert D(out["effect"]) == 0
    assert D(out["rate_only"]["change"]) == D(-2)  # EUR 100: $110 -> $108
    assert out["rate_only"]["kind"] == "headwind"
