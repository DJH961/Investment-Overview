"""Per-request context shared by the read-model builders.

Bundles the values every section needs — the as-of date, the user's
persisted display currency, and the relevant FX rates — so each builder
takes a single ``ReadModelContext`` instead of re-reading config and
re-querying FX on every call.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.services import display_currency_service


@dataclass(frozen=True)
class ReadModelContext:
    """Resolved currency/date context for a single read-model build."""

    as_of: date
    display_currency: str
    #: EUR→display-currency rate (``None`` if FX history is empty or the
    #: display currency is EUR).
    fx_rate_eur_to_display: Decimal | None
    #: EUR→USD rate, always provided for reference regardless of the
    #: display currency (``None`` if FX history is empty).
    fx_rate_eur_usd: Decimal | None


def build_context(session: Session, *, as_of: date | None = None) -> ReadModelContext:
    """Resolve the display currency + FX rates for ``as_of`` (today by default)."""
    as_of = as_of or date.today()
    display_currency = display_currency_service.get_display_currency(session)
    if display_currency == "EUR":
        fx_display: Decimal | None = None
    else:
        fx_display = display_currency_service.current_rate(
            session, quote=display_currency, as_of=as_of
        )
    fx_usd = display_currency_service.current_rate(session, quote="USD", as_of=as_of)
    return ReadModelContext(
        as_of=as_of,
        display_currency=display_currency,
        fx_rate_eur_to_display=fx_display,
        fx_rate_eur_usd=fx_usd,
    )
