"""Guard: every declared console-script entry point must resolve to a callable.

The ``[project.scripts]`` table in ``pyproject.toml`` wires shell commands (e.g.
``inv-dashboard-publish-web``) to ``module:attribute`` targets. Nothing at
import time verifies those targets still exist, so renaming or moving a
``main``/``run`` function silently produces a console script that crashes with
``ImportError`` only once an end user runs it. This test fails the moment a
declared target no longer imports or is no longer callable.
"""

from __future__ import annotations

import importlib
import tomllib
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[1]


def _console_scripts() -> dict[str, str]:
    data = tomllib.loads((_REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    scripts = data["project"]["scripts"]
    assert isinstance(scripts, dict)
    assert scripts, "no [project.scripts] declared"
    return scripts


@pytest.mark.parametrize("target", sorted(set(_console_scripts().values())))
def test_console_script_target_is_callable(target: str) -> None:
    module_name, sep, attr = target.partition(":")
    assert sep == ":", f"console-script target {target!r} must be 'module:attribute'"
    assert attr, f"console-script target {target!r} must name an attribute"
    module = importlib.import_module(module_name)
    entry = getattr(module, attr, None)
    assert callable(entry), f"console-script target {target!r} does not resolve to a callable"
