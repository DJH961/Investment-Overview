"""Currency page Impact read model (v7.2, ``GET /currency/effect/both``).

Contract stub: the full build lands in the next commit.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session


def build_effect_both(
    session: Session,
    range_key: str,
    overview: dict[str, dict[str, Any]],
    *,
    now: datetime | None = None,
) -> dict[str, dict[str, Any]]:
    """``{"EUR": ..., "USD": ...}`` Impact payloads for ``range_key``."""
    now = now or datetime.now(UTC)
    out: dict[str, dict[str, Any]] = {}
    for ccy in ("EUR", "USD"):
        payload = overview[ccy]
        out[ccy] = {
            "ccy": ccy,
            "range": range_key,
            "as_of": payload["as_of"],
            "generated_at": now.isoformat(),
            "granularity": "intraday" if range_key in ("1d", "1w") else "daily",
            "headline": {
                "effect": "0",
                "market": "0",
                "kind": "neutral",
                "return_basis": "daily_chain",
            },
        }
    return out
