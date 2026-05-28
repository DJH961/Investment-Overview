"""Pure helpers shared by the bootstrapper and the steady-state launcher.

Everything in this module is intentionally side-effect free and depends only on
the Python standard library. That keeps the PyInstaller-frozen bootstrapper
small and makes the logic easy to unit-test under the regular pytest suite.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

GITHUB_REPO = "DJH961/Investment-Overview"
LATEST_RELEASE_API = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
USER_AGENT = "InvestmentDashboard-Installer"

# Maximum number of numeric components we compare from a version string.
_VERSION_COMPONENT_COUNT = 3


def parse_version(version: str) -> tuple[int, ...]:
    """Return a comparable tuple from a ``X.Y.Z`` version string.

    Leading ``v`` / ``V`` is stripped (so GitHub tag names like ``v2.1.0`` and
    plain wheel versions like ``2.1.0`` parse identically). Non-numeric
    suffixes such as ``-rc1`` or ``.dev0`` are ignored: they do not
    participate in ordering. Missing components default to ``0`` so that
    ``"2.1"`` compares equal to ``"2.1.0"``.
    """
    cleaned = version.strip()
    if cleaned[:1] in {"v", "V"}:
        cleaned = cleaned[1:]

    parts: list[int] = []
    for token in cleaned.replace("-", ".").split("."):
        number = ""
        for char in token:
            if not char.isdigit():
                break
            number += char
        if number:
            parts.append(int(number))
        if len(parts) == _VERSION_COMPONENT_COUNT:
            break

    while len(parts) < _VERSION_COMPONENT_COUNT:
        parts.append(0)
    return tuple(parts[:_VERSION_COMPONENT_COUNT])


def is_newer(remote: str, current: str) -> bool:
    """Return ``True`` iff ``remote`` is strictly newer than ``current``."""
    return parse_version(remote) > parse_version(current)


def extract_release_metadata(payload: Mapping[str, Any]) -> tuple[str, str | None]:
    """Pull the (tag, wheel URL) pair from a GitHub ``releases/latest`` payload.

    Returns a tuple ``(tag_name, wheel_url)``. ``wheel_url`` is ``None`` when
    no ``investment_dashboard-*.whl`` asset is attached to the release. The
    launcher falls back to the GitHub-generated source tarball in that case.

    Raises ``ValueError`` if ``tag_name`` is missing or empty — that means
    the payload is not a valid release object and the caller should bail
    out instead of attempting an install with bogus data.
    """
    tag = payload.get("tag_name")
    if not isinstance(tag, str) or not tag:
        raise ValueError("GitHub release payload is missing 'tag_name'.")

    wheel_url: str | None = None
    assets = payload.get("assets")
    if isinstance(assets, list):
        for asset in assets:
            if not isinstance(asset, Mapping):
                continue
            name = asset.get("name")
            url = asset.get("browser_download_url")
            if (
                isinstance(name, str)
                and isinstance(url, str)
                and name.startswith("investment_dashboard-")
                and name.endswith(".whl")
            ):
                wheel_url = url
                break

    return tag, wheel_url


def tarball_url(tag: str) -> str:
    """URL of the GitHub-generated source tarball for ``tag``.

    Used as a fallback when the release does not carry a built wheel asset.
    ``pip install <url>`` works directly against this URL because the repo
    ships a valid ``pyproject.toml`` at its root.
    """
    return f"https://github.com/{GITHUB_REPO}/archive/refs/tags/{tag}.tar.gz"
