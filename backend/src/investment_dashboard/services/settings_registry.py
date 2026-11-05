"""The settings catalogue: every setting editable in the app, in one list.

Keys reuse the existing ``app_config`` names (``display_currency``, ``theme``,
``tiingo_hourly_cap`` ...) so the legacy per-setting services keep reading the
same rows; new keys are dot-namespaced. Defaults equal the module constants the
code used before (``tests/services/test_settings_registry.py`` checks each one),
and those constants stay as the fallback where a value cannot be read.

Must-stay-env items (paths, passphrases, ports, cookie and passkey origin) are
not here; ``GET /api/system`` shows them read-only. Session / login limits are
advanced ``env_bound="ceiling"`` settings: the app may only make them stricter
than the bootstrap/env value (see :func:`settings_service.stricter`). Body caps
stay env-only (the request guard reads them before any database access).
"""

from __future__ import annotations

import functools
from collections.abc import Callable, Mapping
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

from investment_dashboard.domain.kinds import TransactionKind
from investment_dashboard.domain.settings_schema import (
    SettingDef,
    SettingError,
    SettingType,
    Typed,
)

#: Section id -> label, in page order.
SECTIONS: dict[str, str] = {
    "display": "Display",
    "portfolio": "Portfolio & analytics",
    "projection": "Projection",
    "allocation": "Allocation defaults",
    "instruments": "Instruments & mappings",
    "imports": "Import rules",
    "data_refresh": "Data refresh",
    "providers": "Providers",
    "backups": "Backups",
    "diagnostics": "Health checks",
    "system": "System",
}

GRAPH_RANGE_KEYS: tuple[str, ...] = ("1d", "1w", "1m", "3m", "6m", "ytd", "1y", "all")
LOCALES: tuple[str, ...] = ("en-GB", "de-DE", "en-US")
DATE_FORMATS: tuple[str, ...] = ("auto", "DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD.MM.YYYY")
NUMBER_FORMATS: tuple[str, ...] = ("auto", "1,234.56", "1.234,56", "1 234,56", "1'234.56")
#: Sentinels accepted besides IANA zone names. "Browser" = the viewer's device zone.
TIMEZONE_SENTINELS: tuple[str, ...] = ("Browser", "Local", "UTC")
LOG_LEVELS: tuple[str, ...] = ("INFO", "DEBUG", "WARNING")
_D = Decimal


@functools.cache
def _zones() -> frozenset[str]:
    return frozenset(available_timezones())


def _timezone(value: Typed) -> None:
    if value in TIMEZONE_SENTINELS:
        return
    if not isinstance(value, str) or value not in _zones():
        raise SettingError(f"display_timezone: unknown timezone {value!r}")
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:  # pragma: no cover
        raise SettingError(f"display_timezone: unknown timezone {value!r}") from exc


def _currencies(value: Typed) -> None:
    if not isinstance(value, tuple) or not value:
        raise SettingError("fx.tracked_quotes: at least one currency is needed")
    for code in value:
        if not (isinstance(code, str) and len(code) == 3 and code.isalpha()):
            raise SettingError(f"fx.tracked_quotes: {code!r} is not a 3-letter currency code")
        if code == "EUR":
            raise SettingError("fx.tracked_quotes: EUR is the base currency")


#: Values an action override may map to: a ledger kind, or "ignore" (drop the row).
ACTION_OVERRIDE_TARGETS: tuple[str, ...] = (*(k.value for k in TransactionKind), "ignore")
#: Brokers whose parsers accept action overrides (``import.action_overrides.<broker>``).
ACTION_OVERRIDE_BROKERS: tuple[str, ...] = ("fidelity", "vanguard", "generic")


def _action_overrides(value: Typed) -> None:
    if not isinstance(value, dict):  # pragma: no cover - type-checked by coerce
        raise SettingError("expected an object")
    for action, kind in value.items():
        if not action:
            raise SettingError("an action cannot be empty")
        if kind not in ACTION_OVERRIDE_TARGETS:
            raise SettingError(
                f"{action!r}: {kind!r} is not one of {', '.join(ACTION_OVERRIDE_TARGETS)}"
            )


