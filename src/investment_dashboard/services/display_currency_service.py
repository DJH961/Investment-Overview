"""Display-currency service — single source of truth for the EUR/USD toggle.

The dashboard stores every cashflow in both its native currency and the
EUR equivalent at the date of the transaction. From v1.3 onward, the user
can pick which currency the **summary numbers** are presented in
(`EUR` or `USD`), independently of the underlying storage.

Persistence is via the ``app_config`` table, key ``display_currency``.
The default is ``EUR`` to preserve v1.2 behaviour. Values are validated
against :data:`SUPPORTED_CURRENCIES` to keep the rest of the codebase
honest.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo
from investment_dashboard.services import fx_service

#: Currencies the toggle accepts. EUR and USD only for v1.3 — adding more
#: is a matter of teaching :func:`convert_from_eur` how to look up the
#: rate, but every UI surface currently assumes a 2-symbol switch.
SUPPORTED_CURRENCIES: tuple[str, ...] = ("EUR", "USD")
DEFAULT_CURRENCY = "EUR"

_CONFIG_KEY = "display_currency"


def get_display_currency(session: Session) -> str:
    """Return the persisted display currency, defaulting to EUR."""
    raw = app_config_repo.get(session, _CONFIG_KEY)
    if raw is None:
        return DEFAULT_CURRENCY
    candidate = raw.strip().upper()
    if candidate not in SUPPORTED_CURRENCIES:
        return DEFAULT_CURRENCY
    return candidate


def set_display_currency(session: Session, currency: str) -> str:
    """Persist a new display currency. Returns the normalised value.

    Raises ``ValueError`` if the currency is not in
    :data:`SUPPORTED_CURRENCIES`.
    """
    normalised = currency.strip().upper()
    if normalised not in SUPPORTED_CURRENCIES:
        raise ValueError(
            f"Unsupported display currency {currency!r}; expected one of {SUPPORTED_CURRENCIES}",
        )
    app_config_repo.set_value(session, _CONFIG_KEY, normalised)
    return normalised


def convert_from_eur(
    session: Session,
    amount_eur: Decimal,
    *,
    target: str,
    as_of: date | None = None,
) -> Decimal:
    """Convert an EUR amount into ``target`` using the as-of FX rate.

    Returns the input unchanged when ``target == 'EUR'`` so callers can
    pipe everything through this helper without branching. If no FX rate
    is available the input is returned unchanged (degrade gracefully —
    spec §5.6).
    """
    target = target.upper()
    if target == "EUR":
        return amount_eur
    rate = fx_service.get_rate_eur_to_quote(session, as_of or date.today(), quote=target)
    if rate is None or rate == 0:
        return amount_eur
    return amount_eur * rate


def current_rate(
    session: Session,
    *,
    quote: str = "USD",
    as_of: date | None = None,
) -> Decimal | None:
    """Latest EUR→quote rate (forward-filled). ``None`` if FX history empty."""
    return fx_service.get_rate_eur_to_quote(session, as_of or date.today(), quote=quote)
