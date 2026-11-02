"""settings_service: precedence, all-or-nothing writes, audit, cache, import/export."""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path

import pytest

from investment_dashboard.config import get_settings
from investment_dashboard.db import config_session_scope, dispose_engines, get_ledger_engine
from investment_dashboard.models import ALL_METADATAS
from investment_dashboard.repositories import app_config_repo, settings_audit_repo
from investment_dashboard.services import (
    app_config_service,
    auto_refresh,
    live_bus,
    logging_service,
    settings_service,
    theme_service,
)
from investment_dashboard.services.settings_service import SettingsValidationError


@pytest.fixture
def settings_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    db = tmp_path / "app.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db))
    for tier in ("LEDGER", "CONFIG", "CACHE"):
        monkeypatch.delenv(f"INV_DASHBOARD_{tier}_PATH", raising=False)
    monkeypatch.delenv("INV_DASHBOARD_TIINGO_TOKEN", raising=False)
    monkeypatch.delenv("INV_DASHBOARD_LOG_LEVEL", raising=False)
    get_settings.cache_clear()
    dispose_engines()
    engine = get_ledger_engine()
    for metadata in ALL_METADATAS:
        metadata.create_all(engine)
    settings_service.invalidate()
    try:
        yield db
    finally:
        settings_service.invalidate()
        dispose_engines()
        get_settings.cache_clear()


def test_defaults_without_rows(settings_db: Path) -> None:
    assert settings_service.get("backup.retention.daily") == 14
    eff = settings_service.effective("risk.var_alpha")
    assert eff.source == "default"
    assert eff.value == Decimal("0.05")