def _action_map(broker: str) -> SettingDef:
    return SettingDef(
        f"import.action_overrides.{broker}",
        SettingType.JSON_MAP,
        {},
        "imports",
        f"{broker.title()} action mapping",
        help=(
            "Broker action text -> transaction kind (or 'ignore'), for actions the "
            "importer does not know. Matched case-insensitively; wins over the built-in rules."
        ),
        validator=_action_overrides,
    )


def _ttl(asset_class: str, default: int, label: str) -> SettingDef:
    return SettingDef(
        key=f"prices.ttl_seconds.{asset_class}",
        type=SettingType.DURATION_S,
        default=default,
        section="data_refresh",
        label=label,
        help=(
            "How long the server waits before asking the provider again for this kind "
            "of holding (only while a newer price can exist: during the session, or "
            "after the close until the day's close / NAV is in)."
        ),
        min=_D(30),
        max=_D(7 * 24 * 3600),
        unit="s",
    )


DEFS: tuple[SettingDef, ...] = (
    # -- display ---------------------------------------------------------------
    SettingDef(
        "display_currency",
        SettingType.ENUM,
        "EUR",
        "display",
        "Display currency",
        choices=("EUR", "USD"),
    ),
    SettingDef(
        "theme", SettingType.ENUM, "auto", "display", "Theme", choices=("auto", "light", "dark")
    ),
    SettingDef(
        "display.locale",
        SettingType.ENUM,
        "en-GB",
        "display",
        "Regional preset",
        help=(
            "What the date, number and time formats below follow while they are on "
            "'auto'. en-GB: 31/12/2026, 24h, 1,234.56 · de-DE: 31.12.2026, 24h, "
            "1.234,56 · en-US: 12/31/2026, 12h, 1,234.56. Also picks the currency "
            "symbol placement."
        ),
        choices=LOCALES,
    ),
    SettingDef(
        "display.date_format",
        SettingType.ENUM,
        "auto",
        "display",
        "Date format",
        help="Example for 31 December 2026: 31/12/2026, 12/31/2026, 2026-12-31 or 31.12.2026. 'auto' follows the regional preset.",
        choices=DATE_FORMATS,
    ),
    SettingDef(
        "display.number_format",
        SettingType.ENUM,
        "auto",
        "display",
        "Number and currency format",
        help="Separators for numbers and amounts: 1,234.56 · 1.234,56 · 1 234,56 · 1'234.56. 'auto' follows the regional preset.",
        choices=NUMBER_FORMATS,
    ),
    SettingDef(
        "display_timezone",
        SettingType.STRING,
        "Local",
        "display",
        "Timezone",
        help="'Browser' follows the device you are using; 'Local' is the server's zone.",
        validator=_timezone,
    ),
    SettingDef(
        "clock_format",
        SettingType.ENUM,
        "auto",
        "display",
        "Time format",
        help="24h: 14:05 · 12h: 2:05 PM. 'auto' follows the regional preset (en-US 12h, others 24h).",
        choices=("auto", "12h", "24h"),
    ),
    SettingDef(
        "display.overview_default_range",
        SettingType.ENUM,
        "1m",
        "display",
        "Overview default range",
        choices=GRAPH_RANGE_KEYS,
    ),
    SettingDef(
        "display.holdings_default_range",
        SettingType.ENUM,
        "1y",
        "display",
        "Holdings history default range",
        choices=GRAPH_RANGE_KEYS,
    ),
    SettingDef(
        "chart_pref.analytics_lookback",
        SettingType.INT,
        365,
        "display",
        "Risk lookback (days)",
        min=_D(30),
        max=_D(3650),
        unit="days",
    ),
    SettingDef(
        "live_refresh_interval_seconds",
        SettingType.INT,
        60,
        "data_refresh",
        "Price refresh while the stock market is open",
        help="How often prices refresh while the US stock market is open.",
        min=_D(15),
        max=_D(3600),
        unit="s",
    ),
    SettingDef(
        "live_graphs_grid",
        SettingType.ENUM,
        "30m",
        "display",
        "1D/1W graph grid",
        choices=("30m", "15m"),
    ),
    # -- portfolio & analytics ------------------------------------------------
    SettingDef(
        "benchmark_symbol",
        SettingType.SYMBOL,
        "VT",
        "portfolio",
        "Benchmark symbol",
        help="Ticker the portfolio is compared against ('Vs market').",
    ),
    SettingDef(
        "risk_free_rate_symbol",
        SettingType.SYMBOL,
        "^IRX",
        "portfolio",
        "Risk-free rate symbol",
    ),
    SettingDef(
        "risk_free_rate_manual",
        SettingType.PERCENT,
        None,
        "portfolio",
        "Manual risk-free rate",
        help="A fraction (0.04 = 4 %). Leave empty to use the fetched rate.",
        min=_D(0),
        max=_D(1),
        nullable=True,
    ),
    SettingDef(
        "risk.var_alpha",
        SettingType.PERCENT,
        _D("0.05"),
        "portfolio",
        "Value-at-risk tail",
        help="0.05 = 95 % VaR.",
        min=_D("0.01"),
        max=_D("0.2"),
    ),
    SettingDef(
        "investing_power.amount_eur",
        SettingType.DECIMAL,
        _D("100"),
        "portfolio",
        "Investing amount (EUR)",
        min=_D(1),
        max=_D(1_000_000),
    ),
    # -- projection ------------------------------------------------------------
    SettingDef(
        "projection.scenarios",
        SettingType.PERCENT_LIST,
        (_D("0.04"), _D("0.07"), _D("0.10")),
        "projection",
        "Projection scenarios",
        help="Yearly real-return assumptions as fractions (0.07 = 7 %).",
        min=_D("-0.5"),
        max=_D("0.4"),
    ),
    SettingDef(
        "projection.fallback_rate",
        SettingType.PERCENT,
        _D("0.07"),
        "projection",
        "Fallback expected rate",
        help="Used when the portfolio has too little history for its own rate.",
        min=_D("-0.5"),
        max=_D("0.4"),
    ),
    # -- allocation defaults ---------------------------------------------------
    SettingDef(
        "chart_pref.calc.allow_fractional",
        SettingType.BOOL,
        False,
        "allocation",
        "Allow fractional shares",
    ),
    SettingDef(
        "chart_pref.calc.rebalance",
        SettingType.BOOL,
        False,
        "allocation",
        "Allow selling to rebalance",
    ),
    # -- instruments -----------------------------------------------------------
    SettingDef(
        "portfolio.money_market_symbols",
        SettingType.SYMBOL_LIST,
        (),
        "instruments",
        "Extra money-market funds",
        help="Symbols treated as cash-like settlement funds, on top of the built-in list.",
    ),
    # -- imports ---------------------------------------------------------------
    SettingDef(
        "import.max_upload_mb",
        SettingType.INT,
        10,
        "imports",
        "Largest import file",
        min=_D(1),
        max=_D(50),
        level="advanced",
        unit="MB",
    ),
    SettingDef(
        "import.staging_ttl_minutes",
        SettingType.INT,
        30,
        "imports",
        "Keep an unconfirmed import for",
        min=_D(5),
        max=_D(240),
        level="advanced",
        unit="min",
    ),
    SettingDef(
        "import.preview_row_limit",
        SettingType.INT,
        500,
        "imports",
        "Rows shown in an import preview",
        min=_D(50),
        max=_D(5000),
        level="advanced",
    ),
    SettingDef(
        "import.column_profiles",
        SettingType.JSON_MAP,
        {},
        "imports",
        "Saved column layouts",
        help=(
            "Column layouts remembered by the flexible importer: header signature -> "
            "JSON layout. Written from the Import page; delete an entry to forget a layout."
        ),
    ),
    *(_action_map(b) for b in ACTION_OVERRIDE_BROKERS),
    # -- data refresh ----------------------------------------------------------
    _ttl("etf", 120, "ETF price age"),
    _ttl("stock", 120, "Stock price age"),
    _ttl("mutual_fund", 30 * 60, "Mutual-fund NAV re-check"),
    _ttl("cash", 24 * 3600, "Cash price age"),
    _ttl("savings", 24 * 3600, "Savings price age"),
    _ttl("default", 24 * 3600, "Other asset classes"),
    SettingDef(
        "scheduler.fx_interval_minutes",
        SettingType.INT,
        1,
        "data_refresh",
        "Currency refresh while the currency market is open",
        help=(
            "EUR/USD trades around the clock on weekdays (Sunday 17:00 to Friday 17:00 "
            "New York time) on its own clock, separate from the stock market: it is "
            "checked at this pace whenever it trades, day or night."
        ),
        min=_D(1),
        max=_D(720),
        unit="min",
    ),
    SettingDef(
        "scheduler.fx_closed_interval_minutes",
        SettingType.INT,
        10,
        "data_refresh",
        "Currency refresh while the currency market is closed",
        help="How often EUR/USD is checked over the weekend, when it does not trade.",
        min=_D(1),
        max=_D(720),
        unit="min",
    ),
    SettingDef(
        "scheduler.closed_interval_minutes",
        SettingType.INT,
        10,
        "data_refresh",
        "Price refresh while the stock market is closed",
        help=(
            "How often prices are checked while the US stock market is closed "
            "(nights, weekends, holidays). While it is open they follow the live "
            "refresh interval."
        ),
        min=_D(1),
        max=_D(720),
        unit="min",
    ),
    SettingDef(
        "scheduler.pause_default_hours",
        SettingType.INT,
        24,
        "data_refresh",
        "Pausing the scheduler lasts",
        help="A pause always ends by itself after this long.",
        min=_D(1),
        max=_D(168),
        unit="h",
    ),
    SettingDef(
        "fx.tracked_quotes",
        SettingType.SYMBOL_LIST,
        ("USD",),
        "data_refresh",
        "Tracked FX currencies",
        help="Currencies whose EUR rate history is kept (ISO codes).",
        level="advanced",
        validator=_currencies,
    ),
    SettingDef(
        "boot.backfill_days",
        SettingType.INT,
        14,
        "data_refresh",
        "Start-up price backfill",
        min=_D(1),
        max=_D(365),
        level="advanced",
        restart_required=True,
        unit="days",
    ),
    SettingDef(
        "boot.warm_force_recent_days",
        SettingType.INT,
        7,
        "data_refresh",
        "Recompute recent valuation days",
        min=_D(0),
        max=_D(60),
        level="advanced",
        unit="days",
    ),
    # -- providers -------------------------------------------------------------
    SettingDef(
        "tiingo.api_token",
        SettingType.STRING,
        None,
        "providers",
        "Tiingo API token",
        help="Fallback price source. Stored encrypted; it is never shown again.",
        secret=True,
        nullable=True,
        env_var="tiingo_token",
        danger="Changing it needs a fresh login.",
    ),
    SettingDef(
        "tiingo_hourly_cap",
        SettingType.INT,
        10,
        "providers",
        "Tiingo requests per hour",
        min=_D(1),
        max=_D(10_000),
        level="advanced",
    ),
    SettingDef(
        "tiingo_daily_cap",
        SettingType.INT,
        200,
        "providers",
        "Tiingo requests per day",
        min=_D(1),
        max=_D(10_000),
        level="advanced",
    ),
    SettingDef(
        "tiingo.fetch_lookback_days",
        SettingType.INT,
        7,
        "providers",
        "Tiingo fetch window",
        min=_D(1),
        max=_D(60),
        level="advanced",
        unit="days",
    ),
    SettingDef(
        "tiingo.write_lookback_days",
        SettingType.INT,
        14,
        "providers",
        "Tiingo write window",
        min=_D(1),
        max=_D(60),
        level="advanced",
        unit="days",
    ),
    # -- backups ---------------------------------------------------------------
    SettingDef(
        "backup.retention.hourly",
        SettingType.INT,
        24,
        "backups",
        "Hourly snapshots kept",
        min=_D(0),
        max=_D(1000),
    ),
    SettingDef(
        "backup.retention.daily",
        SettingType.INT,
        14,
        "backups",
        "Daily snapshots kept",
        min=_D(0),
        max=_D(1000),
    ),
    SettingDef(
        "backup.retention.monthly",
        SettingType.INT,
        12,
        "backups",
        "Monthly snapshots kept",
        min=_D(0),
        max=_D(1000),
    ),
    SettingDef(
        "backup.debounce_seconds",
        SettingType.INT,
        60,
        "backups",
        "Back up this long after a change",
        min=_D(30),
        max=_D(3600),
        level="advanced",
        unit="s",
    ),
    SettingDef(
        "backup.nightly_hours",
        SettingType.INT,
        24,
        "backups",
        "Back up at least every",
        min=_D(1),
        max=_D(168),
        level="advanced",
        unit="h",
    ),
    # -- diagnostics -----------------------------------------------------------
    SettingDef(
        "diagnostics.stale_grace_trading_days",
        SettingType.INT,
        2,
        "diagnostics",
        "Stale price warning after (trading days)",
        min=_D(1),
        max=_D(10),
    ),
    SettingDef(
        "diagnostics.mutual_fund_stale_grace_trading_days",
        SettingType.INT,
        4,
        "diagnostics",
        "Stale NAV warning after (trading days)",
        min=_D(1),
        max=_D(15),
    ),
    SettingDef(
        "diagnostics.frozen_leg_tolerance",
        SettingType.PERCENT,
        _D("0.005"),
        "diagnostics",
        "FX leg cross-check tolerance",
        min=_D("0.0001"),
        max=_D("0.1"),
        level="advanced",
    ),
    # -- system ----------------------------------------------------------------
    SettingDef(
        "log_level",
        SettingType.ENUM,
        "INFO",
        "system",
        "Log detail",
        help="DEBUG logs every data pull; switch back when done.",
        choices=LOG_LEVELS,
        level="advanced",
        env_var="log_level",
    ),
    # -- sign-in & sessions (ceilings: the app can only tighten the env value) ----
    SettingDef(
        "session_idle_minutes",
        SettingType.INT,
        30,
        "system",
        "Sign out after idle (minutes)",
        help="Can only be lower than the server's configured value.",
        min=_D(5),
        max=_D(1440),
        level="advanced",
        env_var="session_idle_minutes",
        env_bound="ceiling",
        unit="min",
    ),
    SettingDef(
        "session_max_age_days",
        SettingType.INT,
        30,
        "system",
        "Sign out at the latest after (days)",
        help="Can only be lower than the server's configured value.",
        min=_D(1),
        max=_D(365),
        level="advanced",
        env_var="session_max_age_days",
        env_bound="ceiling",
        unit="days",
    ),
    SettingDef(
        "fresh_session_minutes",
        SettingType.INT,
        10,
        "system",
        "Re-sign-in for sensitive actions after (minutes)",
        help="Passkey changes and backup downloads need a recent sign-in.",
        min=_D(1),
        max=_D(240),
        level="advanced",
        env_var="fresh_session_minutes",
        env_bound="ceiling",
        unit="min",
    ),
    SettingDef(
        "login_rate_limit_per_minute",
        SettingType.INT,
        5,
        "system",
        "Failed sign-ins allowed per minute",
        help="Per client address. Can only be lower than the server's value.",
        min=_D(1),
        max=_D(60),
        level="advanced",
        env_var="login_rate_limit_per_minute",
        env_bound="ceiling",
    ),
)

