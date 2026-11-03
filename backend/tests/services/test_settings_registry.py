"""The settings catalogue is well formed and its defaults match the code constants."""

from __future__ import annotations

from decimal import Decimal

from investment_dashboard.api import ops
from investment_dashboard.config import Settings
from investment_dashboard.domain import risk_extras
from investment_dashboard.domain.settings_schema import check_catalogue
from investment_dashboard.domain.tiingo_fallback import DESKTOP_DAILY_CAP, DESKTOP_HOURLY_CAP
from investment_dashboard.readmodels.live_graphs import GRAPH_RANGES
from investment_dashboard.readmodels.queries import projection_model, projection_query
from investment_dashboard.services import (
    auto_refresh,
    backup_service,
    benchmark_service,
    diagnostics_service,
    fx_service,
    import_staging,
    investing_power_service,
    prices_service,
    risk_free_service,
    scheduler,
    tiingo_fallback_wiring,
)
from investment_dashboard.services import settings_registry as reg


def _default(key: str) -> object:
    return reg.BY_KEY[key].default


def test_catalogue_is_well_formed() -> None:
    assert len(reg.BY_KEY) == len(reg.DEFS)
    assert check_catalogue(reg.BY_KEY, frozenset(reg.SECTIONS)) == []


def test_secret_keys_are_scrubbed_from_plain_backups() -> None:
    for d in reg.DEFS:
        if d.secret:
            assert any(w in d.key.lower() for w in ops._SECRET_KEY_WORDS), d.key


def test_defaults_match_code_constants() -> None:
    for cls, ttl in prices_service.REFRESH_TTL_SECONDS.items():
        assert _default(f"prices.ttl_seconds.{cls}") == ttl
    assert _default("prices.ttl_seconds.default") == prices_service._DEFAULT_TTL_SECONDS
    assert _default("scheduler.fx_interval_minutes") * 60 == scheduler.FX_INTERVAL.total_seconds()
    assert _default("backup.debounce_seconds") == backup_service.DEBOUNCE_SECONDS
    assert _default("backup.nightly_hours") * 3600 == backup_service.NIGHTLY_SECONDS
    retention = backup_service.Retention()
    assert _default("backup.retention.hourly") == retention.hourly
    assert _default("backup.retention.daily") == retention.daily
    assert _default("backup.retention.monthly") == retention.monthly
    assert _default("import.max_upload_mb") * 1024 * 1024 == import_staging.MAX_UPLOAD_BYTES
    assert _default("import.staging_ttl_minutes") * 60 == import_staging.TTL.total_seconds()
    assert (
        _default("diagnostics.stale_grace_trading_days")
        == diagnostics_service._STALE_GRACE_TRADING_DAYS
    )
    assert (
        _default("diagnostics.mutual_fund_stale_grace_trading_days")
        == diagnostics_service._MUTUAL_FUND_STALE_GRACE_TRADING_DAYS
    )
    assert _default("diagnostics.frozen_leg_tolerance") == diagnostics_service.FROZEN_LEG_TOLERANCE
    assert _default("projection.scenarios") == projection_query.DEFAULT_SCENARIOS
    assert _default("projection.fallback_rate") == projection_model.FALLBACK_EXPECTED_RATE
    assert _default("risk.var_alpha") == risk_extras.DEFAULT_VAR_ALPHA
    assert _default("fx.tracked_quotes") == fx_service.DEFAULT_QUOTES
    assert _default("tiingo.fetch_lookback_days") == tiingo_fallback_wiring._FETCH_LOOKBACK_DAYS
    assert _default("tiingo.write_lookback_days") == tiingo_fallback_wiring._WRITE_LOOKBACK_DAYS
    assert _default("tiingo_hourly_cap") == DESKTOP_HOURLY_CAP
    assert _default("tiingo_daily_cap") == DESKTOP_DAILY_CAP
    assert _default("live_refresh_interval_seconds") == auto_refresh.DEFAULT_INTERVAL_SECONDS
    assert reg.BY_KEY["live_refresh_interval_seconds"].min == auto_refresh.MIN_INTERVAL_SECONDS
    assert _default("investing_power.amount_eur") == investing_power_service.DEFAULT_AMOUNT_EUR
    assert _default("benchmark_symbol") == benchmark_service.DEFAULT_SYMBOL
    assert _default("risk_free_rate_symbol") == risk_free_service.DEFAULT_SYMBOL
    assert set(reg.GRAPH_RANGE_KEYS) == set(GRAPH_RANGES)
    assert isinstance(_default("risk.var_alpha"), Decimal)
    boot_settings = Settings.model_construct()
    for key in (
        "session_idle_minutes",
        "session_max_age_days",
        "fresh_session_minutes",
        "login_rate_limit_per_minute",
    ):
        assert _default(key) == getattr(boot_settings, key)
        assert reg.BY_KEY[key].env_bound == "ceiling"


def test_boot_constants() -> None:
    from investment_dashboard import boot

    assert _default("boot.backfill_days") == boot._BOOT_BACKFILL_DAYS
    assert _default("boot.warm_force_recent_days") == boot._WARM_FORCE_RECENT_DAYS


def test_regional_formats_are_independent_and_default_to_auto() -> None:
    from investment_dashboard.services.settings_registry import DEFS

    by_key = {d.key: d for d in DEFS}
    assert by_key["display.date_format"].default == "auto"
    assert by_key["display.number_format"].default == "auto"
    assert by_key["clock_format"].default == "auto"
    assert "YYYY-MM-DD" in (by_key["display.date_format"].choices or ())
    assert "1'234.56" in (by_key["display.number_format"].choices or ())
