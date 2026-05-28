"""Unit tests for the installer's pure version helpers."""

from __future__ import annotations

from urllib.parse import urlparse

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


def test_predicted_wheel_url_strips_v_prefix() -> None:
    from installer.version import predicted_wheel_url

    assert predicted_wheel_url("v2.1.0") == (
        f"https://github.com/{GITHUB_REPO}/releases/download/v2.1.0/"
        "investment_dashboard-2.1.0-py3-none-any.whl"
    )
    assert predicted_wheel_url("2.1.0").endswith(
        "/releases/download/2.1.0/investment_dashboard-2.1.0-py3-none-any.whl"
    )


@pytest.mark.parametrize(
    ("redirect_url", "expected"),
    [
        (f"https://github.com/{GITHUB_REPO}/releases/tag/v2.1.2", "v2.1.2"),
        (f"https://github.com/{GITHUB_REPO}/releases/tag/v2.1.2/", "v2.1.2"),
        (f"https://github.com/{GITHUB_REPO}/releases/tag/v2.1.2?x=y", "v2.1.2"),
    ],
)
def test_tag_from_release_redirect(redirect_url: str, expected: str) -> None:
    from installer.version import tag_from_release_redirect

    assert tag_from_release_redirect(redirect_url) == expected


def test_tag_from_release_redirect_rejects_non_tag_url() -> None:
    from installer.version import tag_from_release_redirect

    with pytest.raises(ValueError, match="redirect"):
        tag_from_release_redirect(f"https://github.com/{GITHUB_REPO}/releases")


def test_resolve_latest_release_uses_api_when_reachable(monkeypatch) -> None:
    """When the API responds, the resolver returns its (tag, wheel_url)."""
    import io

    from installer import version as version_module

    payload = (
        b'{"tag_name": "v2.1.0", "assets": [{'
        b'"name": "investment_dashboard-2.1.0-py3-none-any.whl",'
        b'"browser_download_url": "https://example/wheel"}]}'
    )

    class _Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *_: object) -> None:
            return None

    def _fake_urlopen(request, timeout):
        assert urlparse(request.full_url).hostname == "api.github.com"
        return _Resp(payload)

    monkeypatch.setattr(version_module, "urlopen", _fake_urlopen)
    tag, wheel_url = version_module.resolve_latest_release(timeout=1.0)
    assert tag == "v2.1.0"
    assert wheel_url == "https://example/wheel"


def test_resolve_latest_release_falls_back_to_html_redirect_on_api_404(monkeypatch) -> None:
    """If the JSON API returns 404 (corporate proxy), follow the github.com redirect."""
    from urllib.error import HTTPError

    from installer import version as version_module

    class _RedirectResp:
        url = f"https://github.com/{version_module.GITHUB_REPO}/releases/tag/v2.1.2"

        def __enter__(self):
            return self

        def __exit__(self, *_: object) -> None:
            return None

    def _fake_urlopen(request, timeout):
        if urlparse(request.full_url).hostname == "api.github.com":
            raise HTTPError(request.full_url, 404, "Not Found", hdrs=None, fp=None)
        assert request.full_url == version_module.LATEST_RELEASE_HTML
        return _RedirectResp()

    monkeypatch.setattr(version_module, "urlopen", _fake_urlopen)
    tag, wheel_url = version_module.resolve_latest_release(timeout=1.0)
    assert tag == "v2.1.2"
    # When falling back, the resolver predicts the wheel URL from the tag.
    assert wheel_url is not None
    assert wheel_url.endswith("/investment_dashboard-2.1.2-py3-none-any.whl")


def test_resolve_latest_release_falls_back_on_url_error(monkeypatch) -> None:
    """Connection errors (DNS block etc.) also trigger the redirect fallback."""
    from urllib.error import URLError

    from installer import version as version_module

    class _RedirectResp:
        url = f"https://github.com/{version_module.GITHUB_REPO}/releases/tag/v2.1.3"

        def __enter__(self):
            return self

        def __exit__(self, *_: object) -> None:
            return None

    def _fake_urlopen(request, timeout):
        if urlparse(request.full_url).hostname == "api.github.com":
            raise URLError("dns blocked")
        return _RedirectResp()

    monkeypatch.setattr(version_module, "urlopen", _fake_urlopen)
    tag, _ = version_module.resolve_latest_release(timeout=1.0)
    assert tag == "v2.1.3"
