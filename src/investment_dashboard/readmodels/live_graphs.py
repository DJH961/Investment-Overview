"""Live 1D / 1W graph **springboard** export for the v3.0 browser companion.

The desktop already captures (and reconstructs) the within-day intraday "1 Day"
curve and the multi-day "1 Week" sleeve
(:mod:`investment_dashboard.services.intraday_snapshots_service`). Re-deriving
those on a phone means re-fetching intraday bars from the live provider on every
open — costly on the free tier and slow to first paint.

This read-model serialises those already-computed curves into the blob so the
web companion can **springboard** off them: paint the curve instantly from the
export and only fetch live bars to *extend the tip*, falling back to a full live
rebuild when the export is absent or too stale (see ``web/src/springboard.ts``).

Shape — each series is a list of **whole-book** points (the constant cash + NAV
base already added in, exactly as the desktop renders it) in *both* currencies:

    {
      "captured_at": "2026-06-23T15:30:00Z",   # freshness stamp (meta.generated_at twin)
      "day":  {"session_date": "2026-06-23", "market_open": true,
               "points": [{"t": "...Z", "value_eur": "...", "value_usd": "..."}, ...]},
      "week": {"start_date": "2026-06-17", "end_date": "2026-06-23", "market_open": true,
               "points": [...]}
    }

Currency model (proposal §10.8): ``value_usd`` is the booked, **FX-free** figure;
``value_eur`` carries each point's *own* per-minute EUR→USD rate, so the two
lines legitimately diverge — never a uniform rescale. Both columns are produced
by the very same desktop builders (:func:`build_intraday_value_series` /
:func:`build_week_value_series`), so the springboarded curve is identical to the
desktop's "1 Day" / "1 Week" lines.

The 1D session is **down-sampled** to at most :data:`MAX_DAY_POINTS` evenly
spaced points (keeping the first and last) so a dense live-captured session stays
small in the blob while remaining visually identical to the live curve.

Absent-tolerant: returns ``None`` when there is nothing worth shipping (empty
ledger, no intraday history captured yet), so the section is simply omitted from
older or data-less exports.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import market_hours
from investment_dashboard.readmodels._context import ReadModelContext
from investment_dashboard.readmodels._serialize import dec, now_utc_iso
from investment_dashboard.services import intraday_snapshots_service, positions_service
from investment_dashboard.ui.pages._overview_query import (
    ValueSeriesPoint,
    build_intraday_value_series,
    build_week_value_series,
)

#: Cap on the 1D session's exported points (≈ a 5-min trading session's density).
#: A dense live-captured session can hold far more rows; down-sampling keeps the
#: blob small while the curve stays visually identical to the live one.
MAX_DAY_POINTS = 80


def build(
    session: Session,
    *,
    context: ReadModelContext,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Serialise the desktop's 1D session + 1W sleeve for the mobile springboard.

    Returns ``None`` when neither curve has at least two plottable points, so the
    caller omits the section entirely (the web then falls back to a live build).
    """
    positions = positions_service.compute_positions(session, as_of=context.as_of)
    day = _day_series(session, positions=positions, now=now)
    week = _week_series(session, positions=positions, now=now)
    if day is None and week is None:
        return None
    out: dict[str, Any] = {"captured_at": now_utc_iso()}
    if day is not None:
        out["day"] = day
    if week is not None:
        out["week"] = week
    return out


def _day_series(
    session: Session,
    *,
    positions: list[positions_service.Position],
    now: datetime | None,
) -> dict[str, Any] | None:
    """The intraday "1 Day" whole-book curve in both currencies, down-sampled."""
    eur = build_intraday_value_series(
        session, currency="EUR", tz=None, now=now, positions=positions
    )
    if len(eur) < 2:
        return None
    usd = build_intraday_value_series(
        session, currency="USD", tz=None, now=now, positions=positions
    )
    points = _downsample(_zip_points(eur, usd), MAX_DAY_POINTS)
    ref = now or datetime.now(UTC)
    return {
        "session_date": intraday_snapshots_service.last_session_date(ref).isoformat(),
        "market_open": market_hours.is_us_market_open(ref),
        "points": points,
    }


def _week_series(
    session: Session,
    *,
    positions: list[positions_service.Position],
    now: datetime | None,
) -> dict[str, Any] | None:
    """The multi-day "1 Week" whole-book curve in both currencies.

    Sourced cache-first (no live fetcher passed) so the export stays offline-safe;
    when no intraday history is cached the series is simply omitted.
    """
    eur = build_week_value_series(session, currency="EUR", tz=None, now=now, positions=positions)
    if len(eur) < 2:
        return None
    usd = build_week_value_series(session, currency="USD", tz=None, now=now, positions=positions)
    points = _downsample(_zip_points(eur, usd), MAX_DAY_POINTS)
    window = intraday_snapshots_service.recent_trading_sessions(now)
    ref = now or datetime.now(UTC)
    return {
        "start_date": window[0].isoformat(),
        "end_date": window[-1].isoformat(),
        "market_open": market_hours.is_us_market_open(ref),
        "points": points,
    }


def _zip_points(eur: list[ValueSeriesPoint], usd: list[ValueSeriesPoint]) -> list[dict[str, Any]]:
    """Pair the per-currency value series (same timestamps) into export points.

    Both lists come from the same builder with the same ``now``/positions, so they
    share timestamps and length; ``zip`` aligns them defensively by index.
    """
    return [
        {"t": _iso_utc(e.date), "value_eur": dec(e.value), "value_usd": dec(u.value)}
        for e, u in zip(eur, usd, strict=False)
    ]


def _iso_utc(when: object) -> str:
    """ISO-8601 UTC string with a ``Z`` suffix for a naive-UTC datetime.

    The intraday samples carry naive-UTC timestamps; an explicit ``Z`` makes the
    instant unambiguous for the browser's ``Date.parse`` (a bare ``T``-time would
    otherwise be read as local time).
    """
    dt = when if isinstance(when, datetime) else datetime(when.year, when.month, when.day)  # type: ignore[attr-defined]
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _downsample(points: list[dict[str, Any]], max_points: int) -> list[dict[str, Any]]:
    """At most ``max_points`` evenly spaced points, always keeping first and last."""
    n = len(points)
    if n <= max_points or max_points < 2:
        return points
    idx = sorted({round(i * (n - 1) / (max_points - 1)) for i in range(max_points)})
    return [points[i] for i in idx]
