"""Tests for the desktop Tiingo state persistence repo."""

from __future__ import annotations

from datetime import datetime, time, timedelta

from sqlalchemy.orm import Session

from investment_dashboard.repositories import tiingo_state_repo as repo
from investment_dashboard.repositories.tiingo_state_repo import TiingoDesktopState

_NOW = datetime(2026, 6, 23, 22, 0, 0)  # 18:00 ET


def test_load_empty_returns_default(session: Session) -> None:
    state = repo.load(session, _NOW)
    assert state.day_used == 0
    assert state.stale_since == {}
    assert state.budget().has_room() is True


def test_round_trip_persists_all_fields(session: Session) -> None:
    state = repo.load(session, _NOW)
    repo.record_spend(state, 2)
    repo.record_canary(state, _NOW)
    repo.note_publish_habit(state, time(17, 50))
    repo.mark_stale(state, "FSKAX", _NOW)
    repo.save(session, state)

    again = repo.load(session, _NOW)
    assert again.day_used == 3  # 2 + 1 canary
    assert again.hour_used == 3
    assert again.canary_count_today == 1
    assert again.last_canary_at == _NOW
    assert again.earliest_habit == time(17, 50)
    assert again.stale_since == {"FSKAX": _NOW}


def test_hour_bucket_resets_after_an_hour(session: Session) -> None:
    state = repo.load(session, _NOW)
    repo.record_spend(state, 5)
    repo.save(session, state)

    later = repo.load(session, _NOW + timedelta(hours=1, minutes=1))
    assert later.hour_used == 0
    assert later.day_used == 5  # day bucket survives the hour roll


def test_day_bucket_and_canary_reset_at_eastern_midnight(session: Session) -> None:
    state = repo.load(session, _NOW)
    repo.record_canary(state, _NOW)
    repo.note_publish_habit(state, time(17, 45))
    repo.save(session, state)

    # 18:00 ET next day.
    next_day = repo.load(session, _NOW + timedelta(days=1))
    assert next_day.day_used == 0
    assert next_day.canary_count_today == 0
    assert next_day.last_canary_at is None
    assert next_day.earliest_habit is None


def test_mark_stale_keeps_earliest(session: Session) -> None:
    state = TiingoDesktopState()
    repo.mark_stale(state, "FSKAX", _NOW)
    repo.mark_stale(state, "FSKAX", _NOW + timedelta(hours=2))
    assert state.stale_since["FSKAX"] == _NOW


def test_clear_stale_removes_symbol(session: Session) -> None:
    state = TiingoDesktopState()
    repo.mark_stale(state, "FSKAX", _NOW)
    repo.clear_stale(state, "FSKAX")
    assert "FSKAX" not in state.stale_since


def test_note_publish_habit_keeps_earliest(session: Session) -> None:
    state = TiingoDesktopState()
    repo.note_publish_habit(state, time(18, 0))
    repo.note_publish_habit(state, time(17, 40))
    repo.note_publish_habit(state, time(18, 30))
    assert state.earliest_habit == time(17, 40)


def test_per_fund_publish_habits_persist_across_days(session: Session) -> None:
    state = repo.load(session, _NOW)
    repo.note_publish_habit_for(state, "FXAIX", time(17, 50))
    repo.note_publish_habit_for(state, "FSKAX", time(18, 10))
    repo.save(session, state)

    # Per-fund habits accumulate across days (unlike the daily earliest floor).
    next_day = repo.load(session, _NOW + timedelta(days=1))
    assert next_day.earliest_habit is None  # daily floor reset
    assert next_day.publish_habits == {
        "FXAIX": [time(17, 50)],
        "FSKAX": [time(18, 10)],
    }


def test_per_fund_publish_habits_cap_recent_samples(session: Session) -> None:
    state = TiingoDesktopState()
    for minute in range(repo._MAX_HABIT_SAMPLES + 5):
        repo.note_publish_habit_for(state, "FXAIX", time(17, minute % 60))
    assert len(state.publish_habits["FXAIX"]) == repo._MAX_HABIT_SAMPLES
