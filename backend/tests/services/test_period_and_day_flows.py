"""B-006 (period start) and B-007 (day move net of flows): hand-worked goldens.

Every book here is flat (no price moves), so every period and day figure must be
exactly zero whatever the deposits and buys do. Fake symbols only.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.readmodels.queries.overview_query import compute_instrument_metrics
from investment_dashboard.readmodels.queries.period_query import aggregate
from investment_dashboard.repositories import accounts_repo, fx_repo, instruments_repo, prices_repo
from investment_dashboard.services import metrics_service, positions_service, scheduler

D = Decimal
FX = D("1.10")


def _deposit(account_id: int, on: date, amount: str) -> Transaction:
    return Transaction(
        account_id=account_id,
        date=on,
        kind="deposit",
        net_native=D(amount),
        source="manual",
    )


def _savings(session: Session) -> int:
    return accounts_repo.create_account(
        session,
        broker="savings_bank",
        account_label="Savings",
        native_currency="EUR",
        account_type="savings",
    ).id


def _rates(session: Session, days: list[date], rate: Decimal = FX) -> None:
    fx_repo.upsert_rates(session, dict.fromkeys(days, rate))


def test_mtd_is_zero_for_a_deposit_on_the_first_in_a_flat_market(session: Session) -> None:
    """€50k book, €1k deposit on 1 Mar 2026, nothing moves; as of 16 Mar.

    Opening = close of 28 Feb = 50,000; flows dated >= 1 Mar = 1,000; value 51,000.
    MTD = (51,000 - 50,000 - 1,000) / (50,000 + 1,000) = 0.00 %.
    (Before B-006 the opening was the close of 1 Mar = 51,000, so the deposit was
    counted twice: (51,000 - 51,000 - 1,000) / 52,000 = -1.92 %.)
    """
    acct = _savings(session)
    session.add_all(
        [_deposit(acct, date(2026, 2, 10), "50000"), _deposit(acct, date(2026, 3, 1), "1000")]
    )
    _rates(session, [date(2026, 1, 2), date(2026, 2, 10), date(2026, 3, 1), date(2026, 3, 16)])
    session.flush()
    m = metrics_service.compute_portfolio_metrics(session, as_of=date(2026, 3, 16))
    assert m.total_value_eur == D("51000")
    assert m.mtd_growth_pct == D(0)
    assert m.mtd_growth_pct_usd == D(0)


def test_ytd_is_zero_for_a_deposit_on_new_years_day(session: Session) -> None:
    """€50k on 15 Dec 2025, €1k on 1 Jan 2026, flat; as of 16 Mar 2026.

    Opening = close of 31 Dec 2025 = 50,000; flows from 1 Jan = 1,000.
    YTD = (51,000 - 50,000 - 1,000) / 51,000 = 0.
    """
    acct = _savings(session)
    session.add_all(
        [_deposit(acct, date(2025, 12, 15), "50000"), _deposit(acct, date(2026, 1, 1), "1000")]
    )
    _rates(session, [date(2025, 12, 15), date(2026, 1, 1), date(2026, 3, 16)])
    session.flush()
    m = metrics_service.compute_portfolio_metrics(session, as_of=date(2026, 3, 16))
    assert m.ytd_growth_pct == D(0)
    assert m.ytd_growth_pct_usd == D(0)


def test_first_year_ytd_is_not_minus_fifty_percent(session: Session) -> None:
    """First deposit on 10 Jan 2026 (€5,000), flat; as of 16 Mar 2026.

    Nothing is valued at the 31 Dec close, so YTD opens at the first valued close
    (10 Jan, 5,000) and counts only the flows after it (none):
    YTD = (5,000 - 5,000 - 0) / 5,000 = 0. (Before: that 10 Jan opening also counted
    the 10 Jan deposit as a flow: -5,000 / 10,000 = -50 %.)
    """
    acct = _savings(session)
    session.add(_deposit(acct, date(2026, 1, 10), "5000"))
    _rates(session, [date(2026, 1, 2), date(2026, 3, 16)])
    session.flush()
    m = metrics_service.compute_portfolio_metrics(session, as_of=date(2026, 3, 16))
    assert m.ytd_growth_pct == D(0)


def test_periods_table_uses_the_same_opening(session: Session) -> None:
    """The Periods row for March 2026 opens at the 28 Feb close, like the MTD tile."""
    acct = _savings(session)
    session.add_all(
        [_deposit(acct, date(2026, 2, 10), "50000"), _deposit(acct, date(2026, 3, 1), "1000")]
    )
    _rates(session, [date(2026, 2, 10), date(2026, 3, 1), date(2026, 3, 16)])
    session.flush()
    rows = {r.label: r for r in aggregate(session, monthly=True, today=date(2026, 3, 16))}
    march = rows["2026-03"]
    assert march.opening_value_eur == D("50000")
    assert march.growth_pct == D(0)


# -- B-007: day move ---------------------------------------------------------------

PREV, TODAY = date(2026, 11, 3), date(2026, 11, 4)  # Tue, Wed
AFTER_CLOSE = datetime(2026, 11, 4, 22, 0, tzinfo=UTC)


def _flat_book_with_deposit_and_buy_today(session: Session) -> int:
    """EUR brokerage holding 100 FAKE1 @ 100 since October (flat at 100).

    Today: deposit €1,000 into the brokerage and buy 10 FAKE1 @ 100 with it.
    Value 10,000 -> 11,000; net external flow +1,000; day move = 0.
    """
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Brokerage",
        native_currency="EUR",
        account_type="brokerage",
    )
    fake = instruments_repo.get_or_create(
        session, symbol="FAKE1", asset_class="etf", native_currency="EUR"
    )
    for on, qty in ((date(2026, 10, 1), "100"), (TODAY, "10")):
        session.add(
            Transaction(
                account_id=acct.id,
                instrument_id=fake.id,
                date=on,
                kind="buy",
                quantity=D(qty),
                price_native=D("100"),
                net_native=-D(qty) * D("100"),
                source="manual",
            )
        )
    session.add_all(
        [_deposit(acct.id, date(2026, 10, 1), "10000"), _deposit(acct.id, TODAY, "1000")]
    )
    prices_repo.upsert_closes(
        session, fake.id, {date(2026, 10, 1): D("100"), PREV: D("100"), TODAY: D("100")}
    )
    _rates(session, [date(2026, 10, 1), PREV, TODAY])
    session.flush()
    return fake.id


def test_day_move_is_zero_for_a_deposit_and_buy_today(session: Session) -> None:
    """Portfolio: (11,000 - 10,000 - 1,000) = 0; % = 0 / (10,000 + 1,000) = 0."""
    _flat_book_with_deposit_and_buy_today(session)
    m = metrics_service.compute_portfolio_metrics(session, as_of=TODAY, now=AFTER_CLOSE)
    assert m.daily_growth_as_of == TODAY
    assert m.daily_growth_money_eur == D(0)
    assert m.daily_growth_money_usd == D(0)
    assert m.daily_growth_pct == D(0)
    assert m.daily_growth_pct_usd == D(0)


def test_last_session_split_removes_the_flow_from_the_price_part(session: Session) -> None:
    _flat_book_with_deposit_and_buy_today(session)
    split = metrics_service.last_session_split(session, now=AFTER_CLOSE, fx_now=FX)
    assert split is not None
    assert split.session_date == TODAY
    assert split.move_eur == D(0)
    assert split.move_usd == D(0)
    assert split.pct_eur == D(0)


def test_bought_holding_shows_no_day_gain(session: Session) -> None:
    """Holding row: 110 sh x (100 - 100) = 0 (today's share count at both marks)."""
    fake = _flat_book_with_deposit_and_buy_today(session)
    positions = positions_service.compute_positions(session, as_of=TODAY)
    im = compute_instrument_metrics(session, positions, as_of=TODAY, now=AFTER_CLOSE)[fake]
    assert im.daily_move_eur == D(0)
    assert im.daily_growth_eur == D(0)


def test_tick_day_move_matches_and_ignores_the_buy(session: Session) -> None:
    fake = _flat_book_with_deposit_and_buy_today(session)
    symbols, categories = scheduler._tick_day_moves(session, TODAY, FX, now=AFTER_CLOSE)
    row = symbols[str(fake)]
    assert D(row["day_move_eur"]) == D(0)
    assert D(row["day_pct_eur"]) == D(0)
    assert D(categories[""]["day_pct_eur"]) == D(0)


DURING = datetime(2026, 11, 4, 17, 0, tzinfo=UTC)  # 12:00 ET, session open


def test_tick_eur_pct_is_fx_aware_and_matches_the_row(session: Session) -> None:
    """USD holding flat at $100 (10 sh); EUR/USD 1.10 at the previous close, 1.00 now.

    USD: 0 %. EUR: now 1,000 / 1.00 = 1,000; prev 1,000 / 1.10 = 909.09;
    move = +90.91, % = 1.10 - 1 = +10 % (never the USD % reused).
    """
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="USD Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    fake = instruments_repo.get_or_create(session, symbol="FAKE2", asset_class="etf")
    session.add(
        Transaction(
            account_id=acct.id,
            instrument_id=fake.id,
            date=date(2026, 10, 1),
            kind="buy",
            quantity=D("10"),
            price_native=D("100"),
            net_native=D("-1000"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(session, fake.id, {PREV: D("100"), TODAY: D("100")})
    fx_repo.upsert_rates(session, {date(2026, 10, 1): FX, PREV: FX, TODAY: D("1.00")})
    session.flush()
    symbols, _ = scheduler._tick_day_moves(session, TODAY, D("1.00"), now=DURING)
    row = symbols[str(fake.id)]
    assert D(row["day_pct_usd"]) == D(0)
    assert D(row["day_move_usd"]) == D("0.00")
    assert abs(D(row["day_pct_eur"]) - D("0.10")) < D("1e-20")
    assert D(row["day_move_eur"]) == D("90.91")
    positions = positions_service.compute_positions(session, as_of=TODAY)
    im = compute_instrument_metrics(session, positions, as_of=TODAY, now=DURING)[fake.id]
    assert im.daily_move_eur == D(row["day_move_eur"])
    assert im.daily_growth_eur == D(row["day_pct_eur"])
