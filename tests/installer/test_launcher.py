"""Behavioural tests for the steady-state launcher's update flow."""

from __future__ import annotations

import builtins
import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType

import pytest

from installer import launcher

_LAUNCHER_SOURCE = Path(launcher.__file__).resolve()


def _load_launcher_standalone(module_name: str) -> ModuleType:
    """Load ``installer/launcher.py`` by path with the ``installer`` package blocked.

    ``installer.bootstrap.write_launcher`` copies *only* ``launcher.py`` into
    the user's install root — the ``installer`` package is never installed
    next to the dashboard wheel. Setting ``sys.modules['installer'] = None``
    forces any ``import installer`` to raise ``ModuleNotFoundError`` so this
    test fails loudly if the launcher ever regains a dependency on the
    package (the root cause of the "installed program does not start" bug).
    """
    spec = importlib.util.spec_from_file_location(module_name, _LAUNCHER_SOURCE)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_launcher_imports_without_installer_package(monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "installer", None)
    monkeypatch.setitem(sys.modules, "installer.paths", None)
    monkeypatch.setitem(sys.modules, "installer.version", None)

    standalone = _load_launcher_standalone("standalone_launcher")

    # The inlined helpers must be present and behave like the originals.
    assert standalone.PROJECT_NAME == "investment-dashboard"
    assert standalone.is_newer("v2.2.0", "2.1.0") is True
    assert standalone.pip_install_target("v2.1.0", None).endswith("v2.1.0.tar.gz")
    assert standalone.version_state_path(Path("/x")) == Path("/x") / "installed_version.txt"


def test_pip_install_target_prefers_wheel_url() -> None:
    assert launcher.pip_install_target("v2.1.0", "https://example/wheel") == "https://example/wheel"


def test_pip_install_target_falls_back_to_tarball() -> None:
    target = launcher.pip_install_target("v2.1.0", None)
    assert target.endswith("v2.1.0.tar.gz")


