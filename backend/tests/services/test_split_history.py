"""Tests for feed-sourced stock-split caching and the historical valuation
factor it feeds.

The market-data feed back-adjusts an instrument's whole price history for every
split, including splits that occurred *after* the user sold the holding (which
therefore never appear as a ledger ``split`` transaction). ``refresh_splits``
caches those corporate actions so historical valuations stay accurate for held
*and* sold instruments.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import patch

from sqlalchemy.orm import Session

from investment_dashboard.repositories import instruments_repo, splits_repo
from investment_dashboard.services import prices_service


def test_cumulative_factor_after_products_only_later_splits(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="ZZZ", asset_class="etf")
    splits_repo.upsert_splits(
        session,
        instr.id,
        {date(2024, 1, 1): Decimal("2"), date(2025, 1, 1): Decimal("3")},
    )
    session.flush()
    # Both splits are after 2023-06-01 ⇒ 2 × 3 = 6.
    assert splits_repo.cumulative_factor_after(session, instr.id, date(2023, 6, 1)) == Decimal("6")
    # Only the 2025 split is after 2024-06-01 ⇒ 3.
    assert splits_repo.cumulative_factor_after(session, instr.id, date(2024, 6, 1)) == Decimal("3")
    # No split after the last one ⇒ 1.
    assert splits_repo.cumulative_factor_after(session, instr.id, date(2025, 6, 1)) == Decimal("1")


def test_cumulative_factors_after_batch_matches_singular(session: Session) -> None:
    # ``a`` has later splits, ``b`` is feed-confirmed-no-later-split, ``c`` has
    # no cached split data at all (must be absent from the batch result).
    a = instruments_repo.get_or_create(session, symbol="AAA", asset_class="etf")
    b = instruments_repo.get_or_create(session, symbol="BBB", asset_class="etf")
    c = instruments_repo.get_or_create(session, symbol="CCC", asset_class="etf")
    splits_repo.upsert_splits(
        session, a.id, {date(2024, 1, 1): Decimal("2"), date(2025, 1, 1): Decimal("3")}
    )
    splits_repo.upsert_splits(session, b.id, {date(2020, 1, 1): Decimal("2")})
    session.flush()

    as_of = date(2023, 6, 1)
    batched = splits_repo.cumulative_factors_after(session, [a.id, b.id, c.id], as_of)
    # ``a``: 2 × 3 = 6; ``b``: feed-confirmed, no later split ⇒ 1; ``c``: absent.
    assert batched == {a.id: Decimal("6"), b.id: Decimal("1")}
    # Parity with the per-instrument helper for the ids that have split data.
    for instr_id in (a.id, b.id):
        assert batched[instr_id] == splits_repo.cumulative_factor_after(session, instr_id, as_of)
    assert c.id not in batched


def test_cumulative_factors_after_empty_ids(session: Session) -> None:
    assert splits_repo.cumulative_factors_after(session, [], date(2024, 1, 1)) == {}


def test_cumulative_split_factor_after_none_when_no_data(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="NONE", asset_class="etf")
    session.flush()
    # No cached split rows ⇒ None signals "fall back to ledger split rows".
    assert prices_service.cumulative_split_factor_after(session, instr.id, date(2024, 1, 1)) is None


def test_cumulative_split_factor_after_unit_when_feed_confirms_no_split(
    session: Session,
) -> None:
    instr = instruments_repo.get_or_create(session, symbol="FLAT", asset_class="etf")
    splits_repo.upsert_splits(session, instr.id, {date(2020, 1, 1): Decimal("2")})
    session.flush()
    # The feed has data for this instrument but no split after as_of ⇒ 1 (not
    # None): the data is known-complete, so don't fall back to the ledger.
    assert prices_service.cumulative_split_factor_after(
        session, instr.id, date(2024, 1, 1)
    ) == Decimal("1")


def test_cumulative_factors_after_batched_matches_per_instrument(session: Session) -> None:
    # Two instruments with cached splits, one without — the batched lookup must
    # match the per-instrument helper and *omit* the instrument with no cached
    # split data (the "fall back to ledger rows" signal).
    a = instruments_repo.get_or_create(session, symbol="AAA", asset_class="etf")
    b = instruments_repo.get_or_create(session, symbol="BBB", asset_class="etf")
    none = instruments_repo.get_or_create(session, symbol="NOSPLIT", asset_class="etf")
    splits_repo.upsert_splits(
        session, a.id, {date(2024, 1, 1): Decimal("2"), date(2025, 1, 1): Decimal("3")}
    )
    splits_repo.upsert_splits(session, b.id, {date(2020, 1, 1): Decimal("4")})
    session.flush()

    as_of = date(2024, 6, 1)
    batched = splits_repo.cumulative_factors_after(session, [a.id, b.id, none.id], as_of)
    # AAA: only the 2025 split is after 2024-06-01 ⇒ 3. BBB: no later split ⇒ 1.
    assert batched == {a.id: Decimal("3"), b.id: Decimal("1")}
    # NOSPLIT has no cached rows ⇒ absent, matching the per-call None signal.
    assert none.id not in batched
    # Service wrapper routes through the cache tier and returns the same map.
    assert (
        prices_service.cumulative_split_factors_after(session, [a.id, b.id, none.id], as_of)
        == batched
    )


def test_refresh_splits_caches_feed_corporate_actions(session: Session) -> None:
    held = instruments_repo.get_or_create(session, symbol="HELD", asset_class="etf")
    instruments_repo.get_or_create(session, symbol="SAVINGS_CASH", asset_class="cash")
    session.flush()

    captured: dict[str, object] = {}

    def fake_fetch(symbols: list[str], start: date, end: date) -> dict[str, dict[date, Decimal]]:
        captured["symbols"] = symbols
        captured["start"] = start
        return {"HELD": {date(2024, 3, 1): Decimal("2")}}

    with patch.object(prices_service, "fetch_splits", side_effect=fake_fetch):
        prices_service.refresh_splits(
            session, earliest_needed=date(2024, 1, 1), today=date(2024, 6, 10)
        )

    # Synthetic cash rows have no yfinance ticker and are excluded.
    assert "SAVINGS_CASH" not in captured["symbols"]
    assert "HELD" in captured["symbols"]
    assert captured["start"] == date(2024, 1, 1)
    assert splits_repo.get_splits_for_instrument(session, held.id) == {
        date(2024, 3, 1): Decimal("2")
    }


def test_refresh_splits_tolerates_feed_failure(session: Session) -> None:
    from investment_dashboard.adapters.yfinance_client import YFinanceError

    instruments_repo.get_or_create(session, symbol="HELD", asset_class="etf")
    session.flush()

    def boom(*_a: object, **_k: object) -> dict[str, dict[date, Decimal]]:
        raise YFinanceError("network down")

    with patch.object(prices_service, "fetch_splits", side_effect=boom):
        # Must swallow the error and leave the cache untouched.
        out = prices_service.refresh_splits(
            session, earliest_needed=date(2024, 1, 1), today=date(2024, 6, 10)
        )
    assert out == {}
