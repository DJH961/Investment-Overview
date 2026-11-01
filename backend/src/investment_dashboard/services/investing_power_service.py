"""Regular-investment-amount service — the EUR notional the owner wires to invest.

Most of the portfolio is USD-booked, so a EUR/USD move hands the owner **no
extra dollars** on assets already held — the portfolio FX effect in USD is
exactly ``$0``. What actually changes for the owner in dollar terms is their
*investing power*: the euros they regularly send to the US to keep buying now
buy more or fewer dollars as the rate moves.

This service persists that regular EUR amount (the euros sent on each recurring
investment, default ``€100``) in the ``app_config`` table so the Overview's
USD-mode "Investing power since yesterday" panel can value it at the live rate.
It mirrors ``getInvestmentAmountEur`` / ``parseInvestmentAmount`` in the web
companion's ``web/src/config.ts`` so both surfaces clamp the amount the same way.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo

_CONFIG_KEY = "investing_power.amount_eur"

#: Default regular investment amount (EUR). Matches the web companion's
#: ``DEFAULT_INVESTMENT_AMOUNT_EUR``.
DEFAULT_AMOUNT_EUR = Decimal("100")
#: Guard-rails: at least €1, capped at €1,000,000 so a fat-fingered entry can't
#: produce an absurd buying-power figure. Matches the web companion.
MIN_AMOUNT_EUR = Decimal("1")
MAX_AMOUNT_EUR = Decimal("1000000")
#: Amounts are stored to the cent — a regular wire is a real euro amount.
_CENT = Decimal("0.01")


def clamp_amount_eur(value: Decimal) -> Decimal:
    """Clamp a requested amount into ``[MIN, MAX]`` and round to the cent."""
    bounded = max(MIN_AMOUNT_EUR, min(MAX_AMOUNT_EUR, value))
    return bounded.quantize(_CENT, rounding=ROUND_HALF_UP)


def get_amount_eur(session: Session) -> Decimal:
    """Return the persisted regular investment amount, defaulting + clamped."""
    raw = app_config_repo.get(session, _CONFIG_KEY)
    if raw is None:
        return DEFAULT_AMOUNT_EUR
    try:
        parsed = Decimal(raw)
    except (TypeError, ValueError, InvalidOperation):
        return DEFAULT_AMOUNT_EUR
    if not parsed.is_finite() or parsed <= 0:
        return DEFAULT_AMOUNT_EUR
    return clamp_amount_eur(parsed)


def set_amount_eur(session: Session, value: Decimal) -> Decimal:
    """Persist a new regular investment amount (clamped). Returns the stored value."""
    clamped = clamp_amount_eur(value)
    app_config_repo.set_value(session, _CONFIG_KEY, str(clamped))
    return clamped
