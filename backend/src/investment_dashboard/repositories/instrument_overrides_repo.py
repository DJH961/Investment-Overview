"""Instrument-override repository — CRUD against the config-tier
``instrument_overrides`` table.

Defaults when no row exists for a given instrument:

* ``category`` → ``None`` (un-grouped).
* ``active``   → ``True`` (visible).

Callers that need to render or filter many instruments at once should
prefer :func:`get_override_map`, which is one round-trip; the per-id
helpers exist for the single-edit dialogs in Settings.
"""

from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.models import InstrumentOverride


def get(session: Session, instrument_id: int) -> InstrumentOverride | None:
    """Return the override row for ``instrument_id``, or ``None``."""
    return session.get(InstrumentOverride, instrument_id)


def get_override_map(
    session: Session, instrument_ids: Iterable[int] | None = None
) -> dict[int, InstrumentOverride]:
    """Return ``{instrument_id: override}`` for the given ids, or all rows.

    Pass ``None`` to fetch every override (Settings listing, treemap).
    Missing ids are simply absent from the returned mapping; callers
    apply the documented defaults.
    """
    stmt = select(InstrumentOverride)
    if instrument_ids is not None:
        ids = list(instrument_ids)
        if not ids:
            return {}
        stmt = stmt.where(InstrumentOverride.instrument_id.in_(ids))
    return {o.instrument_id: o for o in session.scalars(stmt).all()}


def get_category(session: Session, instrument_id: int) -> str | None:
    ov = get(session, instrument_id)
    return ov.category if ov is not None else None


def is_active(session: Session, instrument_id: int) -> bool:
    ov = get(session, instrument_id)
    return ov.active if ov is not None else True


def inactive_ids(session: Session) -> set[int]:
    """Return the set of instrument_ids whose override row marks them inactive.

    Inverted (rather than ``active_ids``) to keep the common case
    cheap: most instruments are active, so most callers want
    ``if id in inactive_ids`` to short-circuit.
    """
    stmt = select(InstrumentOverride.instrument_id).where(InstrumentOverride.active.is_(False))
    return set(session.scalars(stmt).all())


def upsert(
    session: Session,
    instrument_id: int,
    *,
    category: str | None | _Sentinel = ...,  # type: ignore[assignment]
    active: bool | _Sentinel = ...,  # type: ignore[assignment]
    name_override: str | None | _Sentinel = ...,  # type: ignore[assignment]
    asset_class_override: str | None | _Sentinel = ...,  # type: ignore[assignment]
    expense_ratio_override: Decimal | None | _Sentinel = ...,  # type: ignore[assignment]
) -> InstrumentOverride:
    """Insert-or-update the override for ``instrument_id``.

    Sentinel-default kwargs: omit a field to leave it untouched (or
    keep its default on insert). Pass ``category=None`` (etc.) to
    explicitly clear a value. The three v2.2 display-override fields
    (``name_override`` / ``asset_class_override`` /
    ``expense_ratio_override``) follow the same semantics.
    """
    ov = session.get(InstrumentOverride, instrument_id)
    if ov is None:
        ov = InstrumentOverride(
            instrument_id=instrument_id,
            category=category if category is not ... else None,
            active=active if active is not ... else True,
            name_override=name_override if name_override is not ... else None,
            asset_class_override=(
                asset_class_override if asset_class_override is not ... else None
            ),
            expense_ratio_override=(
                expense_ratio_override if expense_ratio_override is not ... else None
            ),
        )
        session.add(ov)
    else:
        if category is not ...:
            ov.category = category  # type: ignore[assignment]
        if active is not ...:
            ov.active = bool(active)
        if name_override is not ...:
            ov.name_override = name_override  # type: ignore[assignment]
        if asset_class_override is not ...:
            ov.asset_class_override = asset_class_override  # type: ignore[assignment]
        if expense_ratio_override is not ...:
            ov.expense_ratio_override = expense_ratio_override  # type: ignore[assignment]
    session.flush()
    return ov


def set_category(session: Session, instrument_id: int, category: str | None) -> InstrumentOverride:
    return upsert(session, instrument_id, category=category)


def set_active(session: Session, instrument_id: int, active: bool) -> InstrumentOverride:
    return upsert(session, instrument_id, active=active)


def delete_for(session: Session, instrument_id: int) -> None:
    """Drop the override row, if any. Used by the cache-orphan janitor."""
    ov = session.get(InstrumentOverride, instrument_id)
    if ov is not None:
        session.delete(ov)
        session.flush()


# Internal sentinel type for the upsert kwargs. ``...`` (Ellipsis) is
# the runtime sentinel; this alias only exists so type-checkers don't
# complain about ``... `` defaulting to ``bool``/``str | None``.
class _Sentinel:  # pragma: no cover
    pass
