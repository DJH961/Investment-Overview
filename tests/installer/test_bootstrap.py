"""Unit tests for the bundled-wheel install path in the bootstrapper.

The repository is private, so the original "fetch latest release from
GitHub" install path returns HTTP 404 to the unauthenticated installer
running on an end-user's machine. The release workflow now bundles the
freshly built wheel into ``InvestmentDashboard-Setup.exe`` and the
bootstrapper installs from that wheel directly. These tests pin that
contract.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from installer import bootstrap


def _touch_wheel(directory: Path, version: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    wheel = directory / f"investment_dashboard-{version}-py3-none-any.whl"
    wheel.write_bytes(b"")
    return wheel


def test_bundled_wheel_finds_meipass_payload(tmp_path, monkeypatch) -> None:
    """When PyInstaller extracts the bundle, the wheel sits under ``_MEIPASS``."""
    wheel = _touch_wheel(tmp_path / "bundled_wheels", "2.1.4")
    monkeypatch.setattr(bootstrap.sys, "_MEIPASS", str(tmp_path), raising=False)

    assert bootstrap.bundled_wheel() == wheel


def test_bundled_wheel_falls_back_to_repo_dist(tmp_path, monkeypatch) -> None:
    """Developers running the bootstrap from a checkout get the dev wheel."""
    monkeypatch.delattr(bootstrap.sys, "_MEIPASS", raising=False)
    # Pretend ``bootstrap.py`` lives at ``<tmp>/installer/bootstrap.py``
    # so the helper's "repo root / dist" candidate resolves to ``tmp/dist``.
    fake_module = tmp_path / "installer" / "bootstrap.py"
    fake_module.parent.mkdir(parents=True)
    fake_module.write_text("")
    monkeypatch.setattr(bootstrap, "__file__", str(fake_module))

    wheel = _touch_wheel(tmp_path / "dist", "9.9.9")
    assert bootstrap.bundled_wheel() == wheel


def test_bundled_wheel_returns_none_when_no_wheel_present(tmp_path, monkeypatch) -> None:
    monkeypatch.delattr(bootstrap.sys, "_MEIPASS", raising=False)
    fake_module = tmp_path / "installer" / "bootstrap.py"
    fake_module.parent.mkdir(parents=True)
    fake_module.write_text("")
    monkeypatch.setattr(bootstrap, "__file__", str(fake_module))

    assert bootstrap.bundled_wheel() is None


def test_wheel_tag_prefixes_v_to_version() -> None:
    wheel = Path("investment_dashboard-2.1.4-py3-none-any.whl")
    assert bootstrap._wheel_tag(wheel) == "v2.1.4"


def test_install_latest_dashboard_prefers_bundled_wheel(tmp_path, monkeypatch) -> None:
    """A bundled wheel must short-circuit any GitHub network access."""
    wheel = _touch_wheel(tmp_path / "wheels", "2.1.4")
    monkeypatch.setattr(bootstrap, "bundled_wheel", lambda: wheel)

    def _fail_resolve(*_: object, **__: object) -> tuple[str, str | None]:
        raise AssertionError("resolve_latest_release must not run when a wheel is bundled")

    monkeypatch.setattr(bootstrap, "resolve_latest_release", _fail_resolve)

    calls: list[list[str]] = []

    def _fake_check_call(cmd, *args, **kwargs) -> int:
        calls.append(list(cmd))
        return 0

    monkeypatch.setattr(bootstrap.subprocess, "check_call", _fake_check_call)

    install_root = tmp_path / "install"
    tag = bootstrap.install_latest_dashboard(install_root)

    assert tag == "v2.1.4"
    assert len(calls) == 1
    assert calls[0][1:] == ["-m", "pip", "install", "--upgrade", str(wheel)]


def test_install_latest_dashboard_falls_back_to_github_when_no_wheel(tmp_path, monkeypatch) -> None:
    """Without a bundled wheel we fall back to the existing GitHub flow."""
    monkeypatch.setattr(bootstrap, "bundled_wheel", lambda: None)
    monkeypatch.setattr(
        bootstrap,
        "resolve_latest_release",
        lambda timeout: ("v2.1.4", "https://example.invalid/wheel.whl"),
    )

    calls: list[list[str]] = []

    def _fake_check_call(cmd, *args, **kwargs) -> int:
        calls.append(list(cmd))
        return 0

    monkeypatch.setattr(bootstrap.subprocess, "check_call", _fake_check_call)

    tag = bootstrap.install_latest_dashboard(tmp_path / "install")
    assert tag == "v2.1.4"
    assert calls[0][-1] == "https://example.invalid/wheel.whl"


@pytest.mark.parametrize(
    "version_in_name",
    ["2.1.4", "2.1.4.post1", "2.2.0rc1"],
)
def test_wheel_tag_handles_pep440_qualifiers(version_in_name: str) -> None:
    wheel = Path(f"investment_dashboard-{version_in_name}-py3-none-any.whl")
    assert bootstrap._wheel_tag(wheel) == f"v{version_in_name}"


def test_write_launcher_copies_from_meipass(tmp_path, monkeypatch) -> None:
    """Under PyInstaller the launcher source must be readable from ``_MEIPASS``.

    Regression test for the ``FileNotFoundError: [WinError 3]`` that
    ``InvestmentDashboard-Setup.exe`` raised when ``installer/launcher.py``
    was not bundled as a data file in ``installer/installer.spec``.
    """
    meipass = tmp_path / "meipass"
    (meipass / "installer").mkdir(parents=True)
    (meipass / "installer" / "launcher.py").write_text("# launcher payload\n")
    monkeypatch.setattr(bootstrap.sys, "_MEIPASS", str(meipass), raising=False)

    install_root = tmp_path / "install"
    install_root.mkdir()
    bootstrap.write_launcher(install_root)

    copied = install_root / "launcher.py"
    assert copied.is_file()
    assert copied.read_text() == "# launcher payload\n"


def test_write_launcher_falls_back_to_repo_checkout(tmp_path, monkeypatch) -> None:
    """Outside the frozen build the launcher is resolved relative to the package."""
    monkeypatch.delattr(bootstrap.sys, "_MEIPASS", raising=False)

    install_root = tmp_path / "install"
    install_root.mkdir()
    bootstrap.write_launcher(install_root)

    copied = install_root / "launcher.py"
    assert copied.is_file()
    # Sanity check: the real launcher module header is present.
    assert "launcher" in copied.read_text().lower()
