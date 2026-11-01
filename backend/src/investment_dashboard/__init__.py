"""Investment Dashboard — local-first portfolio tracking."""

from __future__ import annotations

import tomllib
from importlib import metadata as importlib_metadata
from pathlib import Path

_PROJECT_NAME = "investment-dashboard"


def _version_from_pyproject() -> str | None:
    pyproject = Path(__file__).resolve().parents[2] / "pyproject.toml"
    try:
        data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return None

    version = data.get("project", {}).get("version")
    return version if isinstance(version, str) else None


def _version() -> str:
    if source_version := _version_from_pyproject():
        return source_version
    try:
        return importlib_metadata.version(_PROJECT_NAME)
    except importlib_metadata.PackageNotFoundError:
        return "0+unknown"


__version__ = _version()

__all__ = ["__version__"]
