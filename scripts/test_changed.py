"""Print (or run) the targeted tests for what you changed.

Usage (from the repo root)::

    uv run --project backend python scripts/test_changed.py [--base main] [--run]

It maps ``git diff --name-only <base>...HEAD`` plus uncommitted and untracked
files onto the "Testing for agents" table in AGENTS.md. :func:`plan` is the pure
mapping (file list in, commands out); the rest is git and subprocess plumbing.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
PKG = "backend/src/investment_dashboard/"

MIGRATION_TESTS = [
    "tests/test_migration_roundtrip.py",
    "tests/test_added_columns_guard.py",
]
STORAGE_TESTS = ["tests/storage", "tests/test_db_tiers.py", "tests/services/test_backup_*.py"]
_TEST_FILE = re.compile(r"(^|/)test_[^/]*\.py$|\.test\.tsx?$")


@dataclass(frozen=True)
class Command:
    """One command to run in ``cwd`` (relative to the repo root)."""

    cwd: str
    argv: tuple[str, ...]

    def __str__(self) -> str:
        return f"(cd {self.cwd} && {' '.join(self.argv)})"


@dataclass
class Plan:
    commands: list[Command] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _backend_targets(path: str, exists: Callable[[str], bool], tests: list[str]) -> list[str]:
    """Backend test targets (relative to ``backend/``) for one changed source file."""
    rel = path[len(PKG) :]
    parts = PurePosixPath(rel).parts
    layer, name = parts[0], PurePosixPath(rel).stem
    if layer == "domain":
        return ["tests/domain"]
    if layer in ("readmodels", "services"):
        if name == "__init__":
            return [f"tests/{layer}"]
        hits = [
            t
            for t in tests
            if t.startswith(f"backend/tests/{layer}/")
            and (PurePosixPath(t).stem == f"test_{name}" or PurePosixPath(t).stem.startswith(f"test_{name}_"))
        ]
        return sorted(h[len("backend/") :] for h in hits) or [f"tests/{layer}"]
    if layer == "api":
        if parts[1:2] == ("schemas",):
            return ["tests/api"]
        target = f"tests/api/test_{name}.py"
        return [target] if exists(f"backend/{target}") else ["tests/api"]
    if layer in ("models", "migrations") or name == "alembic":
        return list(MIGRATION_TESTS)
    if layer in ("storage",) or rel in ("db.py",):
        return list(STORAGE_TESTS)
    if layer == "adapters" and len(parts) > 2:
        target = f"tests/adapters/{parts[1]}"
        return [target] if exists(f"backend/{target}") else ["tests/adapters"]
    if layer == "adapters":
        return ["tests/adapters"]
    if layer == "repositories":
        return ["tests/repositories"]
    return []


def plan(
    changed: Iterable[str],
    *,
    base: str = "main",
    exists: Callable[[str], bool] = lambda p: (ROOT / p).exists(),
    tests: list[str] | None = None,
) -> Plan:
    """Map changed repo-relative paths to commands. Pure given ``exists``/``tests``.

    ``tests`` is the list of existing backend test files (repo-relative); when
    omitted it is read from disk.
    """
    if tests is None:
        tests = sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / "backend/tests").rglob("test_*.py"))
    out = Plan()
    pytest_targets: list[str] = []
    frontend = web = False
    contract = False

    for raw in sorted(set(changed)):
        path = raw.replace("\\", "/")
        if path.startswith(PKG) and path.endswith(".py"):
            pytest_targets += _backend_targets(path, exists, tests)
            if path.startswith(PKG + "api/") or path.startswith(PKG + "models/"):
                contract = contract or path.startswith(PKG + "api/")
        elif path.startswith("backend/alembic/") or path.startswith("backend/migrations/"):
            pytest_targets += MIGRATION_TESTS
        elif path.startswith("backend/tests/") and _TEST_FILE.search(path) and path.endswith(".py"):
            if exists(path):
                pytest_targets.append(path[len("backend/") :])
        elif path.startswith("frontend/src/"):
            frontend = True
        elif path.startswith("web/"):
            web = True

    if pytest_targets:
        unique = list(dict.fromkeys(pytest_targets))
        # Drop a file when its folder is already a target.
        unique = [t for t in unique if not any(t != d and t.startswith(d + "/") for d in unique)]
        out.commands.append(Command("backend", ("uv", "run", "pytest", *unique)))
    if contract:
        out.notes.append(
            "api/ changed: regenerate the contract (backend/openapi.json via "
            "`uv run python -m investment_dashboard.tools.export_openapi openapi.json` "
            "and frontend/src/lib/api-types.ts)."
        )
    if frontend:
        out.commands.append(Command("frontend", ("npm", "run", "typecheck")))
        out.commands.append(Command("frontend", ("npx", "vitest", "run", "--changed", base)))
    if web:
        out.commands.append(Command("web", ("npm", "run", "typecheck")))
        out.commands.append(Command("web", ("npm", "run", "test")))
    return out


def _git(*args: str) -> list[str]:
    res = subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=False
    )
    return [line for line in res.stdout.splitlines() if line.strip()]


def changed_files(base: str) -> list[str]:
    return [
        *_git("diff", "--name-only", f"{base}...HEAD"),
        *_git("diff", "--name-only", "HEAD"),
        *_git("ls-files", "--others", "--exclude-standard"),
    ]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default="main", help="git base to diff against (default: main)")
    ap.add_argument("--run", action="store_true", help="run the commands, then summarize")
    args = ap.parse_args(argv)

    result = plan(changed_files(args.base), base=args.base)
    if not result.commands:
        print("No test commands for the changed files.")
    for cmd in result.commands:
        print(cmd)
    for note in result.notes:
        print(f"NOTE: {note}")
    if not args.run:
        return 0

    summary: list[tuple[Command, int]] = []
    for cmd in result.commands:
        code = subprocess.run(  # noqa: S603
            list(cmd.argv), cwd=ROOT / cmd.cwd, check=False, shell=sys.platform == "win32"
        ).returncode
        summary.append((cmd, code))
    print("\n== summary ==")
    for cmd, code in summary:
        print(f"{'PASS' if code == 0 else 'FAIL'}  {cmd}")
    return 0 if all(code == 0 for _, code in summary) else 1


if __name__ == "__main__":
    raise SystemExit(main())