def test_precedence_db_over_env_over_default(
    settings_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("INV_DASHBOARD_LOG_LEVEL", "DEBUG")
    get_settings.cache_clear()
    assert settings_service.effective("log_level").source == "env"
    assert settings_service.get("log_level") == "DEBUG"
    settings_service.set_many({"log_level": "WARNING"}, actor="test")
    eff = settings_service.effective("log_level")
    assert (eff.value, eff.source, eff.env_value_present) == ("WARNING", "db", True)
    settings_service.reset(keys=["log_level"], actor="test")
    assert settings_service.get("log_level") == "DEBUG"


def test_set_many_is_all_or_nothing(settings_db: Path) -> None:
    with pytest.raises(SettingsValidationError) as err:
        settings_service.set_many(
            {"backup.retention.daily": 7, "backup.debounce_seconds": 1, "nope": 1}, actor="t"
        )
    assert set(err.value.errors) == {"backup.debounce_seconds", "nope"}
    assert settings_service.get("backup.retention.daily") == 14


def test_group_check_blocks_zero_retention(settings_db: Path) -> None:
    with pytest.raises(SettingsValidationError) as err:
        settings_service.set_many(
            {
                "backup.retention.hourly": 0,
                "backup.retention.daily": 0,
                "backup.retention.monthly": 0,
            },
            actor="t",
        )
    assert "backup.retention.daily" in err.value.errors
    # Unrelated edits are not blocked.
    settings_service.set_many({"backup.retention.hourly": 0}, actor="t")


def test_audit_rows_and_secret_redaction(settings_db: Path) -> None:
    settings_service.set_many(
        {"tiingo.api_token": "very-secret-token-value", "theme": "dark"},
        actor="session:abcd1234",
        request_id="req-1",
    )
    rows = settings_service.history()
    by_key = {r.key: r for r in rows}
    assert by_key["tiingo.api_token"].new_value == settings_service.REDACTED
    assert by_key["theme"].new_value == "dark"
    assert by_key["theme"].actor == "session:abcd1234"
    with config_session_scope() as s:
        values = settings_service.values(s)
    assert values["tiingo.api_token"]["value"] is None
    assert values["tiingo.api_token"]["is_set"] is True
    assert values["theme"]["modified_at"] is not None
    assert "tiingo.api_token" not in settings_service.export_json()["settings"]
    # Secret is readable by code, never by views.
    assert settings_service.get("tiingo.api_token") == "very-secret-token-value"
    with pytest.raises(SettingsValidationError):
        settings_service.revert(by_key["tiingo.api_token"].id, actor="t")


def test_legacy_services_read_the_same_rows(settings_db: Path) -> None:
    settings_service.set_many(
        {"theme": "light", "live_refresh_interval_seconds": 120, "chart_pref.calc.rebalance": True},
        actor="t",
    )
    with config_session_scope() as s:
        assert theme_service.get_theme(s) is False
        assert auto_refresh.get_interval_seconds(s) == 120
        assert app_config_repo.get(s, "chart_pref.calc.rebalance") == "1"
        theme_service.set_theme(s, True)
    assert settings_service.get("theme") == "dark"


def test_cache_invalidates_on_write(settings_db: Path) -> None:
    assert settings_service.get("backup.retention.daily") == 14
    with config_session_scope() as s:
        app_config_service.set_value(s, "backup.retention.daily", "9")
    assert settings_service.get("backup.retention.daily") == 9


def test_invalid_stored_row_falls_back(settings_db: Path) -> None:
    with config_session_scope() as s:
        app_config_repo.set_value(s, "backup.retention.daily", "lots")
    settings_service.invalidate()
    eff = settings_service.effective("backup.retention.daily")
    assert (eff.value, eff.source, eff.stored_invalid) == (14, "default", True)


def test_revert_and_reset_section(settings_db: Path) -> None:
    settings_service.set_many({"backup.retention.daily": 7}, actor="t")
    settings_service.set_many({"backup.retention.daily": 8}, actor="t")
    latest = settings_service.history(key="backup.retention.daily")[0]
    settings_service.revert(latest.id, actor="t")
    assert settings_service.get("backup.retention.daily") == 7
    assert settings_service.history(limit=1)[0].action == "revert"
    settings_service.reset(section="backups", actor="t")
    assert settings_service.effective("backup.retention.daily").source == "default"


def test_export_import_round_trip(settings_db: Path) -> None:
    settings_service.set_many({"projection.scenarios": ["0.03", "0.06"]}, actor="t")
    payload = settings_service.export_json()
    assert payload["settings"] == {"projection.scenarios": ["0.03", "0.06"]}
    settings_service.reset(everything=True, actor="t")
    diff = settings_service.import_json(payload, dry_run=True, actor="t")
    assert diff[0]["key"] == "projection.scenarios"
    assert settings_service.effective("projection.scenarios").source == "default"
    settings_service.import_json(payload, dry_run=False, actor="t")
    assert settings_service.get("projection.scenarios") == (Decimal("0.03"), Decimal("0.06"))
    with pytest.raises(SettingsValidationError):
        settings_service.import_json({"kind": "x"}, dry_run=True, actor="t")


def test_change_publishes_event_and_runs_hook(
    settings_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    applied: list[str] = []
    monkeypatch.setattr(logging_service, "_apply", applied.append)
    events: list[dict[str, object]] = []
    monkeypatch.setattr(live_bus.bus, "publish", events.append)
    settings_service.set_many({"log_level": "DEBUG"}, actor="t")
    assert applied == ["DEBUG"]
    assert events
    assert events[0]["type"] == "settings"
    # No-op writes leave no audit row.
    settings_service.set_many({"log_level": "DEBUG"}, actor="t")
    assert len(settings_service.history(key="log_level")) == 1


def test_audit_prune_keeps_newest(settings_db: Path) -> None:
    from datetime import datetime

    with config_session_scope() as s:
        for i in range(5):
            settings_audit_repo.add(
                s,
                key="k",
                old_value=None,
                new_value=str(i),
                changed_at=datetime(2026, 1, 1),
                actor="t",
                action="set",
            )
        assert settings_audit_repo.prune(s, keep=2) == 3
        assert [r.new_value for r in settings_audit_repo.history(s)] == ["4", "3"]


def test_cli_reset(settings_db: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from investment_dashboard.tools import settings_cli

    settings_service.set_many({"backup.retention.daily": 3}, actor="t")
    assert settings_cli.main(["get", "backup.retention.daily"]) == 0
    assert "3" in capsys.readouterr().out
    assert settings_cli.main(["reset", "backup.retention.daily"]) == 0
    assert settings_service.get("backup.retention.daily") == 14
    assert settings_cli.main(["reset"]) == 2
    assert settings_cli.main(["list"]) == 0
    assert "<not set>" in capsys.readouterr().out