def test_maybe_update_skips_when_environment_flag_set(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("INV_DASHBOARD_SKIP_UPDATE_CHECK", "1")
    called: list[str] = []
    monkeypatch.setattr(launcher, "fetch_latest_release", lambda: called.append("fetch") or None)
    assert launcher.maybe_update(tmp_path) is None
    assert called == []


def test_maybe_update_skips_when_already_current(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("INV_DASHBOARD_SKIP_UPDATE_CHECK", raising=False)
    monkeypatch.setattr(launcher, "installed_version", lambda: "2.1.0")
    monkeypatch.setattr(launcher, "fetch_latest_release", lambda: ("v2.1.0", None))

    def _refuse_install(*_: object, **__: object) -> None:
        raise AssertionError("pip install must not run when versions match")

    monkeypatch.setattr(launcher, "run_pip_install", _refuse_install)
    assert launcher.maybe_update(tmp_path) is None


def test_maybe_update_installs_newer_release(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("INV_DASHBOARD_SKIP_UPDATE_CHECK", raising=False)
    monkeypatch.setattr(launcher, "installed_version", lambda: "2.0.0")
    monkeypatch.setattr(
        launcher,
        "fetch_latest_release",
        lambda: ("v2.1.0", "https://example/wheel"),
    )
    captured: dict[str, object] = {}

    def _record(python_exe: Path, target: str) -> None:
        captured["python_exe"] = python_exe
        captured["target"] = target

    monkeypatch.setattr(launcher, "run_pip_install", _record)

    assert launcher.maybe_update(tmp_path) == "v2.1.0"
    assert captured["target"] == "https://example/wheel"
    assert (tmp_path / "installed_version.txt").read_text(encoding="utf-8") == "v2.1.0"


def test_maybe_update_swallows_pip_failures(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("INV_DASHBOARD_SKIP_UPDATE_CHECK", raising=False)
    monkeypatch.setattr(launcher, "installed_version", lambda: "2.0.0")
    monkeypatch.setattr(launcher, "fetch_latest_release", lambda: ("v2.1.0", None))

    def _boom(*_: object, **__: object) -> None:
        raise OSError("network down")

    monkeypatch.setattr(launcher, "run_pip_install", _boom)
    assert launcher.maybe_update(tmp_path) is None


def test_maybe_update_returns_none_when_release_payload_unavailable(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("INV_DASHBOARD_SKIP_UPDATE_CHECK", raising=False)
    monkeypatch.setattr(launcher, "fetch_latest_release", lambda: None)
    assert launcher.maybe_update(tmp_path) is None


def test_maybe_update_handles_malformed_payload(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("INV_DASHBOARD_SKIP_UPDATE_CHECK", raising=False)
    # Resolver propagates ValueError on garbage payloads, which fetch_latest_release
    # turns into None; the launcher must skip the update quietly.
    monkeypatch.setattr(launcher, "fetch_latest_release", lambda: None)
    assert launcher.maybe_update(tmp_path) is None


def test_default_install_root_honours_override(monkeypatch, tmp_path: Path) -> None:
    from installer.paths import default_install_root

    monkeypatch.setenv("INV_DASHBOARD_INSTALL_ROOT", str(tmp_path))
    assert default_install_root() == tmp_path


@pytest.mark.parametrize("env_value", ["1", "yes", "true"])
def test_skip_env_values_are_truthy(monkeypatch, tmp_path: Path, env_value: str) -> None:
    monkeypatch.setenv("INV_DASHBOARD_SKIP_UPDATE_CHECK", env_value)
    monkeypatch.setattr(
        launcher,
        "fetch_latest_release",
        lambda: pytest.fail("should not be called"),
    )
    assert launcher.maybe_update(tmp_path) is None


def test_install_diagnostics_writes_log_and_redirects(monkeypatch, tmp_path: Path) -> None:
    # Pretend we are launched via pythonw.exe (no console streams).
    monkeypatch.setattr(launcher, "_ORIGINAL_STDOUT", None)
    monkeypatch.setattr(launcher, "_ORIGINAL_STDERR", None)
    saved_out, saved_err = sys.stdout, sys.stderr
    try:
        stream = launcher.install_diagnostics(tmp_path)
        assert stream is not None
        print("output from the running app")
        sys.stderr.write("an error line\n")
    finally:
        sys.stdout, sys.stderr = saved_out, saved_err
        if stream is not None:
            stream.close()

    log = launcher.diagnostics_log_path(tmp_path).read_text(encoding="utf-8")
    assert "Investment Dashboard launcher started" in log
    assert "python executable" in log
    assert "output from the running app" in log
    assert "an error line" in log


def test_install_diagnostics_debug_env_sets_log_level(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("INV_DASHBOARD_LOG_LEVEL", raising=False)
    monkeypatch.setenv("INV_DASHBOARD_LAUNCHER_DEBUG", "1")
    saved_out, saved_err = sys.stdout, sys.stderr
    try:
        stream = launcher.install_diagnostics(tmp_path)
    finally:
        sys.stdout, sys.stderr = saved_out, saved_err
        if stream is not None:
            stream.close()
    assert os.environ["INV_DASHBOARD_LOG_LEVEL"] == "DEBUG"


def test_install_diagnostics_returns_none_when_log_unwritable(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(launcher, "_open_log_stream", lambda _root: None)
    saved_out, saved_err = sys.stdout, sys.stderr
    stream = launcher.install_diagnostics(tmp_path)
    assert stream is None
    # Streams are left untouched so the launcher still runs without a log.
    assert sys.stdout is saved_out
    assert sys.stderr is saved_err


def test_start_dashboard_logs_import_failure(monkeypatch, capsys) -> None:
    real_import = builtins.__import__

    def _fake_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "investment_dashboard.main":
            raise ModuleNotFoundError("no dashboard here")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _fake_import)
    assert launcher.start_dashboard() == 1
    captured = capsys.readouterr()
    assert "Failed to import the dashboard application" in captured.out
    assert "no dashboard here" in captured.out + captured.err


def test_start_dashboard_logs_run_failure(monkeypatch, capsys) -> None:
    fake_main = ModuleType("investment_dashboard.main")

    def _boom() -> None:
        raise RuntimeError("port already in use")

    fake_main.run = _boom  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "investment_dashboard.main", fake_main)
    assert launcher.start_dashboard() == 1
    captured = capsys.readouterr()
    assert "crashed while starting" in captured.out
    assert "port already in use" in captured.out + captured.err