BY_KEY: dict[str, SettingDef] = {d.key: d for d in DEFS}


def get_def(key: str) -> SettingDef:
    try:
        return BY_KEY[key]
    except KeyError:
        raise SettingError(f"{key}: unknown setting") from None


# -- cross-field checks ----------------------------------------------------------

GroupCheck = Callable[[Mapping[str, Any]], dict[str, str]]


def _retention_sum(values: Mapping[str, Any]) -> dict[str, str]:
    keys = ("backup.retention.hourly", "backup.retention.daily", "backup.retention.monthly")
    if sum(int(values[k]) for k in keys) <= 0:
        return {k: "keep at least one snapshot in some bucket" for k in keys}
    return {}


def _tiingo_caps(values: Mapping[str, Any]) -> dict[str, str]:
    if int(values["tiingo_hourly_cap"]) > int(values["tiingo_daily_cap"]):
        msg = "the hourly cap cannot exceed the daily cap"
        return {"tiingo_hourly_cap": msg, "tiingo_daily_cap": msg}
    return {}


GROUP_CHECKS: tuple[GroupCheck, ...] = (_retention_sum, _tiingo_caps)


# -- live hooks ------------------------------------------------------------------


def _apply_log_level(value: Typed) -> None:
    from investment_dashboard.services import logging_service  # noqa: PLC0415

    if isinstance(value, str):
        logging_service._apply(value)


#: Called with the new effective value after a committed change.
ON_CHANGE: dict[str, Callable[[Typed], None]] = {"log_level": _apply_log_level}
