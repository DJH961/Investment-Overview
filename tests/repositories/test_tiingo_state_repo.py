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


def test_hour_bucket_resets_on_the_clock_hour_not_a_rolling_window(session: Session) -> None:
    # Spend at 22:30, then load at 23:05: only 35 minutes elapsed, but the wall
    # clock crossed into a new hour (:00), so Tiingo's hourly quota — and ours —
    # has reset. The old rolling 60-minute window would have wrongly kept it.
    at_22_30 = datetime(2026, 6, 23, 22, 30, 0)
    state = repo.load(session, at_22_30)
    repo.record_spend(state, 5)
    repo.save(session, state)

    later = repo.load(session, datetime(2026, 6, 23, 23, 5, 0))
    assert later.hour_used == 0


def test_hour_bucket_survives_within_the_same_clock_hour(session: Session) -> None:
    at_22_05 = datetime(2026, 6, 23, 22, 5, 0)
    state = repo.load(session, at_22_05)
    repo.record_spend(state, 4)
    repo.save(session, state)

    same_hour = repo.load(session, datetime(2026, 6, 23, 22, 59, 0))
    assert same_hour.hour_used == 4


def test_configurable_caps_round_trip_and_bind_to_budget(session: Session) -> None:
    repo.save_caps(session, hourly_cap=3, daily_cap=20)
    assert repo.load_caps(session) == (3, 20)

    state = repo.load(session, _NOW)
    assert state.hourly_cap == 3
    assert state.daily_cap == 20
    assert state.budget().hourly_cap == 3
    assert state.budget().daily_cap == 20
    # Caps are honoured by remaining(): three calls exhaust the hour.
    repo.record_spend(state, 3)
    assert state.budget().has_room() is False


def test_invalid_stored_caps_fall_back_to_defaults(session: Session) -> None:
    from investment_dashboard.repositories import app_config_repo

    app_config_repo.set_value(session, repo.HOURLY_CAP_KEY, "0")
    app_config_repo.set_value(session, repo.DAILY_CAP_KEY, "not-a-number")
    hourly, daily = repo.load_caps(session)
    assert (hourly, daily) == (repo.DESKTOP_HOURLY_CAP, repo.DESKTOP_DAILY_CAP)


def test_save_caps_rejects_non_positive(session: Session) -> None:
    import pytest

    with pytest.raises(ValueError, match="positive"):
        repo.save_caps(session, hourly_cap=0, daily_cap=10)


def test_mark_rate_limited_pins_hour_to_cap(session: Session) -> None:
    state = repo.load(session, _NOW)
    repo.record_spend(state, 1)
    repo.save(session, state)

    repo.mark_rate_limited(session, _NOW)
    after = repo.load(session, _NOW)
    assert after.hour_used == after.hourly_cap
    assert after.budget().has_room() is False
    assert after.rate_limited_at == _NOW


def test_rate_limit_flag_clears_on_the_next_hour(session: Session) -> None:
    repo.mark_rate_limited(session, _NOW)
    # Next clock hour: quota frees up, so the 429 flag is forgiven too.
    next_hour = repo.load(session, _NOW + timedelta(hours=1))
    assert next_hour.hour_used == 0
    assert next_hour.rate_limited_at is None
