"""Persistence for the desktop Tiingo fallback's budget, canary and stale state.

The :mod:`tiingo_fallback` decision core is pure: it needs the *current* budget
counters, the last canary stamp, learned publish habit and per-symbol stale-since
timestamps fed in. This repo stores all of that as a single JSON blob in the
``app_config`` key/value table and applies the time-window resets (clock-hour and
Eastern-day) on load — so counters self-heal without a scheduled job and every
gate sees fresh numbers the instant the app reopens.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, time

from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo
from investment_dashboard.services.tiingo_fallback import (
    DESKTOP_DAILY_CAP,
    DESKTOP_HOURLY_CAP,
    Budget,
    eastern_day,
    is_new_budget_day,
)

#: app_config key holding the desktop fallback's JSON state blob.
STATE_KEY = "tiingo_desktop_state"

#: app_config keys holding the user-configurable per-side Tiingo caps. Stored
#: separately from the (self-resetting) counter blob so a counter reset never
#: clobbers the configured limits.
HOURLY_CAP_KEY = "tiingo_hourly_cap"
DAILY_CAP_KEY = "tiingo_daily_cap"

#: Most recent per-fund NAV-publish samples to retain when learning the habit.
_MAX_HABIT_SAMPLES = 10


def _floor_to_hour(dt: datetime) -> datetime:
    """The top-of-hour (:00) instant for ``dt`` — the hourly budget bucket key.

    Tiingo's hourly allowance resets on the wall-clock hour (``:00``), not on a
    rolling 60-minute window since the first call. Flooring both the stored stamp
    and ``now`` to the hour means the bucket clears the instant the clock ticks
    over to a new hour, matching the provider's real reset.
    """
    return dt.replace(minute=0, second=0, microsecond=0)


def load_caps(session: Session) -> tuple[int, int]:
    """Return the configured ``(hourly_cap, daily_cap)``, falling back to defaults.

    A non-positive or unparseable stored value falls back to the built-in default
    so a corrupt config can never silently disable (cap 0) or invert the budget.
    """

    def _read(key: str, default: int) -> int:
        raw = app_config_repo.get(session, key)
        if raw is None:
            return default
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return default
        return value if value > 0 else default

    return _read(HOURLY_CAP_KEY, DESKTOP_HOURLY_CAP), _read(DAILY_CAP_KEY, DESKTOP_DAILY_CAP)


def save_caps(session: Session, *, hourly_cap: int, daily_cap: int) -> None:
    """Persist the user-configured per-side Tiingo caps (both must be positive)."""
    if hourly_cap <= 0 or daily_cap <= 0:
        raise ValueError("Tiingo caps must be positive integers")
    app_config_repo.set_value(session, HOURLY_CAP_KEY, str(int(hourly_cap)))
    app_config_repo.set_value(session, DAILY_CAP_KEY, str(int(daily_cap)))


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt is not None else None


def _parse_dt(raw: object) -> datetime | None:
    return datetime.fromisoformat(raw) if isinstance(raw, str) else None


def _parse_time(raw: object) -> time | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return time.fromisoformat(raw)
    except ValueError:
        return None


@dataclass
class TiingoDesktopState:
    """Mutable snapshot of the desktop fallback's persisted counters/stamps."""

    hour_stamp: datetime | None = None
    hour_used: int = 0
    day_stamp: datetime | None = None
    day_used: int = 0
    last_canary_at: datetime | None = None
    canary_count_today: int = 0
    earliest_habit: time | None = None
    peer_nav_seen_at: datetime | None = None
    stale_since: dict[str, datetime] = field(default_factory=dict)
    #: When the provider last returned HTTP 429 (rate-limited) this hour, if at
    #: all. Set by :func:`mark_rate_limited` and surfaced in Settings; cleared at
    #: the next hourly reset (the quota frees up then). Not charged itself — the
    #: 429 handler also pins ``hour_used`` to the cap so no further call is made.
    rate_limited_at: datetime | None = None
    #: The user-configurable per-side caps. Loaded from app_config by :func:`load`
    #: (defaulting to the built-in constants) so the live budget always honours the
    #: limits the user set in Settings. Not persisted inside the counter blob.
    hourly_cap: int = DESKTOP_HOURLY_CAP
    daily_cap: int = DESKTOP_DAILY_CAP
    #: Per-fund observed NAV-publish times (Eastern), accumulated *across days*
    #: as a learned habit — capped to the most recent samples per fund. Drives
    #: the smart canary pick (earliest + most consistent publisher). Unlike the
    #: per-day ``earliest_habit`` floor, this is **not** reset at ET midnight.
    publish_habits: dict[str, list[time]] = field(default_factory=dict)

    def budget(self) -> Budget:
        return Budget(
            hour_used=self.hour_used,
            day_used=self.day_used,
            hourly_cap=self.hourly_cap,
            daily_cap=self.daily_cap,
        )

    def normalize(self, now_utc: datetime) -> None:
        """Reset the hour/day buckets in place when their window has rolled over.

        Called on load so the gates never see a stale counter: the hourly bucket
        clears the instant the wall-clock hour ticks over (Tiingo's quota resets
        on the full hour, ``:00`` — not on a rolling 60-minute window), and the
        daily bucket (plus the canary count and learned habit) clears at Eastern
        midnight. A spent rate-limit flag is forgiven at the hourly reset too.
        """
        if self.hour_stamp is None or _floor_to_hour(now_utc) > _floor_to_hour(self.hour_stamp):
            self.hour_stamp = now_utc
            self.hour_used = 0
            self.rate_limited_at = None
        if is_new_budget_day(self.day_stamp, now_utc):
            self.day_stamp = now_utc
            self.day_used = 0
            self.canary_count_today = 0
            self.last_canary_at = None
            self.earliest_habit = None
            self.peer_nav_seen_at = None

    def to_json(self) -> str:
        return json.dumps(
            {
                "hour_stamp": _iso(self.hour_stamp),
                "hour_used": self.hour_used,
                "day_stamp": _iso(self.day_stamp),
                "day_used": self.day_used,
                "last_canary_at": _iso(self.last_canary_at),
                "canary_count_today": self.canary_count_today,
                "earliest_habit": self.earliest_habit.strftime("%H:%M")
                if self.earliest_habit
                else None,
                "peer_nav_seen_at": _iso(self.peer_nav_seen_at),
                "rate_limited_at": _iso(self.rate_limited_at),
                "stale_since": {sym: dt.isoformat() for sym, dt in self.stale_since.items()},
                "publish_habits": {
                    sym: [t.strftime("%H:%M") for t in times]
                    for sym, times in self.publish_habits.items()
                },
            }
        )

    @classmethod
    def from_json(cls, raw: str | None) -> TiingoDesktopState:
        if not raw:
            return cls()
        data = json.loads(raw)
        habit_raw = data.get("earliest_habit")
        stale_raw = data.get("stale_since") or {}
        habits_raw = data.get("publish_habits") or {}
        return cls(
            hour_stamp=_parse_dt(data.get("hour_stamp")),
            hour_used=int(data.get("hour_used", 0)),
            day_stamp=_parse_dt(data.get("day_stamp")),
            day_used=int(data.get("day_used", 0)),
            last_canary_at=_parse_dt(data.get("last_canary_at")),
            canary_count_today=int(data.get("canary_count_today", 0)),
            earliest_habit=time.fromisoformat(habit_raw) if habit_raw else None,
            peer_nav_seen_at=_parse_dt(data.get("peer_nav_seen_at")),
            rate_limited_at=_parse_dt(data.get("rate_limited_at")),
            stale_since={
                sym: dt
                for sym, raw_dt in stale_raw.items()
                if (dt := _parse_dt(raw_dt)) is not None
            },
            publish_habits={
                sym: parsed
                for sym, raw_times in habits_raw.items()
                if isinstance(raw_times, list)
                and (parsed := [t for raw_t in raw_times if (t := _parse_time(raw_t)) is not None])
            },
        )


