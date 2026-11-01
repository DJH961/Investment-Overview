"""Regression tests for as-of (historical) portfolio valuation.

Locks the v2.8 item-1 fix: historical valuations (YTD start, MTD start, the
equity curve) must price holdings with the close that was in effect on the
``as_of`` date, not today's latest close. Pricing the past with today's price
inflated the YTD start value and flipped a genuinely-positive YTD into a
reported loss.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    instruments_repo,
    prices_repo,
)
from investment_dashboard.services import metrics_service, positions_service


def _seed_eur_brokerage(session: Session) -> int:
    a = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="EUR Brokerage",
        native_currency="EUR",
        account_type="brokerage",
    )
    return a.id


def _seed_holding(session: Session) -> None:
    """10 shares bought last year; prices rise across the current year."""
    acct_id = _seed_eur_brokerage(session)
    instr = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    session.add(
        Transaction(
            account_id=acct_id,
            instrument_id=instr.id,
            date=date(2024, 12, 15),
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("100.00"),
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(
        session,
        instr.id,
        {
            date(2025, 1, 1): Decimal("100.00"),  # start of year
            date(2025, 6, 1): Decimal("130.00"),  # mid-year (up 30%)
            date(2099, 1, 2): Decimal("999.00"),  # "today" — must NOT leak into history
        },
    )
    session.flush()


def test_historical_value_uses_historical_price(session: Session) -> None:
    _seed_holding(session)
    # Jan-1 valuation uses the Jan-1 close (100), not the far-future 999.
    assert positions_service.total_portfolio_value(session, as_of=date(2025, 1, 1)) == Decimal(
        "1000.00"
    )
    # Mid-year valuation uses the mid-year close (130).
    assert positions_service.total_portfolio_value(session, as_of=date(2025, 6, 1)) == Decimal(
        "1300.00"
    )


def test_ytd_growth_positive_when_prices_rose(session: Session) -> None:
    _seed_holding(session)
    metrics = metrics_service.compute_portfolio_metrics(session, as_of=date(2025, 6, 1))
    # Start-of-year 1000 → 1300 with no 2025 contributions ⇒ +30% YTD.
    assert metrics.ytd_growth_pct is not None
    assert metrics.ytd_growth_pct > 0
    assert abs(metrics.ytd_growth_pct - Decimal("0.30")) < Decimal("0.001")


def _seed_two_priced_days(session: Session) -> None:
    """A single EUR holding priced on two consecutive business days."""
    acct_id = _seed_eur_brokerage(session)
    instr = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    session.add(
        Transaction(
            account_id=acct_id,
            instrument_id=instr.id,
            date=date(2024, 12, 15),
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("100.00"),
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(
        session,
        instr.id,
        {date(2025, 5, 29): Decimal("100.00"), date(2025, 5, 30): Decimal("110.00")},
    )
    session.flush()


def test_daily_growth_uses_last_two_priced_days(session: Session) -> None:
    _seed_two_priced_days(session)
    # as_of is a weekend (Sun 2025-06-01); last priced day is Fri 2025-05-30.
    metrics = metrics_service.compute_portfolio_metrics(session, as_of=date(2025, 6, 1))
    assert metrics.daily_growth_as_of == date(2025, 5, 30)
    assert metrics.daily_growth_pct is not None
    # 1000 -> 1100 ⇒ +10%.
    assert abs(metrics.daily_growth_pct - Decimal("0.10")) < Decimal("0.001")


def test_daily_growth_none_with_single_priced_day(session: Session) -> None:
    acct_id = _seed_eur_brokerage(session)
    instr = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    session.add(
        Transaction(
            account_id=acct_id,
            instrument_id=instr.id,
            date=date(2024, 12, 15),
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("100.00"),
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(session, instr.id, {date(2025, 5, 30): Decimal("110.00")})
    session.flush()
    metrics = metrics_service.compute_portfolio_metrics(session, as_of=date(2025, 6, 1))
    assert metrics.daily_growth_pct is None
    assert metrics.daily_growth_as_of is None


def _seed_split_holding(session: Session) -> int:
    """10 shares bought pre-split; a 2:1 split later doubles the share count.

    yfinance back-adjusts every cached close for the split, so the pre-split
    date's stored close is the *adjusted* (halved) price.
    """
    acct_id = _seed_eur_brokerage(session)
    instr = instruments_repo.get_or_create(session, symbol="SPLT", native_currency="EUR")
    session.add(
        Transaction(
            account_id=acct_id,
            instrument_id=instr.id,
            date=date(2024, 12, 15),
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("200.00"),
            net_native=Decimal("-2000.00"),
            net_eur=Decimal("-2000.00"),
            source="manual",
        )
    )
    # 2:1 split on 2025-06-01 adds 10 shares (10 → 20).
    session.add(
        Transaction(
            account_id=acct_id,
            instrument_id=instr.id,
            date=date(2025, 6, 1),
            kind="split",
            quantity=Decimal("10"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(
        session,
        instr.id,
        {
            # Pre-split close, already back-adjusted by yfinance (200 → 100).
            date(2025, 1, 1): Decimal("100.00"),
            # Post-split close (no further adjustment).
            date(2025, 7, 1): Decimal("110.00"),
        },
    )
    session.flush()
    return instr.id


def test_pre_split_date_uses_split_adjusted_share_count(session: Session) -> None:
    _seed_split_holding(session)
    # Pre-split: 10 real shares × 200 real price = 2000. The cached close is the
    # back-adjusted 100, so without scaling the share count the holding would be
    # understated by the 2:1 ratio (1000). The fix scales 10 → 20.
    assert positions_service.total_portfolio_value(session, as_of=date(2025, 1, 1)) == Decimal(
        "2000.00"
    )


def test_post_split_date_unscaled(session: Session) -> None:
    _seed_split_holding(session)
    # After the split there is no later split: 20 shares × 110 = 2200, no scaling.
    assert positions_service.total_portfolio_value(session, as_of=date(2025, 7, 1)) == Decimal(
        "2200.00"
    )


def _seed_sold_before_split(session: Session) -> int:
    """Buy 10 shares, then sell all 10 — before the instrument later splits 2:1.

    Because the holding was closed before the split, the broker export carries
    no ``split`` row, yet yfinance back-adjusts the whole price history for it,
    so the pre-sale close is the *adjusted* (halved) price. The feed-sourced
    split cache must still scale the historical share count.
    """
    acct_id = _seed_eur_brokerage(session)
    instr = instruments_repo.get_or_create(session, symbol="SOLD", native_currency="EUR")
    session.add(
        Transaction(
            account_id=acct_id,
            instrument_id=instr.id,
            date=date(2024, 1, 10),
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("200.00"),
            net_native=Decimal("-2000.00"),
            net_eur=Decimal("-2000.00"),
            source="manual",
        )
    )
    session.add(
        Transaction(
            account_id=acct_id,
            instrument_id=instr.id,
            date=date(2024, 6, 1),
            kind="sell",
            quantity=Decimal("-10"),
            price_native=Decimal("220.00"),
            net_native=Decimal("2200.00"),
            net_eur=Decimal("2200.00"),
            source="manual",
        )
    )
    # yfinance close on the held date is back-adjusted by the post-sale 2:1
    # split (real 200 → adjusted 100).
    prices_repo.upsert_closes(session, instr.id, {date(2024, 2, 1): Decimal("100.00")})
    session.flush()
    return instr.id


def test_sold_before_split_uses_feed_split_history(session: Session) -> None:
    instr_id = _seed_sold_before_split(session)
    # Without split data the holding values at 10 × 100 = 1000 (understated).
    assert positions_service.total_portfolio_value(session, as_of=date(2024, 2, 1)) == Decimal(
        "1000.00"
    )
    # Cache the post-sale 2:1 split from the feed; the held date now values at
    # 10 × 2 × 100 = 2000 (matching the real 10 × 200).
    from investment_dashboard.repositories import splits_repo

    splits_repo.upsert_splits(session, instr_id, {date(2024, 8, 1): Decimal("2")})
    session.flush()
    assert positions_service.total_portfolio_value(session, as_of=date(2024, 2, 1)) == Decimal(
        "2000.00"
    )


def test_feed_split_overrides_ledger_for_held_instrument(session: Session) -> None:
    """A held-through split is corrected by feed data even before its ledger
    ``split`` row exists, and the two never double-apply."""
    instr_id = _seed_split_holding(session)  # has a ledger 2:1 split row
    from investment_dashboard.repositories import splits_repo

    # Feed reports the same 2:1 split; the pre-split date must stay 2000, not
    # double-count to 4000.
    splits_repo.upsert_splits(session, instr_id, {date(2025, 6, 1): Decimal("2")})
    session.flush()
    assert positions_service.total_portfolio_value(session, as_of=date(2025, 1, 1)) == Decimal(
        "2000.00"
    )
    # Post-split date: no split after it ⇒ factor 1 ⇒ 20 × 110 = 2200.
    assert positions_service.total_portfolio_value(session, as_of=date(2025, 7, 1)) == Decimal(
        "2200.00"
    )


def test_outdated_book_reads_zero_today_on_global_session_baseline(session: Session) -> None:
    """One global market-close baseline ⇒ a stale book contributes 0% today.

    The only price print predates *both* the last completed session and the one
    before it, so the global baseline forward-fills the same stale mark into both
    valuations: the daily move collapses to exactly zero (no resurrected old-print
    move), yet the daily-growth dates are still the *market* sessions — proving the
    baseline is session-keyed, not keyed off the freshest print in the book.
    """
    acct_id = _seed_eur_brokerage(session)
    instr = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    session.add(
        Transaction(
            account_id=acct_id,
            instrument_id=instr.id,
            date=date(2024, 12, 15),
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("100.00"),
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    # A single, months-old print — nothing on or near the valuation sessions.
    prices_repo.upsert_closes(session, instr.id, {date(2025, 1, 2): Decimal("120.00")})
    session.flush()

    metrics = metrics_service.compute_portfolio_metrics(session, as_of=date(2025, 6, 2))
    # Stale price flows into both the prior and current mark ⇒ no move at all.
    assert metrics.daily_growth_pct == Decimal("0")
    assert metrics.daily_growth_money_eur == Decimal("0")
    # ...but the move is dated to the market sessions, not the 2025-01-02 print.
    assert metrics.daily_growth_as_of == date(2025, 6, 2)  # Monday session
    assert metrics.daily_growth_prev_as_of == date(2025, 5, 30)  # prior Friday session


def test_daily_growth_baseline_matches_the_one_day_chart_anchor(session: Session) -> None:
    """The headline daily-growth baseline and the 1 Day chart anchor share a calendar.

    The chart's dashed "prev close" line is keyed off
    :func:`intraday_snapshots_service.previous_trading_session` of the live
    session; the headline today's-move must use the *same* prior session, so the
    two never disagree about which close they measure against.
    """
    from datetime import UTC, datetime

    from investment_dashboard.services import intraday_snapshots_service

    acct_id = _seed_eur_brokerage(session)
    instr = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    session.add(
        Transaction(
            account_id=acct_id,
            instrument_id=instr.id,
            date=date(2024, 12, 15),
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("100.00"),
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(
        session,
        instr.id,
        {date(2025, 5, 30): Decimal("120.00"), date(2025, 6, 2): Decimal("130.00")},
    )
    session.flush()

    as_of = date(2025, 6, 2)
    now = datetime(2025, 6, 2, 20, 0, tzinfo=UTC)  # after the US close
    metrics = metrics_service.compute_portfolio_metrics(session, as_of=as_of)
    chart_live_session = intraday_snapshots_service.last_session_date(now)
    chart_prev_session = intraday_snapshots_service.previous_trading_session(chart_live_session)
    # Same prior session backs both the headline baseline and the chart anchor.
    assert metrics.daily_growth_as_of == chart_live_session
    assert metrics.daily_growth_prev_as_of == chart_prev_session
