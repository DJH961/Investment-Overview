"""Tests for the double-click launcher bootstrap."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType


def _load_launcher_module() -> ModuleType:
    path = Path(__file__).resolve().parents[1] / "run_dashboard.py"
    spec = importlib.util.spec_from_file_location("run_dashboard", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


run_dashboard = _load_launcher_module()


def test_dependency_check_rejects_stale_project_install(monkeypatch) -> None:
    monkeypatch.setattr(run_dashboard, "REQUIRED_MODULES", ())
    monkeypatch.setattr(run_dashboard, "_nicegui_is_supported", lambda: True)
    monkeypatch.setattr(run_dashboard, "_project_version", lambda: "1.3.1")
    monkeypatch.setattr(run_dashboard.importlib_metadata, "version", lambda name: "1.3.0")

    assert not run_dashboard._current_python_has_dependencies()


def test_dependency_check_accepts_current_project_install(monkeypatch) -> None:
    monkeypatch.setattr(run_dashboard, "REQUIRED_MODULES", ())
    monkeypatch.setattr(run_dashboard, "_nicegui_is_supported", lambda: True)
    monkeypatch.setattr(run_dashboard, "_project_version", lambda: "1.3.1")
    monkeypatch.setattr(run_dashboard.importlib_metadata, "version", lambda name: "1.3.1")

    assert run_dashboard._current_python_has_dependencies()


def test_startup_stops_existing_dashboard_instances(monkeypatch) -> None:
    terminated: list[int] = []
    monkeypatch.setattr(run_dashboard, "_existing_dashboard_process_ids", lambda: [123, 456])
    monkeypatch.setattr(run_dashboard, "_terminate_process_tree", terminated.append)

    run_dashboard._stop_existing_dashboard_instances()

    assert terminated == [123, 456]
