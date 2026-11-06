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

from datetime import UTC, date, datetime, timedelta
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


# --- 1W: every session of the week draws its funds from the twin ----------------------

THU, FRI_ = date(2024, 5, 30), date(2024, 5, 31)
FRI_OPEN, FRI_MID, FRI_CLOSE = (
    datetime(2024, 5, 31, 13, 30),
    datetime(2024, 5, 31, 17, 0),
    datetime(2024, 5, 31, 20, 0),
)
WEEK_TWIN_ROWS = {
    datetime(2024, 5, 30, 20, 0): D("100"),  # Thursday close
    FRI_OPEN: D("100"),
    FRI_MID: D("102"),
    FRI_CLOSE: D("105"),  # Friday +5 %
    OPEN: D("105"),
    MID: D("107"),
    CLOSE: D("110.25"),  # Monday +5 %
}


def _seed_week(session: Session, *, twin: str | None) -> None:
    """Fund NAV 190 (Thu) -> 200 (Fri) -> 210 (Mon), all official; stock flat at 1,000."""
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
    for inst, qty, price in ((stock, D("10"), D("100")), (fund, D("5"), D("190"))):
        session.add(
            Transaction(
                account_id=account.id,
                instrument_id=inst.id,
                date=date(2024, 5, 28),
                kind="buy",
                quantity=qty,
                price_native=price,
                net_native=-qty * price,
                net_eur=-qty * price,
                source="manual",
            )
        )
    prices_repo.upsert_closes(
        session, stock.id, {d: D("100") for d in (date(2024, 5, 28), THU, FRI_, MON)}
    )
    prices_repo.upsert_closes(
        session,
        fund.id,
        {date(2024, 5, 28): D("190"), THU: D("190"), FRI_: D("200"), MON: D("210")},
    )
    if twin:
        instrument_overrides_repo.upsert(session, fund.id, intraday_twin=twin)
        twin_prices_repo.upsert_prices(session, twin, WEEK_TWIN_ROWS)
    for day_open, day_mid, day_close in ((FRI_OPEN, FRI_MID, FRI_CLOSE), (OPEN, MID, CLOSE)):
        for at in (day_open, day_mid, day_close):
            intraday_repo.insert_sample(session, at, D("1000"))
    session.flush()


def _week_line(session: Session) -> dict[datetime, Decimal]:
    from investment_dashboard.readmodels.queries.overview_query import build_week_value_series

    points = build_week_value_series(session, currency="EUR", now=AFTER)
    return {p.date.replace(tzinfo=None): p.value for p in points}  # type: ignore[attr-defined]


def test_week_earlier_session_follows_the_twin_from_previous_to_official_nav(
    session: Session,
) -> None:
    _seed_week(session, twin="TWN")
    line = _week_line(session)
    assert line[FRI_OPEN] == D("1950")  # 1,000 + 5 x 190 (Thursday's NAV)
    assert line[FRI_CLOSE] == D("2000")  # 1,000 + 5 x 200 (Friday's official NAV)
    assert line[OPEN] == D("2000")  # Monday starts where Friday ended: no step
    assert line[CLOSE] == D("2050")
    # Mid-Friday is the twin's shape (+2 % of a +5 % day), not a straight ramp.
    ramp = D("1950") + D("50") * D("3.5") / D("6.5")
    assert D("1950") < line[FRI_MID] < D("2000")
    assert abs(line[FRI_MID] - ramp) > D("2")


def test_week_without_a_twin_keeps_the_per_day_nav_step(session: Session) -> None:
    _seed_week(session, twin=None)
    line = _week_line(session)
    # Earlier days are unchanged (their own NAV from the first point); only the last
    # session is the late-NAV line (previous -> official NAV), as on the 1D graph.
    assert line[FRI_OPEN] == line[FRI_CLOSE] == D("2000")
    assert (line[OPEN], line[CLOSE]) == (D("2000"), D("2050"))


# --- Backfill of the earlier sessions' twin bars --------------------------------------


def test_backfill_stores_earlier_sessions_once_and_throttles_empty_answers(
    session: Session,
) -> None:
    _seed_week(session, twin=None)
    fund = instruments_repo.get_or_create(session, symbol="EURFUND", native_currency="EUR")
    instrument_overrides_repo.upsert(session, fund.id, intraday_twin="TWN")
    session.flush()
    iss._week_attempts.clear()
    calls: list[tuple[list[str], date, date]] = []

    def fetcher(symbols, start, end, *, interval):  # type: ignore[no-untyped-def]
        calls.append((list(symbols), start, end))
        # Realistic: two or more bars on every requested day, plus the week's shape.
        bars = dict(WEEK_TWIN_ROWS)
        for n in range((end - start).days + 1):
            day = start + timedelta(days=n)
            bars.setdefault(datetime(day.year, day.month, day.day, 14, 0), D("100"))
            bars.setdefault(datetime(day.year, day.month, day.day, 19, 30), D("100"))
        return {"TWN": bars}

    first = iss.backfill_week_twin_prices(session, ["TWN"], now=AFTER, range_fetcher=fetcher)
    assert first > 0
    assert len(calls) == 1
    assert calls[0][0] == ["TWN"]
    stored = twin_prices_repo.prices_in_range(session, ["TWN"], datetime(2024, 5, 29), CLOSE)
    assert FRI_MID in stored["TWN"]  # an earlier session of the week is now there
    # Stored sessions are not fetched again.
    iss._week_attempts.clear()
    assert iss.backfill_week_twin_prices(session, ["TWN"], now=AFTER, range_fetcher=fetcher) == 0
    assert len(calls) == 1


def test_backfill_retry_is_throttled_when_the_provider_returns_nothing(
    session: Session,
) -> None:
    iss._week_attempts.clear()
    calls: list[int] = []

    def empty(symbols, start, end, *, interval):  # type: ignore[no-untyped-def]
        calls.append(1)
        return {}

    assert iss.backfill_week_twin_prices(session, ["TWN"], now=AFTER, range_fetcher=empty) == 0
    assert iss.backfill_week_twin_prices(session, ["TWN"], now=AFTER, range_fetcher=empty) == 0
    assert len(calls) == 1  # the second tick, a moment later, does not ask again
