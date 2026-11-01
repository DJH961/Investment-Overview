"""Tests for the scroll-restoration script builder."""

from __future__ import annotations

from investment_dashboard.ui.scroll_restore import build_scroll_restoration_js


def test_script_is_keyed_per_path() -> None:
    js = build_scroll_restoration_js("/overview")
    assert '"inv-scroll:/overview"' in js
    other = build_scroll_restoration_js("/analytics")
    assert '"inv-scroll:/analytics"' in other
    assert js != other


def test_script_saves_and_restores() -> None:
    js = build_scroll_restoration_js("/overview")
    assert js.startswith("<script>")
    assert js.endswith("</script>")
    # Persists scroll position and restores it via scrollTo.
    assert "sessionStorage.setItem" in js
    assert "sessionStorage.getItem" in js
    assert "window.scrollTo(0,target)" in js


def test_path_is_json_encoded_safely() -> None:
    # A path with a quote must not break out of the string literal.
    js = build_scroll_restoration_js('/x"y')
    assert '"inv-scroll:/x\\"y"' in js
