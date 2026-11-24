"""Serialization helpers for the JSON read-model layer.

The read-models emit only JSON-native types (``str``, ``int``, ``float``,
``bool``, ``None``, ``list``, ``dict``) so they can be handed straight to
:func:`json.dumps` or FastAPI's response encoder and consumed by any
client (the mobile app, a future web SPA, scripts).

Monetary and ratio values are :class:`decimal.Decimal` throughout the
domain/services layers. We serialize them as **strings** rather than
floats so no precision is lost in transit; clients parse them into their
own fixed-point type (``BigDecimal`` on Android). ``None`` round-trips to
JSON ``null``.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal


def dec(value: Decimal | None) -> str | None:
    """Serialize a ``Decimal`` as a plain string, or ``None`` as ``null``."""
    if value is None:
        return None
    return format(value, "f")


def iso(value: date | None) -> str | None:
    """Serialize a ``date`` (or ``datetime``) as an ISO-8601 string."""
    if value is None:
        return None
    return value.isoformat()


_HALF_UNIT = Decimal("0.5")
_HALF_POINT_TENTH = Decimal("0.0005")


def kind_at_display(value: Decimal, *, fraction: bool = False) -> str:
    """``tailwind`` / ``headwind`` / ``neutral`` from the value as it prints.

    The Currency page prints money in whole units and a fraction as points to one
    digit, so a figure that prints as zero (|money| < 0.5, |fraction| < 0.0005) is
    ``neutral``, never a tailwind or a headwind next to a "$0" or "0.0 pp".
    """
    threshold = _HALF_POINT_TENTH if fraction else _HALF_UNIT
    if abs(value) < threshold:
        return "neutral"
    return "tailwind" if value > 0 else "headwind"


def now_utc_iso() -> str:
    """Current UTC timestamp as an ISO-8601 string."""
    return datetime.now(tz=UTC).isoformat()
