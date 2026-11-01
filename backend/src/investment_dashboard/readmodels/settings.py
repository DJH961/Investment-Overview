"""Settings read-model: one typed view over the scattered ``app_config`` services.

Every value is read and written through its owning service (display currency,
theme, timezone, clock format, auto-refresh interval, investing amount, chart
prefs). Services raise ``ValueError`` on bad input; the API maps that to 422.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.queries.overview_query import VALUE_RANGES
from investment_dashboard.services import (
    auto_refresh,
    chart_prefs_service,
    clock_format_service,
    display_currency_service,
    investing_power_service,
    onboarding_service,
    theme_service,
    timezone_service,
)

#: Chart prefs exposed over the API: key -> (default, allowed values or ``None``).
CHART_PREFS: dict[str, tuple[str, list[str] | None]] = {
    "overview_value_range": ("Year", [name for name, _ in VALUE_RANGES]),
    "analytics_lookback": ("365", None),
    "calc.allow_fractional": ("0", ["0", "1"]),
    "calc.rebalance": ("0", ["0", "1"]),
}


def _theme_token(session: Session) -> str:
    dark = theme_service.get_theme(session)
    return "auto" if dark is None else ("dark" if dark else "light")


def build(session: Session) -> dict[str, Any]:
    """Current settings plus the option lists the Settings page renders."""
    return {
        "display_ccy": display_currency_service.get_display_currency(session),
        "theme": _theme_token(session),
        "timezone": timezone_service.get_timezone(session),
        "clock_format": clock_format_service.get_clock_format(session),
        "auto_refresh_seconds": auto_refresh.get_interval_seconds(session),
        "investment_amount_eur": dec(investing_power_service.get_amount_eur(session)),
        "chart_prefs": {
            key: chart_prefs_service.get_pref(session, key, default=default, allowed=allowed)
            for key, (default, allowed) in CHART_PREFS.items()
        },
        "onboarded": onboarding_service.is_onboarded(session),
        "options": {
            "currencies": list(display_currency_service.SUPPORTED_CURRENCIES),
            "themes": list(theme_service.SUPPORTED_THEMES),
            "clock_formats": list(clock_format_service.SUPPORTED_FORMATS),
            "timezones": timezone_service.supported_timezones(),
            "auto_refresh_min_seconds": auto_refresh.MIN_INTERVAL_SECONDS,
            "auto_refresh_max_seconds": auto_refresh.MAX_INTERVAL_SECONDS,
            "investment_amount_min_eur": dec(investing_power_service.MIN_AMOUNT_EUR),
            "investment_amount_max_eur": dec(investing_power_service.MAX_AMOUNT_EUR),
            "chart_pref_keys": {key: allowed for key, (_d, allowed) in CHART_PREFS.items()},
        },
    }


def apply(  # noqa: PLR0912 - one flat validate-then-persist routine
    session: Session,
    *,
    display_ccy: str | None = None,
    theme: str | None = None,
    timezone: str | None = None,
    clock_format: str | None = None,
    auto_refresh_seconds: int | None = None,
    investment_amount_eur: str | None = None,
    chart_prefs: dict[str, str] | None = None,
) -> None:
    """Validate everything first, then persist. Raises ``ValueError`` on bad input."""
    amount: Decimal | None = None
    if investment_amount_eur is not None:
        try:
            amount = Decimal(investment_amount_eur)
        except InvalidOperation as exc:
            raise ValueError(f"Invalid investment amount {investment_amount_eur!r}") from exc
        if not amount.is_finite() or amount <= 0:
            raise ValueError("Investment amount must be a positive number")
    for key, value in (chart_prefs or {}).items():
        if key not in CHART_PREFS:
            raise ValueError(f"Unknown chart pref {key!r}")
        allowed = CHART_PREFS[key][1]
        if allowed is not None and value not in allowed:
            raise ValueError(f"Chart pref {key!r} must be one of {allowed}")
        if key == "analytics_lookback" and not value.isdigit():
            raise ValueError("analytics_lookback must be a whole number of days")

    if display_ccy is not None:
        display_currency_service.set_display_currency(session, display_ccy)
    if theme is not None:
        theme_service.set_theme(session, {"auto": None, "light": False, "dark": True}[theme])
    if timezone is not None:
        timezone_service.set_timezone(session, timezone)
    if clock_format is not None:
        clock_format_service.set_clock_format(session, clock_format)
    if auto_refresh_seconds is not None:
        auto_refresh.set_interval_seconds(session, auto_refresh_seconds)
    if amount is not None:
        investing_power_service.set_amount_eur(session, amount)
    for key, value in (chart_prefs or {}).items():
        chart_prefs_service.set_pref(session, key, value)
