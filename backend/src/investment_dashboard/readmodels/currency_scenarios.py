"""The Currency page's "What if" section (v7.2, ``GET /currency/scenarios/both``).

Stub (contract commit): returns the empty shape; filled in the next commit.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.currency_dollar import QUOTES

MIN_RATE = Decimal("0.90")
MAX_RATE = Decimal("1.60")
STEP = Decimal("0.005")


def build_scenarios_both(
    session: Session,
    overview: dict[str, dict[str, Any]],
    *,
    now: datetime | None = None,
) -> dict[str, dict[str, Any]]:
    now = now or datetime.now(UTC)
    return {
        ccy: {
            "ccy": ccy,
            "as_of": overview[ccy].get("as_of"),
            "generated_at": now.isoformat(),
            "quote": QUOTES[ccy],
            "step": dec(STEP),
            "min_rate": dec(MIN_RATE),
            "max_rate": dec(MAX_RATE),
        }
        for ccy in ("EUR", "USD")
    }


__all__ = ["MAX_RATE", "MIN_RATE", "STEP", "build_scenarios_both"]
