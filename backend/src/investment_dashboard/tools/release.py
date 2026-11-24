"""One-command release bump (lockstep versions, lockfiles, API contract, changelog).

Run from ``backend/``::

    uv run python -m investment_dashboard.tools.release 7.3.2 [--date 2026-11-25] [--dry-run]

It never commits, pushes or tags; it prints the remaining manual steps.
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]

_SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
_PYPROJECT_VERSION = re.compile(r'^version = "[^"]*"', re.MULTILINE)
_JSON_TOP_VERSION = re.compile(r'^(  "version": )"[^"]*"', re.MULTILINE)
_LOCK_ROOT_VERSION = re.compile(
    r'("packages": \{\s*"": \{.*?\n      "version": )"[^"]*"', re.DOTALL
)
_PLAN_STATUS = re.compile(r"(\*\*Status \()\d{4}-\d{2}-\d{2}(\): )\d+\.\d+\.\d+( is released)")
_CHANGELOG_HEADING = re.compile(r"^## \[")


class ReleaseError(Exception):
    """A refusal with a message meant for the person running the tool."""


def parse_version(text: str) -> tuple[int, int, int]:
    match = _SEMVER.match(text)
    if not match:
        raise ReleaseError(f"{text!r} is not a plain semver version (expected x.y.z).")
    major, minor, patch = match.groups()
    return int(major), int(minor), int(patch)


def validate_version(new: str, current: str) -> None:
    if parse_version(new) <= parse_version(current):
        raise ReleaseError(f"New version {new} must be greater than the current {current}.")


def read_pyproject_version(text: str) -> str:
    match = re.search(r'^version = "([^"]*)"', text, re.MULTILINE)
    if not match:
        raise ReleaseError("No version line found in backend/pyproject.toml.")
    return match.group(1)


def set_pyproject_version(text: str, version: str) -> str:
    return _PYPROJECT_VERSION.sub(f'version = "{version}"', text, count=1)


def set_package_json_version(text: str, version: str) -> str:
    return _JSON_TOP_VERSION.sub(rf'\1"{version}"', text, count=1)


def set_package_lock_version(text: str, version: str) -> str:
    text = _JSON_TOP_VERSION.sub(rf'\1"{version}"', text, count=1)
    return _LOCK_ROOT_VERSION.sub(rf'\1"{version}"', text, count=1)


def _strip_blank(lines: list[str]) -> list[str]:
    start, end = 0, len(lines)
    while start < end and not lines[start].strip():
        start += 1
    while end > start and not lines[end - 1].strip():
        end -= 1
    return lines[start:end]


def _section_end(lines: list[str], start: int) -> int:
    for i in range(start + 1, len(lines)):
        if _CHANGELOG_HEADING.match(lines[i]):
            return i
    return len(lines)


def fold_changelog(text: str, version: str, date: str) -> tuple[str, str | None]:
    """Fold ``## [Unreleased]`` into ``## [version] — date``.

    Returns the new text and a warning (or None). If a ``## [version]`` heading already
    exists the Unreleased entries are put at the top of that section instead.
    """
    lines = text.split("\n")
    try:
        u = next(i for i, ln in enumerate(lines) if ln.strip() == "## [Unreleased]")
    except StopIteration:
        raise ReleaseError("CHANGELOG.md has no '## [Unreleased]' heading.") from None
    u_end = _section_end(lines, u)
    pending = _strip_blank(lines[u + 1 : u_end])
    existing = next(
        (i for i, ln in enumerate(lines) if ln.startswith(f"## [{version}]")),
        None,
    )

    if existing is None:
        if not pending:
            return text, f"CHANGELOG.md: [Unreleased] is empty and no [{version}] section exists."
        head = lines[:u]
        tail = lines[u_end:]
        out = [*head, "## [Unreleased]", "", f"## [{version}] — {date}", "", *pending, ""]
        return "\n".join([*out, *tail]), None

    e_end = _section_end(lines, existing)
    current = _strip_blank(lines[existing + 1 : e_end])
    if not pending:
        warning = None
        if not current:
            warning = f"CHANGELOG.md: [Unreleased] and [{version}] are both empty."
        return text, warning
    merged = [*pending, "", *current] if current else pending
    new_section = [lines[existing], "", *merged, ""]
    if u < existing:
        out = [
            *lines[:u],
            "## [Unreleased]",
            "",
            *lines[u_end:existing],
            *new_section,
            *lines[e_end:],
        ]
    else:
        out = [
            *lines[:existing],
            *new_section,
            *lines[e_end:u],
            "## [Unreleased]",
            "",
            *lines[u_end:],
        ]
    return "\n".join(out), None


def update_plan_status(text: str, version: str, date: str) -> tuple[str, bool]:
    new, count = _PLAN_STATUS.subn(rf"\g<1>{date}\g<2>{version}\g<3>", text, count=1)
    return new, bool(count)


def _npm() -> str:
    return "npm.cmd" if sys.platform == "win32" else "npm"


def run(cmd: list[str], cwd: Path) -> None:
    print(f"$ ({cwd.name}) {' '.join(cmd)}")
    subprocess.run(cmd, cwd=cwd, check=True)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline="\n")


def release(root: Path, version: str, date: str, dry_run: bool) -> int:  # noqa: PLR0912
    backend, frontend, web = root / "backend", root / "frontend", root / "web"
    pyproject = backend / "pyproject.toml"
    current = read_pyproject_version(_read(pyproject))
    validate_version(version, current)
    parse_date = dt.date.fromisoformat(date)  # raises ValueError on a bad date
    date = parse_date.isoformat()

    edits: list[tuple[Path, str]] = []
    edits.append((pyproject, set_pyproject_version(_read(pyproject), version)))
    for pkg in (frontend, web):
        edits.append(
            (pkg / "package.json", set_package_json_version(_read(pkg / "package.json"), version))
        )
        lock = pkg / "package-lock.json"
        if lock.exists():
            edits.append((lock, set_package_lock_version(_read(lock), version)))
    changelog = root / "CHANGELOG.md"
    new_changelog, warning = fold_changelog(_read(changelog), version, date)
    edits.append((changelog, new_changelog))
    plan = root / "docs" / "v7_plan.md"
    plan_updated = False
    if plan.exists():
        new_plan, plan_updated = update_plan_status(_read(plan), version, date)
        edits.append((plan, new_plan))

    prefix = "[dry-run] would " if dry_run else ""
    print(f"{prefix}bump {current} -> {version} ({date})")
    changed: list[Path] = []
    for path, new_text in edits:
        if _read(path) != new_text:
            changed.append(path)
            print(f"{prefix}edit {path.relative_to(root).as_posix()}")
            if not dry_run:
                _write(path, new_text)

    commands: list[tuple[list[str], Path]] = [
        (["uv", "lock"], backend),
        ([_npm(), "install", "--package-lock-only", "--no-audit", "--no-fund"], frontend),
        ([_npm(), "install", "--package-lock-only", "--no-audit", "--no-fund"], web),
        (
            [
                "uv",
                "run",
                "python",
                "-m",
                "investment_dashboard.tools.export_openapi",
                "openapi.json",
            ],
            backend,
        ),
        ([_npm(), "run", "gen:api"], frontend),
    ]
    for cmd, cwd in commands:
        if dry_run:
            print(f"[dry-run] would run ({cwd.name}) {' '.join(cmd)}")
        else:
            run(cmd, cwd)

    if warning:
        print(f"WARNING: {warning}")
    if not plan_updated:
        print(
            "REMINDER: docs/v7_plan.md status line has no 'Status (date): x.y.z is released' "
            "pattern; update it by hand if it needs the new version."
        )
    elif not dry_run:
        print(
            "Updated the version and date in the docs/v7_plan.md status line; check the rest of it."
        )

    print("\nChanged files:" if not dry_run else "\nFiles that would change:")
    for path in changed:
        print(f"  {path.relative_to(root).as_posix()}")
    if not dry_run:
        print("  (plus lockfiles, backend/openapi.json, frontend/src/lib/api-types.ts if changed)")
    print(
        "\nRemaining manual steps: review `git diff`, commit, push, open/update the PR. "
        "This tool never commits, pushes or tags."
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bump the release version in lockstep.")
    parser.add_argument("version", help="new version, e.g. 7.3.2")
    parser.add_argument(
        "--date", default=dt.date.today().isoformat(), help="release date (YYYY-MM-DD)"
    )
    parser.add_argument("--dry-run", action="store_true", help="print the plan and run nothing")
    args = parser.parse_args(argv)
    try:
        return release(REPO_ROOT, args.version, args.date, args.dry_run)
    except (ReleaseError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        print(
            f"error: command failed ({exc.returncode}): {' '.join(map(str, exc.cmd))}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
