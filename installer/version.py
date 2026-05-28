"""Pure helpers shared by the bootstrapper and the steady-state launcher.

Everything in this module is intentionally side-effect free and depends only on
the Python standard library. That keeps the PyInstaller-frozen bootstrapper
small and makes the logic easy to unit-test under the regular pytest suite.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

GITHUB_REPO = "DJH961/Investment-Overview"
LATEST_RELEASE_API = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
LATEST_RELEASE_HTML = f"https://github.com/{GITHUB_REPO}/releases/latest"
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


def predicted_wheel_url(tag: str) -> str:
    """Best-guess URL of the wheel asset attached to release ``tag``.

    The release workflow uploads wheels named
    ``investment_dashboard-<X.Y.Z>-py3-none-any.whl`` to every ``v*`` tag.
    When the GitHub API is unreachable we cannot read the asset list, but
    we can still construct this URL from the tag alone.
    """
    version = tag[1:] if tag[:1] in {"v", "V"} else tag
    return (
        f"https://github.com/{GITHUB_REPO}/releases/download/{tag}/"
        f"investment_dashboard-{version}-py3-none-any.whl"
    )


def tag_from_release_redirect(final_url: str) -> str:
    """Extract the tag from the URL ``releases/latest`` redirects to.

    GitHub redirects ``https://github.com/<repo>/releases/latest`` to
    ``https://github.com/<repo>/releases/tag/<tag>``. We pick the last
    non-empty path segment, stripping any trailing slash or query string.
    """
    cleaned = final_url.split("?", 1)[0].split("#", 1)[0].rstrip("/")
    if "/releases/tag/" not in cleaned:
        raise ValueError(f"Unexpected releases/latest redirect target: {final_url!r}")
    return cleaned.rsplit("/", 1)[-1]


def resolve_latest_release(
    timeout: float = 30.0,
    *,
    api_url: str = LATEST_RELEASE_API,
    html_url: str = LATEST_RELEASE_HTML,
) -> tuple[str, str | None]:
    """Resolve the latest release tag and (when known) wheel URL.

    Strategy:

    1. Hit the GitHub Releases JSON API. On success, return the tag plus
       any wheel asset attached to the release.
    2. If the API is unreachable (HTTP error, DNS block, corporate proxy
       that returns 404 for ``api.github.com``, …), follow the
       ``github.com/<repo>/releases/latest`` redirect. ``github.com``
       itself is far more likely to be reachable from locked-down work
       networks than the API subdomain. The final URL contains the tag.
       In that fallback path we predict the wheel URL from the tag,
       falling back at pip-install time to the source tarball if the
       predicted wheel happens not to exist.

    The split lives in this pure helper so it can be unit-tested without
    touching the network.
    """
    try:
        request = Request(
            api_url,
            headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"},
        )
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return extract_release_metadata(payload)
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
        pass

    request = Request(html_url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=timeout) as response:
        tag = tag_from_release_redirect(response.url)
    return tag, predicted_wheel_url(tag)
