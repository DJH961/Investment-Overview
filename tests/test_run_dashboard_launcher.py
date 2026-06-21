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


def test_parse_requirement_extracts_name_and_bounds() -> None:
    assert run_dashboard._parse_requirement("nicegui>=3.12.0,<4") == (
        "nicegui",
        (3, 12, 0),
        (4, 0, 0),
    )
    assert run_dashboard._parse_requirement("fastapi>=0.110") == ("fastapi", (0, 110, 0), None)
    assert run_dashboard._parse_requirement("pydantic_settings>=2.14.2") == (
        "pydantic-settings",
        (2, 14, 2),
        None,
    )


def test_parse_requirement_returns_none_for_unnamed_entry() -> None:
    assert run_dashboard._parse_requirement("") is None
    assert run_dashboard._parse_requirement(">=1.0") is None


def test_parse_requirement_picks_tightest_constraints() -> None:
    assert run_dashboard._parse_requirement("nicegui>=3.12,<5,>=3.12.4,<4.1") == (
        "nicegui",
        (3, 12, 4),
        (4, 1, 0),
    )


def test_pyproject_requirements_cover_all_runtime_pins() -> None:
    names = {name for name, _lower, _upper in run_dashboard._pyproject_requirements()}
    # Every runtime dependency is validated, not just nicegui.
    assert {"nicegui", "fastapi", "uvicorn", "sqlalchemy", "cryptography"} <= names


def test_pyproject_requirements_fall_back_to_nicegui_when_unreadable(monkeypatch) -> None:
    def _raise() -> dict:
        raise RuntimeError("unreadable")

    monkeypatch.setattr(run_dashboard, "_read_pyproject", _raise)
    assert run_dashboard._pyproject_requirements() == [
        ("nicegui", run_dashboard.FALLBACK_MIN_NICEGUI, run_dashboard.FALLBACK_MAX_NICEGUI)
    ]


def test_version_problem_flags_outdated_install(monkeypatch) -> None:
    monkeypatch.setattr(run_dashboard.importlib_metadata, "version", lambda name: "2.6.0")
    problem = run_dashboard._version_problem("pandas", (2, 7, 0), None)
    assert problem is not None
    assert "pandas 2.6.0" in problem
    assert ">=2.7.0" in problem


def test_version_problem_flags_missing_install(monkeypatch) -> None:
    def _missing(name: str) -> str:
        raise run_dashboard.importlib_metadata.PackageNotFoundError(name)

    monkeypatch.setattr(run_dashboard.importlib_metadata, "version", _missing)
    problem = run_dashboard._version_problem("scipy", (1, 13, 0), None)
    assert problem is not None
    assert "scipy is not installed" in problem


def test_version_problem_accepts_satisfying_install(monkeypatch) -> None:
    monkeypatch.setattr(run_dashboard.importlib_metadata, "version", lambda name: "3.13.5")
    assert run_dashboard._version_problem("nicegui", (3, 12, 0), (4, 0, 0)) is None


def test_dependency_problems_report_outdated_dependency(monkeypatch) -> None:
    monkeypatch.setattr(run_dashboard, "REQUIRED_MODULES", ())
    monkeypatch.setattr(
        run_dashboard,
        "_pyproject_requirements",
        lambda: [("nicegui", (3, 12, 0), (4, 0, 0))],
    )
    monkeypatch.setattr(run_dashboard, "_installed_project_is_current", lambda: True)
    monkeypatch.setattr(run_dashboard.importlib_metadata, "version", lambda name: "2.10.0")

    problems = run_dashboard._dependency_problems()

    assert any("nicegui 2.10.0" in problem and ">=3.12.0,<4" in problem for problem in problems)


def test_dependency_check_rejects_stale_project_install(monkeypatch) -> None:
    monkeypatch.setattr(run_dashboard, "REQUIRED_MODULES", ())
    monkeypatch.setattr(run_dashboard, "_pyproject_requirements", lambda: [])
    monkeypatch.setattr(run_dashboard, "_project_version", lambda: "1.3.2")
    monkeypatch.setattr(run_dashboard.importlib_metadata, "version", lambda name: "1.3.1")

    assert not run_dashboard._current_python_has_dependencies()


def test_dependency_check_accepts_current_project_install(monkeypatch) -> None:
    monkeypatch.setattr(run_dashboard, "REQUIRED_MODULES", ())
    monkeypatch.setattr(run_dashboard, "_pyproject_requirements", lambda: [])
    monkeypatch.setattr(run_dashboard, "_project_version", lambda: "1.3.2")
    monkeypatch.setattr(run_dashboard.importlib_metadata, "version", lambda name: "1.3.2")

    assert run_dashboard._current_python_has_dependencies()


def test_startup_stops_existing_dashboard_instances(monkeypatch) -> None:
    terminated: list[int] = []
    monkeypatch.setattr(run_dashboard, "_existing_dashboard_process_ids", lambda: [123, 456])
    monkeypatch.setattr(run_dashboard, "_terminate_process_tree", terminated.append)

    run_dashboard._stop_existing_dashboard_instances()

    assert terminated == [123, 456]


def test_ensure_venv_has_pip_bootstraps_missing_pip(monkeypatch) -> None:
    calls: list[tuple[list[str], str]] = []
    monkeypatch.setattr(run_dashboard, "_venv_has_pip", lambda: False)
    monkeypatch.setattr(
        run_dashboard, "_run_checked", lambda args, step: calls.append((args, step))
    )

    run_dashboard._ensure_venv_has_pip()

    assert calls == [
        ([str(run_dashboard.VENV_PYTHON), "-m", "ensurepip", "--upgrade"], "pip bootstrap")
    ]


def test_ensure_venv_has_pip_skips_bootstrap_when_present(monkeypatch) -> None:
    calls: list[tuple[list[str], str]] = []
    monkeypatch.setattr(run_dashboard, "_venv_has_pip", lambda: True)
    monkeypatch.setattr(
        run_dashboard, "_run_checked", lambda args, step: calls.append((args, step))
    )

    run_dashboard._ensure_venv_has_pip()

    assert calls == []
