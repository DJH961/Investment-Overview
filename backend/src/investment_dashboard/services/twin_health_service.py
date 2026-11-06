"""ETF-twin health: the settings + one entry per fund with a twin mapping.

The read side for the Health & Repair page's twin card
(``GET /api/maintenance/twins``). Mirrors :mod:`tiingo_usage_service`: a single
``health()`` call opens its own session and gathers everything the page needs,
so the router stays a one-line wrapper. Nothing here reaches into the cache
tier for twin prices itself — that stays behind
:mod:`intraday_snapshots_service` (the storage-tier rule in
``docs/architecture.md``); this module only orchestrates its public functions.

💱 Units: every divergence figure here is in PERCENTAGE POINTS (``0.03`` = 0.03
pp), the same convention as ``TwinDivergence`` in the Holdings API
(``api/schemas/holdings.py``) — NOT a fraction like ``currency_effect_pp``
elsewhere (``api/schemas/overview.py``), despite the similar name. The schema
(``api/schemas/maintenance.py::TwinDivergenceStats``) documents this per field.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

#: Fraction -> percentage points (``0.0003`` -> ``"0.03"``).
_HUNDRED = Decimal(100)


def _pp(value: Decimal) -> str:
    return format(value * _HUNDRED, "f")


def _iso(at: datetime | None) -> str | None:
    if at is None:
        return None
    return (at if at.tzinfo is not None else at.replace(tzinfo=UTC)).isoformat()


def health(*, now: datetime | None = None) -> dict[str, Any]:
    """Twin settings + one entry per fund with a twin mapping, for Health & Repair."""
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.repositories import (  # noqa: PLC0415
        instrument_overrides_repo,
        instruments_repo,
    )
    from investment_dashboard.services import intraday_snapshots_service as iss  # noqa: PLC0415

    now = now or datetime.now(UTC)
    with ledger_session_scope() as session:
        mapping = instrument_overrides_repo.intraday_twin_map(session)
        funds: list[dict[str, Any]] = []
        for iid, twin in mapping.items():
            instrument = instruments_repo.get_instrument(session, iid)
            if instrument is None:
                continue
            fd = iss.fund_divergence(session, instrument_id=iid, twin_symbol=twin, now=now)
            coverage = iss.twin_price_coverage(session, twin, now=now)
            divergence = None
            if fd is not None:
                stats = fd.stats
                divergence = {
                    "last_gap_pp": _pp(stats.last_gap),
                    "last_date": stats.last_date.isoformat(),
                    "median_abs_pp": _pp(stats.median_abs),
                    "bias_pp": _pp(stats.bias),
                    "sessions": stats.sessions,
                }
            first_session = coverage["first_session"]
            last_session = coverage["last_session"]
            funds.append(
                {
                    "instrument_id": iid,
                    "symbol": instrument.symbol,
                    "name": instrument.name or instrument.symbol,
                    "twin_symbol": twin,
                    "estimating": iss.is_estimating(session, iid, now),
                    "stored_sessions": coverage["stored_sessions"],
                    "first_session": first_session.isoformat() if first_session else None,
                    "last_session": last_session.isoformat() if last_session else None,
                    "last_price_at": _iso(coverage["last_price_at"]),  # type: ignore[arg-type]
                    "year_backfill_done": iss.year_backfill_done(session, twin),
                    "divergence": divergence,
                }
            )
        funds.sort(key=lambda f: f["symbol"])
        return {
            "enabled": iss.estimates_enabled(session),
            "window": iss.divergence_window(),
            "funds": funds,
        }
