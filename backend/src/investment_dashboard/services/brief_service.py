"""The Daily Brief's visit markers (app config).

"Since last visit" is the ABSENCE: what happened while the owner did not have the app
open. The client marks a read with ``X-Visible: 1`` only while its tab is visible
(:func:`heartbeat`); every such read is a sign of life:

* ``brief.last_seen_at``: the newest visible read (written at most once a minute);
* a visible read arriving at least ``gap`` (setting ``brief_visit_gap_minutes``, a
  debounce so flicking between tabs is not a new visit) after ``last_seen_at`` starts
  a new visit: ``brief.visit_from_at`` takes the old ``last_seen_at`` (when the owner
  left) and ``brief.visit_start_at`` is that read's instant (when he came back). Both
  stay frozen for the whole visit;
* the Brief's window and its currency figures are ``(visit_from, visit_start]``:
  boundaries that pass while he is looking never brief him;
* ``brief.last_ack_at``: the card was dismissed (or auto-closed). It hides the card for
  the visit it was dismissed in: hidden while ``last_ack_at >= visit_start``.

All are ISO UTC strings. None of them moves backwards or past the server clock.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.domain import brief as brief_domain
from investment_dashboard.services import app_config_service

CONFIG_KEY = "brief.last_ack_at"
SEEN_KEY = "brief.last_seen_at"
FROM_KEY = "brief.visit_from_at"
START_KEY = "brief.visit_start_at"
#: Default for the ``brief_visit_gap_minutes`` setting.
DEFAULT_GAP = timedelta(minutes=5)
#: Visible reads inside a visit are written at most this often.
THROTTLE = timedelta(minutes=1)


def _utc(moment: datetime) -> datetime:
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def _read(session: Session, key: str) -> datetime | None:
    raw = app_config_service.get(session, key)
    if not raw:
        return None
    try:
        return _utc(datetime.fromisoformat(raw))
    except ValueError:
        return None


def get_last_ack(session: Session) -> datetime | None:
    """The dismissal marker (aware UTC), or ``None`` when never dismissed."""
    return _read(session, CONFIG_KEY)


def get_last_seen(session: Session) -> datetime | None:
    """The newest visible read, or ``None`` before the first visit."""
    return _read(session, SEEN_KEY)


def get_visit(session: Session) -> tuple[datetime, datetime] | None:
    """``(visit_from, visit_start)`` of the current visit, or ``None`` (first visit)."""
    start = _read(session, FROM_KEY), _read(session, START_KEY)
    return (start[0], start[1]) if start[0] is not None and start[1] is not None else None


def _store(session: Session, key: str, moment: datetime) -> None:
    app_config_service.set_value(session, key, _utc(moment).isoformat())


def heartbeat(session: Session, now: datetime, *, gap: timedelta = DEFAULT_GAP) -> bool:
    """Record a visible read at ``now``; ``True`` when it started a new visit.

    First read ever: only ``last_seen_at`` is set (no absence, no Brief). A read at
    least ``gap`` after the newest one freezes ``visit_from`` = that newest read and
    ``visit_start`` = ``now``. Other writes are throttled to :data:`THROTTLE`.
    """
    now = _utc(now)
    last = get_last_seen(session)
    if last is None:
        _store(session, SEEN_KEY, now)
        return False
    if now <= last:
        return False
    elapsed = now - last
    if elapsed >= gap:
        _store(session, FROM_KEY, last)
        _store(session, START_KEY, now)
        _store(session, SEEN_KEY, now)
        activity("changes").info("new visit, away since %s", last.isoformat())
        return True
    if elapsed >= THROTTLE:
        _store(session, SEEN_KEY, now)
    return False


#: How far back a hand-set visit start may lie.
MAX_MANUAL_AGE = timedelta(days=30)


def set_visit_from(session: Session, visit_from: datetime, *, now: datetime) -> None:
    """Set the current visit's window by hand: ``(visit_from, now]``.

    The visit continues (``last_seen_at`` = ``now``) and the dismissal is cleared so the
    card can show. ``ValueError`` unless ``visit_from`` is in the past and at most
    :data:`MAX_MANUAL_AGE` old.
    """
    now, visit_from = _utc(now), _utc(visit_from)
    if visit_from >= now:
        raise ValueError("visit_from must be in the past")
    if now - visit_from > MAX_MANUAL_AGE:
        raise ValueError("visit_from must not be older than 30 days")
    _store(session, FROM_KEY, visit_from)
    _store(session, START_KEY, now)
    _store(session, SEEN_KEY, now)
    app_config_service.delete_key(session, CONFIG_KEY)
    activity("changes").info("daily brief visit start set by hand to %s", visit_from.isoformat())


def clear_visit(session: Session) -> None:
    """Back to automatic: forget the visit window (the next absence rolls as normal)."""
    app_config_service.delete_key(session, FROM_KEY)
    app_config_service.delete_key(session, START_KEY)
    activity("changes").info("daily brief visit start back to automatic")


def ack(session: Session, *, seen_at: datetime | None, now: datetime) -> datetime:
    """Advance the dismissal marker to ``min(seen_at or now, now)``, never backwards.

    It also counts as a heartbeat: the visit's last sign of life is never older than
    the dismissal, so the dismissal never counts as an absence.
    """
    now = _utc(now)
    target = min(_utc(seen_at) if seen_at is not None else now, now)
    current = get_last_ack(session)
    if current is not None and current > target:
        target = current
    if current != target:
        _store(session, CONFIG_KEY, target)
    seen = get_last_seen(session)
    if seen is None or seen < target:
        _store(session, SEEN_KEY, target)
    activity("changes").info("daily brief acknowledged up to %s", target.isoformat())
    return target


def live_rate(now: datetime) -> Decimal | None:
    """The live EUR/USD spot (USD per 1 EUR) active at ``now``, via the FX service."""
    from investment_dashboard.services import fx_service  # noqa: PLC0415

    spot = fx_service.active_live_spot("USD", now=now)
    if spot is None or spot.rate <= 0:
        return None
    return spot.rate


def rate_at(session: Session, moment: datetime) -> Decimal | None:
    """EUR/USD at the instant ``moment``: the per-instant rate of an intraday sample at
    most 30 minutes before it; ``None`` when there is none (no ECB daily fixing: that
    is a day's rate, not an instant's).
    """
    from investment_dashboard.services import intraday_snapshots_service  # noqa: PLC0415

    return intraday_snapshots_service.sample_fx_at(session, _utc(moment))


@dataclass(frozen=True)
class FxSince:
    """The window's currency lines with the two rates they were measured between.

    ``currency_effect`` is the EUR view's line (the book's currency effect, in euros);
    ``investing_power`` the USD view's (the regular euro amount in dollars, now vs then).
    """

    since: datetime
    rate_then: Decimal
    rate_now: Decimal
    currency_effect: brief_domain.CurrencyEffectSince | None
    investing_power: brief_domain.InvestingPowerSince | None


def fx_since(
    session: Session, *, since: datetime, now: datetime, rate_now: Decimal | None
) -> FxSince | None:
    """The EUR/USD rate's effect over ``(since, now]`` (the absence), or ``None``.

    EUR view: the current book (``metrics_service.book_holdings`` on the last session,
    the book the Overview's currency box revalues) at ``rate_now`` minus the same book
    at the rate at ``since`` (:func:`rate_at`): holdings held constant, only the rate
    moves. USD view: the Overview's investing power on the regular amount
    (``investing_power_service.get_amount_eur``) from the rate at ``since`` to now.
    ``rate_now`` is the rate at ``now`` (the visit's start), else the passed live rate. ``None`` when the window is empty or
    either rate is missing.
    """
    from investment_dashboard.services import (  # noqa: PLC0415
        intraday_snapshots_service,
        investing_power_service,
        metrics_service,
    )

    since, now = _utc(since), _utc(now)
    if now <= since:
        return None
    rate_then = rate_at(session, since)
    # The rate when the owner came back (the intraday sample at ``now``, the visit's
    # start); without one, the live rate the caller passed (or the spot).
    sampled = rate_at(session, now)
    if sampled is not None:
        rate_now = sampled
    elif rate_now is None or rate_now <= 0:
        rate_now = live_rate(now)
    if rate_then is None or rate_now is None:
        return None
    book = metrics_service.book_holdings(session, intraday_snapshots_service.last_session_date(now))
    effect = brief_domain.currency_effect_since(book, rate_then=rate_then, rate_now=rate_now)
    power = brief_domain.investing_power_since(
        investing_power_service.get_amount_eur(session), rate_then=rate_then, rate_now=rate_now
    )
    return FxSince(
        since,
        rate_then,
        rate_now,
        effect["EUR"] if effect is not None else None,
        power,
    )
