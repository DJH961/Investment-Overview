"""Tests for the double-click launcher bootstrap."""

from __future__ import annotations

import run_dashboard


def test_dependency_check_rejects_stale_project_install(monkeypatch) -> None:
    monkeypatch.setattr(run_dashboard, "REQUIRED_MODULES", ())
    monkeypatch.setattr(run_dashboard, "_nicegui_is_supported", lambda: True)
    monkeypatch.setattr(run_dashboard, "_project_version", lambda: "1.3.0")
    monkeypatch.setattr(run_dashboard.importlib_metadata, "version", lambda name: "1.2.1")

    assert not run_dashboard._current_python_has_dependencies()


def test_dependency_check_accepts_current_project_install(monkeypatch) -> None:
    monkeypatch.setattr(run_dashboard, "REQUIRED_MODULES", ())
    monkeypatch.setattr(run_dashboard, "_nicegui_is_supported", lambda: True)
    monkeypatch.setattr(run_dashboard, "_project_version", lambda: "1.3.0")
    monkeypatch.setattr(run_dashboard.importlib_metadata, "version", lambda name: "1.3.0")

    assert run_dashboard._current_python_has_dependencies()