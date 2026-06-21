"""Public-readiness guard (proposal §7.5).

This repository is **public**, so every tracked file is world-readable. The
§7.5 checklist is otherwise a manual ritual; this test turns the "no secrets or
real data files are tracked" items into a regression that fails fast in CI if
such a file is ever committed.

It deliberately does **not** flag the anonymized synthetic fixtures under
``docs/Comparison Files/`` (those are intentionally tracked) — it only catches
files that must never be in the tree: ``.env`` files, local databases, private
keys, and the un-fakeable real master workbook removed in §7.1.
"""

from __future__ import annotations

import subprocess
from fnmatch import fnmatch
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[1]

#: Suffixes that mark a committed ``.env.*`` as a safe, secret-free template.
_ENV_TEMPLATE_SUFFIXES = (".example", ".sample", ".template", ".dist")

#: Glob patterns (matched against the POSIX repo-relative path or its basename)
#: that must never appear in the tracked tree once public.
_FORBIDDEN: tuple[tuple[str, str], ...] = (
    (".env", "environment files may contain secrets"),
    (".env.*", "environment files may contain secrets"),
    ("*.pem", "private keys must never be committed"),
    ("*.key", "private keys must never be committed"),
    ("id_rsa", "SSH private keys must never be committed"),
    ("*.sqlite", "local databases must never be committed"),
    ("*.sqlite-*", "local database sidecars must never be committed"),
    ("db.sqlite*", "local databases must never be committed"),
    # The real personal workbook was removed as un-fakeable (§7.1).
    ("docs/Comparison Files/Investments.xlsx", "real financial workbook (§7.1)"),
)


def _is_safe_env_template(base: str) -> bool:
    """Allow secret-free ``.env`` templates (``.env.example`` and friends)."""
    return base.startswith(".env") and base.endswith(_ENV_TEMPLATE_SUFFIXES)


def _tracked_files() -> list[str]:
    try:
        out = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=_REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):  # pragma: no cover - non-git checkout
        pytest.skip("not a git checkout; cannot enumerate tracked files")
    return [p for p in out.stdout.split("\0") if p]


def test_no_secret_or_real_data_files_are_tracked() -> None:
    offenders: list[str] = []
    for path in _tracked_files():
        base = path.rsplit("/", 1)[-1]
        if _is_safe_env_template(base):
            continue
        for pattern, reason in _FORBIDDEN:
            if fnmatch(path, pattern) or fnmatch(base, pattern):
                offenders.append(f"{path} — {reason}")
                break
    assert not offenders, "Files that must not be tracked in a public repo:\n" + "\n".join(
        offenders
    )
