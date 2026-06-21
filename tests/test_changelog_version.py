"""Guard: the CHANGELOG must document the current ``pyproject`` version.

This turns a recurring class of paperwork bug into a fast regression. Twice now
a release-notes block has been written without its ``## [x.y.z]`` header, so the
notes ended up orphaned under ``[Unreleased]`` while ``pyproject.toml`` had
already been bumped — leaving the version history incoherent (the changelog's
newest released entry lagged the shipped version). This test fails the moment
the version in ``pyproject.toml`` has no matching ``## [version]`` heading in
``CHANGELOG.md``.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]


def _pyproject_version() -> str:
    data = tomllib.loads((_REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    version = data["project"]["version"]
    assert isinstance(version, str)
    assert version
    return version


def test_changelog_documents_current_pyproject_version() -> None:
    version = _pyproject_version()
    changelog = (_REPO_ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    # Released entries are ``## [x.y.z] — <date>``; ``## [Unreleased]`` is the
    # only heading allowed to carry undated, not-yet-versioned notes. Capturing
    # the rest of the line lets us also reject a malformed (e.g. dateless)
    # heading, not just a missing one.
    heading = re.compile(rf"^## \[{re.escape(version)}\](?P<rest>.*)$", re.MULTILINE)
    match = heading.search(changelog)
    assert match, (
        f"pyproject version {version!r} has no '## [{version}]' entry in CHANGELOG.md; "
        "add the release heading (its notes may currently be orphaned under [Unreleased])."
    )
    # A released heading must be dated (``— YYYY-MM-DD``) so an orphaned block
    # that merely got a bare ``## [x.y.z]`` line still gets caught.
    assert re.search(r"—\s*\d{4}-\d{2}-\d{2}", match.group("rest")), (
        f"CHANGELOG '## [{version}]' heading is missing its '— YYYY-MM-DD' release date."
    )
