"""Golden tests for the Daily Brief's visit rule (``brief_service.heartbeat``)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.services import brief_service

T0 = datetime(2026, 11, 16, 15, 0, tzinfo=UTC)
GAP = timedelta(minutes=5)


@pytest.fixture(autouse=True)
def _db(api_db: object) -> None:
    return None


def _state() -> tuple[datetime | None, tuple[datetime, datetime] | None]:
    with ledger_session_scope() as session:
        return brief_service.get_last_seen(session), brief_service.get_visit(session)


def _beat(moment: datetime, gap: timedelta = GAP) -> bool:
    with ledger_session_scope() as session:
        return brief_service.heartbeat(session, moment, gap=gap)


def test_first_visit_ever_has_no_absence() -> None:
    assert _beat(T0) is False
    assert _state() == (T0, None)


def test_reads_inside_the_gap_are_one_visit() -> None:
    _beat(T0)
    for minutes in (1, 4, 8, 12, 16):  # each within 5 min of the one before
        assert _beat(T0 + timedelta(minutes=minutes)) is False
    assert _state() == (T0 + timedelta(minutes=16), None)


def test_a_3_minute_tab_switch_is_not_a_new_visit() -> None:
    _beat(T0)
    assert _beat(T0 + timedelta(minutes=3)) is False
    assert _state()[1] is None


def test_the_gap_or_more_starts_a_visit_with_a_frozen_window() -> None:
    _beat(T0)
    _beat(T0 + timedelta(minutes=2))
    left = T0 + timedelta(minutes=2)
    back = left + timedelta(minutes=20)
    assert _beat(back) is True
    assert _state() == (back, (left, back))
    # The visit goes on: the window stays frozen.
    _beat(back + timedelta(minutes=3))
    _beat(back + timedelta(minutes=6))
    assert _state()[1] == (left, back)
    # Exactly the gap counts as away; the next absence replaces the window.
    seen = _state()[0]
    assert seen is not None
    assert _beat(seen + GAP) is True
    assert _state()[1] == (seen, seen + GAP)


def test_the_gap_is_a_setting() -> None:
    _beat(T0, gap=timedelta(minutes=30))
    assert _beat(T0 + timedelta(minutes=20), gap=timedelta(minutes=30)) is False
    assert _beat(T0 + timedelta(minutes=50), gap=timedelta(minutes=30)) is True


def test_writes_are_throttled_to_one_a_minute() -> None:
    _beat(T0)
    _beat(T0 + timedelta(seconds=30))
    assert _state()[0] == T0  # not written
    _beat(T0 + timedelta(seconds=59))
    assert _state()[0] == T0
    _beat(T0 + timedelta(seconds=60))
    assert _state()[0] == T0 + timedelta(seconds=60)


def test_never_goes_backwards() -> None:
    _beat(T0)
    _beat(T0 - timedelta(hours=2))
    assert _state() == (T0, None)


def test_ack_counts_as_a_heartbeat_and_never_regresses() -> None:
    _beat(T0)
    with ledger_session_scope() as session:
        target = brief_service.ack(
            session, seen_at=T0 + timedelta(seconds=20), now=T0 + timedelta(seconds=20)
        )
        assert target == T0 + timedelta(seconds=20)
        assert brief_service.get_last_seen(session) == T0 + timedelta(seconds=20)
