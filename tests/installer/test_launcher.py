"""Behavioural tests for the steady-state launcher's update flow."""

from __future__ import annotations

import importlib.util
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
    assert spec is not None and spec.loader is not None
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
