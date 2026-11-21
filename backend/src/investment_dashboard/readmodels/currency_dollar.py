"""The Currency page's "The dollar" section (v7.2, ``GET /currency/dollar/both``).

Stub (contract commit): returns the empty shape; filled in the next commit.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

QUOTES: dict[str, dict[str, str]] = {
    "EUR": {"pair": "USD/EUR", "field": "inverse"},
    "USD": {"pair": "EUR/USD", "field": "rate"},
}


def build_dollar_both(
    session: Session,
    overview: dict[str, dict[str, Any]],
    range_key: str,
    *,
    now: datetime | None = None,
) -> dict[str, dict[str, Any]]:
    now = now or datetime.now(UTC)
    return {
        ccy: {
            "ccy": ccy,
            "as_of": overview[ccy].get("as_of"),
            "generated_at": now.isoformat(),
            "range": range_key,
            "quote": QUOTES[ccy],
        }
        for ccy in ("EUR", "USD")
    }


__all__ = ["QUOTES", "build_dollar_both"]
