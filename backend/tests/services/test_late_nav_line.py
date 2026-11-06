"""Graph-level checks of the late-NAV 1D line (ETF twin estimate -> official NAV).

A €1,000 stock (intraday-priced, flat) plus a 5-share EUR mutual fund (NAV 200 on
Fri 31 May, NAV 210 on Mon 3 Jun once it posts). Mon 3 Jun 2024 trades 13:30-20:00
UTC. The fund's ETF twin closed Friday at 100 and runs 100 -> 105 over Monday.

What the owner sees (the late-data plan):
* while the session runs the fund follows its twin, and the graph says so;
* when the official NAV lands the line starts at the previous close and ends
  exactly at the official close (no end-of-day jump);
* no point is drawn after the 16:00 close, even before the next open.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.readmodels.queries.overview_query import build_intraday_value_series
from investment_dashboard.repositories import (
    accounts_repo,
    instrument_overrides_repo,
    instruments_repo,
    intraday_repo,
    prices_repo,
    snapshots_repo,
    twin_prices_repo,
)
from investment_dashboard.services import (
    intraday_snapshots_service as iss,
)
from investment_dashboard.services import (
    prices_service,
    snapshots_service,
)

D = Decimal
FRI, MON = date(2024, 5, 31), date(2024, 6, 3)
OPEN = datetime(2024, 6, 3, 13, 30)  # naive UTC, like the stored samples
CLOSE = datetime(2024, 6, 3, 20, 0)
MID = datetime(2024, 6, 3, 17, 0)
DURING = datetime(2024, 6, 3, 17, 30, tzinfo=UTC)  # market open
AFTER = datetime(2024, 6, 3, 22, 0, tzinfo=UTC)  # shut, NAV may have landed
NEXT_PRE_OPEN = datetime(2024, 6, 4, 12, 0, tzinfo=UTC)  # 08:00 ET Tuesday

#: Twin: Friday close 100, then 100 -> 105 across Monday.
TWIN_ROWS = {
    datetime(2024, 5, 31, 20, 0): D("100"),
    OPEN: D("100"),
    datetime(2024, 6, 3, 15, 0): D("101"),
    MID: D("102"),
    datetime(2024, 6, 3, 19, 0): D("104"),
    CLOSE: D("105"),
}


def _seed(session: Session, *, twin: str | None, official_nav: Decimal | None) -> None:
    account = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="EUR Brokerage",
        native_currency="EUR",
        account_type="brokerage",
    )
    stock = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    fund = instruments_repo.get_or_create(
        session, symbol="EURFUND", asset_class="mutual_fund", native_currency="EUR"
    )
    session.add_all(
        [
            Transaction(
                account_id=account.id,
                instrument_id=stock.id,
                date=FRI,
                kind="buy",
                quantity=D("10"),
                price_native=D("100"),
                net_native=D("-1000"),
                net_eur=D("-1000"),
                source="manual",
            ),
            Transaction(
                account_id=account.id,
                instrument_id=fund.id,
                date=FRI,
                kind="buy",
                quantity=D("5"),
                price_native=D("200"),
                net_native=D("-1000"),
                net_eur=D("-1000"),
                source="manual",
            ),
        ]
    )
    prices_repo.upsert_closes(session, stock.id, {FRI: D("100"), MON: D("100")})
    fund_closes = {FRI: D("200")}
    if official_nav is not None:
        fund_closes[MON] = official_nav
    prices_repo.upsert_closes(session, fund.id, fund_closes)
    if twin:
        instrument_overrides_repo.upsert(session, fund.id, intraday_twin=twin)
        twin_prices_repo.upsert_prices(session, twin, TWIN_ROWS)
    # The stock is flat all session: the stored samples carry only its component.
    for at in (OPEN, datetime(2024, 6, 3, 15, 0), MID, datetime(2024, 6, 3, 19, 0), CLOSE):
        intraday_repo.insert_sample(session, at, D("1000"))
    session.flush()


def _line(session: Session, now: datetime) -> dict[datetime, Decimal]:
    points = build_intraday_value_series(session, currency="EUR", now=now)
    return {p.date.replace(tzinfo=None): p.value for p in points}  # type: ignore[attr-defined]


def test_session_runs_fund_follows_its_twin_and_is_flagged(session: Session) -> None:
    _seed(session, twin="TWN", official_nav=None)
    line = _line(session, DURING)
    # Fund = 1,000 x twin / 100 on top of the €1,000 stock.
    assert line[OPEN] == D("2000")
    assert line[datetime(2024, 6, 3, 15, 0)] == D("2010")
    assert line[MID] == D("2020")
    assert iss.estimated_funds(session, now=DURING) == ("EURFUND",)


def test_without_a_twin_the_fund_stays_flat_and_nothing_is_flagged(session: Session) -> None:
    _seed(session, twin=None, official_nav=None)
    line = _line(session, DURING)
    assert line[OPEN] == line[MID] == D("2000")
    assert iss.estimated_funds(session, now=DURING) == ()


def test_late_nav_starts_at_previous_close_and_ends_at_the_official_close(
    session: Session,
) -> None:
    _seed(session, twin="TWN", official_nav=D("210"))
    line = _line(session, AFTER)
    assert line[OPEN] == D("2000")  # 1,000 stock + 5 x 200 (previous close)
    assert line[CLOSE] == D("2050")  # 1,000 stock + 5 x 210 (official)
    # A smooth, spike-free path: never leaves the corridor between the two ends.
    assert all(D("2000") <= v <= D("2050") for v in line.values())
    # Official NAV in: nothing is estimated any more.
    assert iss.estimated_funds(session, now=AFTER) == ()


def test_no_point_after_the_close_even_before_the_next_open(session: Session) -> None:
    _seed(session, twin="TWN", official_nav=D("210"))
    for now in (AFTER, NEXT_PRE_OPEN):
        line = _line(session, now)
        assert max(line) <= CLOSE
        assert line[max(line)] == D("2050")


def _stored(session: Session) -> Decimal | None:
    row = snapshots_repo.get_snapshot(session, MON)
    return row.total_value_eur if row is not None else None


def test_late_nav_rebuilds_the_stored_daily_point_while_the_market_is_shut(
    session: Session,
) -> None:
    _seed(session, twin="TWN", official_nav=None)
    snapshots_service.warm_range(session, MON, MON, force=True)
    session.flush()
    assert _stored(session) == D("2000")  # fund still at Friday's NAV

    fund = instruments_repo.get_or_create(session, symbol="EURFUND", native_currency="EUR")
    prices_repo.upsert_closes(session, fund.id, {MON: D("210")})
    session.flush()

    assert prices_service.rebuild_settled_snapshots(session, MON, today=MON, now=AFTER) == 1
    session.flush()
    assert _stored(session) == D("2050")


def test_no_rebuild_while_the_session_runs(session: Session) -> None:
    _seed(session, twin="TWN", official_nav=None)
    snapshots_service.warm_range(session, MON, MON, force=True)
    session.flush()
    assert prices_service.rebuild_settled_snapshots(session, MON, today=MON, now=DURING) == 0
    assert _stored(session) == D("2000")