def load(session: Session, now_utc: datetime) -> TiingoDesktopState:
    """Load the persisted state and apply hour/day resets for ``now_utc``.

    The user-configurable per-side caps are read from app_config and bound onto
    the state so every budget check honours the limits set in Settings.
    """
    state = TiingoDesktopState.from_json(app_config_repo.get(session, STATE_KEY))
    state.hourly_cap, state.daily_cap = load_caps(session)
    state.normalize(now_utc)
    return state


def save(session: Session, state: TiingoDesktopState) -> None:
    """Persist ``state`` back to ``app_config``."""
    app_config_repo.set_value(session, STATE_KEY, state.to_json())


def record_spend(state: TiingoDesktopState, count: int) -> None:
    """Charge ``count`` Tiingo calls against both budget buckets."""
    state.hour_used += count
    state.day_used += count


def record_canary(state: TiingoDesktopState, now_utc: datetime) -> None:
    """Record a canary probe: stamp it, bump the daily count, charge one call."""
    state.last_canary_at = now_utc
    state.canary_count_today += 1
    record_spend(state, 1)


def exhaust_hour(state: TiingoDesktopState, now_utc: datetime) -> None:
    """Pin the hourly bucket to its cap — the quota is spent until the next ``:00``.

    Used when the provider reports HTTP 429 (rate-limited): no matter *why* or how
    many calls we personally counted, the account's hourly allowance is gone, so
    we treat it as fully used and stop until the wall-clock hour rolls over. Also
    stamps ``rate_limited_at`` so Settings can explain *why* the budget is maxed.
    """
    state.hour_used = max(state.hour_used, state.hourly_cap)
    state.rate_limited_at = now_utc


