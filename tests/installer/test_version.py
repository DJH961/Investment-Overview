"""Unit tests for the installer's pure version helpers."""

from __future__ import annotations

import pytest
from installer.version import (
    GITHUB_REPO,
    extract_release_metadata,
    is_newer,
    parse_version,
    tarball_url,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("2.1.0", (2, 1, 0)),
        ("v2.1.0", (2, 1, 0)),
        ("V2.1", (2, 1, 0)),
        ("2", (2, 0, 0)),
        ("2.1.0-rc1", (2, 1, 0)),
        ("2.1.0.dev0", (2, 1, 0)),
        ("  v2.1.0  ", (2, 1, 0)),
    ],
)
def test_parse_version_normalises_tags_and_qualifiers(
    raw: str, expected: tuple[int, int, int]
) -> None:
    assert parse_version(raw) == expected


def test_is_newer_strictly_compares_versions() -> None:
    assert is_newer("v2.1.0", "2.0.0")
    assert is_newer("2.0.1", "2.0.0")
    assert not is_newer("2.1.0", "v2.1.0")
    assert not is_newer("2.0.0", "2.1.0")


def test_extract_release_metadata_prefers_wheel_asset() -> None:
    payload = {
        "tag_name": "v2.1.0",
        "assets": [
            {
                "name": "investment_dashboard-2.1.0.tar.gz",
                "browser_download_url": "https://example/sdist",
            },
            {
                "name": "investment_dashboard-2.1.0-py3-none-any.whl",
                "browser_download_url": "https://example/wheel",
            },
        ],
    }
    tag, wheel_url = extract_release_metadata(payload)
    assert tag == "v2.1.0"
    assert wheel_url == "https://example/wheel"


def test_extract_release_metadata_returns_none_when_no_wheel_present() -> None:
    payload = {"tag_name": "v2.1.0", "assets": []}
    tag, wheel_url = extract_release_metadata(payload)
    assert tag == "v2.1.0"
    assert wheel_url is None


def test_extract_release_metadata_rejects_missing_tag() -> None:
    with pytest.raises(ValueError, match="tag_name"):
        extract_release_metadata({"assets": []})


def test_tarball_url_targets_github_archive() -> None:
    assert (
        tarball_url("v2.1.0") == f"https://github.com/{GITHUB_REPO}/archive/refs/tags/v2.1.0.tar.gz"
    )
