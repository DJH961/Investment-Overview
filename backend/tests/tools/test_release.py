"""``release``: version validation, changelog folding and the file edits."""

from __future__ import annotations

from pathlib import Path

import pytest

from investment_dashboard.tools import release

CHANGELOG_NEW = """# Changelog

## [Unreleased]

### Fixed
- Something.

## [1.0.0] — 2026-01-01

### Added
- Old.
"""

CHANGELOG_NEW_DONE = """# Changelog

## [Unreleased]

## [1.0.1] — 2026-02-02

### Fixed
- Something.

## [1.0.0] — 2026-01-01

### Added
- Old.
"""

CHANGELOG_EXISTING = """# Changelog

## [Unreleased]

### Fixed
- Late fix.

## [1.0.1] — 2026-02-01

### Fixed
- Early fix.

## [1.0.0] — 2026-01-01
"""

CHANGELOG_EXISTING_DONE = """# Changelog

## [Unreleased]

## [1.0.1] — 2026-02-01

### Fixed
- Late fix.

### Fixed
- Early fix.

## [1.0.0] — 2026-01-01
"""

LOCK = """{
  "name": "x",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "x",
      "version": "1.0.0",
      "dependencies": {
        "dep": "^1.0.0"
      }
    },
    "node_modules/dep": {
      "version": "1.0.0"
    }
  }
}
"""


def test_version_validation() -> None:
    release.validate_version("1.0.1", "1.0.0")
    release.validate_version("1.10.0", "1.9.9")
    for bad in ("1.0.0", "0.9.9", "1.0", "v1.0.1", "1.0.1-rc1"):
        with pytest.raises(release.ReleaseError):
            release.validate_version(bad, "1.0.0")


def test_changelog_new_heading() -> None:
    out, warning = release.fold_changelog(CHANGELOG_NEW, "1.0.1", "2026-02-02")
    assert out == CHANGELOG_NEW_DONE
    assert warning is None


def test_changelog_existing_heading_is_folded() -> None:
    out, warning = release.fold_changelog(CHANGELOG_EXISTING, "1.0.1", "2026-02-02")
    assert out == CHANGELOG_EXISTING_DONE
    assert warning is None


def test_changelog_both_empty_warns() -> None:
    text = "# C\n\n## [Unreleased]\n\n## [1.0.0] — 2026-01-01\n\n- x\n"
    out, warning = release.fold_changelog(text, "1.0.1", "2026-02-02")
    assert out == text
    assert warning is not None


def test_pyproject_and_package_edits() -> None:
    assert release.read_pyproject_version('[project]\nname = "a"\nversion = "1.0.0"\n') == "1.0.0"
    py = 'name = "a"\nversion = "1.0.0"\ntarget-version = "py312"\n'
    assert release.set_pyproject_version(py, "1.0.1") == (
        'name = "a"\nversion = "1.0.1"\ntarget-version = "py312"\n'
    )
    pkg = '{\n  "name": "x",\n  "version": "1.0.0",\n  "dependencies": {"v": "1.0.0"}\n}\n'
    assert '"version": "1.0.1"' in release.set_package_json_version(pkg, "1.0.1")
    lock = release.set_package_lock_version(LOCK, "1.0.1")
    assert lock == LOCK.replace(
        '"version": "1.0.0",\n  "lock', '"version": "1.0.1",\n  "lock'
    ).replace('      "version": "1.0.0",\n      "dep', '      "version": "1.0.1",\n      "dep')
    assert '"node_modules/dep": {\n      "version": "1.0.0"' in lock


def test_plan_status() -> None:
    text = "> **Status (2026-11-23): 7.3.0 is released from `x`.**\n"
    out, ok = release.update_plan_status(text, "7.3.2", "2026-11-25")
    assert ok
    assert out == "> **Status (2026-11-25): 7.3.2 is released from `x`.**\n"
    same, ok = release.update_plan_status("no status here", "7.3.2", "2026-11-25")
    assert not ok
    assert same == "no status here"


def _make_repo(root: Path) -> None:
    (root / "backend").mkdir()
    (root / "docs").mkdir()
    (root / "backend" / "pyproject.toml").write_text('version = "1.0.0"\n', encoding="utf-8")
    for name in ("frontend", "web"):
        (root / name).mkdir()
        (root / name / "package.json").write_text('{\n  "version": "1.0.0"\n}\n', encoding="utf-8")
        (root / name / "package-lock.json").write_text(LOCK, encoding="utf-8")
    (root / "CHANGELOG.md").write_text(CHANGELOG_NEW, encoding="utf-8")
    (root / "docs" / "v7_plan.md").write_text(
        "> **Status (2026-01-01): 1.0.0 is released.**\n", encoding="utf-8"
    )


def test_release_end_to_end(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _make_repo(tmp_path)
    calls: list[tuple[list[str], str]] = []
    monkeypatch.setattr(release, "run", lambda cmd, cwd: calls.append((cmd, cwd.name)))
    assert release.release(tmp_path, "1.0.1", "2026-02-02", dry_run=False) == 0
    assert 'version = "1.0.1"' in (tmp_path / "backend" / "pyproject.toml").read_text(
        encoding="utf-8"
    )
    assert '"version": "1.0.1"' in (tmp_path / "web" / "package.json").read_text(encoding="utf-8")
    assert (tmp_path / "CHANGELOG.md").read_text(encoding="utf-8") == CHANGELOG_NEW_DONE
    assert [c[1] for c in calls] == ["backend", "frontend", "web", "backend", "frontend"]
    assert calls[0][0] == ["uv", "lock"]


def test_dry_run_changes_and_runs_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _make_repo(tmp_path)
    calls: list[object] = []
    monkeypatch.setattr(release, "run", lambda cmd, cwd: calls.append(cmd))
    assert release.release(tmp_path, "1.0.1", "2026-02-02", dry_run=True) == 0
    assert calls == []
    assert (tmp_path / "backend" / "pyproject.toml").read_text(
        encoding="utf-8"
    ) == 'version = "1.0.0"\n'
    assert (tmp_path / "CHANGELOG.md").read_text(encoding="utf-8") == CHANGELOG_NEW


def test_main_refuses_lower_version(capsys: pytest.CaptureFixture[str]) -> None:
    assert release.main(["0.0.1", "--dry-run"]) == 2
    assert "must be greater" in capsys.readouterr().err