def mark_rate_limited(session: Session, now_utc: datetime) -> None:
    """Load, exhaust the hourly bucket (429 handler), and persist — best-effort.

    A standalone convenience for the price/FX 429 catch sites: it self-heals the
    next hour via :func:`normalize`, so a single persisted "hour is spent" stamp
    is all that's needed to stop hammering a rate-limited account.
    """
    state = load(session, now_utc)
    exhaust_hour(state, now_utc)
    save(session, state)


def note_publish_habit(state: TiingoDesktopState, observed_et: time) -> None:
    """Remember the earliest Eastern NAV-publish time seen today (learned habit)."""
    if state.earliest_habit is None or observed_et < state.earliest_habit:
        state.earliest_habit = observed_et


def note_publish_habit_for(state: TiingoDesktopState, symbol: str, observed_et: time) -> None:
    """Record a confirmed NAV-publish time for ``symbol`` (per-fund habit).

    Updates both the per-day ``earliest_habit`` floor and the cross-day per-fund
    publish history (capped to the most recent :data:`_MAX_HABIT_SAMPLES`), which
    drives the smart canary pick.
    """
    note_publish_habit(state, observed_et)
    samples = state.publish_habits.setdefault(symbol, [])
    samples.append(observed_et)
    if len(samples) > _MAX_HABIT_SAMPLES:
        del samples[: len(samples) - _MAX_HABIT_SAMPLES]


def note_peer_nav(state: TiingoDesktopState, now_utc: datetime) -> datetime:
    """Stamp the first time today a peer NAV was observed; return that stamp.

    Idempotent within a day: later observations keep the original stamp so the
    peer-trickle grace measures from when the *first* peer NAV landed.
    """
    if state.peer_nav_seen_at is None:
        state.peer_nav_seen_at = now_utc
    return state.peer_nav_seen_at


def mark_stale(state: TiingoDesktopState, symbol: str, now_utc: datetime) -> None:
    """Record when ``symbol`` first went stale; keep the earliest stamp."""
    state.stale_since.setdefault(symbol, now_utc)


def clear_stale(state: TiingoDesktopState, symbol: str) -> None:
    """Forget a symbol's stale-since stamp once it refreshes successfully."""
    state.stale_since.pop(symbol, None)


def eastern_day_key(now_utc: datetime) -> str:
    """The Eastern calendar-day string used for day-bucket comparisons."""
    return eastern_day(now_utc).isoformat()
