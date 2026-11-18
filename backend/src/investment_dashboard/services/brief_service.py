"""The Daily Brief's acknowledgement marker (``brief.last_ack_at`` in app config).

Stored as an ISO UTC string. It never moves backwards and never past the server clock.

Beside it, ``brief.last_ack_fx`` keeps the live EUR/USD rate observed when the marker
was set (``{"at": <marker ISO>, "rate": "<USD per EUR>"}``): the "then" rate of the
Brief's currency effect (:func:`currency_effect_since`). It is a rate, not a derived
amount, and it only counts while its ``at`` equals the marker.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.domain import brief as brief_domain
from investment_dashboard.services import app_config_service

CONFIG_KEY = "brief.last_ack_at"
RATE_KEY = "brief.last_ack_fx"


def _utc(moment: datetime) -> datetime:
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def get_last_ack(session: Session) -> datetime | None:
    """The stored marker (aware UTC), or ``None`` before the first visit."""
    raw = app_config_service.get(session, CONFIG_KEY)
    if not raw:
        return None
    try:
        return _utc(datetime.fromisoformat(raw))
    except ValueError:
        return None


def _live_rate(now: datetime) -> Decimal | None:
    """The live EUR/USD spot (USD per 1 EUR) active at ``now``, via the FX service."""
    from investment_dashboard.services import fx_service  # noqa: PLC0415

    spot = fx_service.active_live_spot("USD", now=now)
    if spot is None or spot.rate <= 0:
        return None
    return spot.rate


def _store(session: Session, moment: datetime, *, rate: Decimal | None = None) -> None:
    at = _utc(moment).isoformat()
    app_config_service.set_value(session, CONFIG_KEY, at)
    if rate is not None and rate > 0:
        app_config_service.set_value(
            session, RATE_KEY, json.dumps({"at": at, "rate": format(rate, "f")})
        )


def stored_rate_at(session: Session, moment: datetime) -> Decimal | None:
    """The rate recorded with the marker, when it was recorded for ``moment``."""
    raw = app_config_service.get(session, RATE_KEY)
    if not raw:
        return None
    try:
        data = json.loads(raw)
        at = _utc(datetime.fromisoformat(str(data["at"])))
        rate = Decimal(str(data["rate"]))
    except (ValueError, KeyError, TypeError, InvalidOperation):
        return None
    if at != _utc(moment) or not rate.is_finite() or rate <= 0:
        return None
    return rate


def init_marker(session: Session, now: datetime) -> datetime:
    """First visit: set the marker to ``now`` (no Brief). Returns the marker."""
    current = get_last_ack(session)
    if current is not None:
        return current
    _store(session, now, rate=_live_rate(now))
    return _utc(now)


def ack(session: Session, *, seen_at: datetime | None, now: datetime) -> datetime:
    """Advance the marker to ``min(seen_at or now, now)``, never backwards."""
    now = _utc(now)
    target = min(_utc(seen_at) if seen_at is not None else now, now)
    current = get_last_ack(session)
    if current is not None and current > target:
        target = current
    if current != target:
        _store(session, target, rate=_live_rate(now))
    activity("changes").info("daily brief acknowledged up to %s", target.isoformat())
    return target


def rate_at(session: Session, moment: datetime) -> Decimal | None:
    """EUR/USD at the instant ``moment``: the rate recorded with the marker, else the
    per-instant rate of an intraday sample at most 30 minutes before it; ``None``
    when neither exists (no ECB daily fixing: that is a day's rate, not an instant's).
    """
    from investment_dashboard.services import intraday_snapshots_service  # noqa: PLC0415

    stored = stored_rate_at(session, moment)
    if stored is not None:
        return stored
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
    """The EUR/USD rate's effect over ``(since, now]``, or ``None``.

    EUR view: the current book (``metrics_service.book_holdings`` on the last session,
    the book the Overview's currency box revalues) at ``rate_now`` minus the same book
    at the rate at ``since`` (:func:`rate_at`): holdings held constant, only the rate
    moves. USD view: the Overview's investing power on the regular amount
    (``investing_power_service.get_amount_eur``) from the rate at ``since`` to now.
    ``rate_now`` falls back to the live spot. ``None`` when the window is empty or
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
    if rate_now is None or rate_now <= 0:
        rate_now = _live_rate(now)
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
