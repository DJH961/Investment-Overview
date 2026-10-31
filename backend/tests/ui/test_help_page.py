"""Tests for the in-app Help page wiring and content."""

from __future__ import annotations

from investment_dashboard.ui.layout import _ONBOARDING_BYPASS_PATHS, NAV_ITEMS
from investment_dashboard.ui.pages import help as help_page


def test_help_path_is_stable() -> None:
    assert help_page.PATH == "/help"


def test_help_is_hidden_from_sidebar() -> None:
    # "Hidden away but available": reachable via the header icon, never listed
    # as a primary sidebar nav item.
    assert "/help" not in {item.path for item in NAV_ITEMS}


def test_help_bypasses_onboarding_redirect() -> None:
    # A brand-new user with an empty database must still be able to open Help.
    assert "/help" in _ONBOARDING_BYPASS_PATHS


def test_help_documents_every_settings_section() -> None:
    titles = " ".join(title for title, _ in help_page._SETTINGS_GUIDE).lower()
    for needle in (
        "display currency",
        "benchmark",
        "risk-free",
        "storage",
        "data refresh",
        "connectivity",
        "accounts",
        "instruments",
        "target allocations",
    ):
        assert needle in titles, f"settings guide is missing: {needle}"


def test_help_guides_are_non_empty() -> None:
    for rows in (help_page._PAGE_GUIDE, help_page._SETTINGS_GUIDE, help_page._FAQ):
        assert rows, "guide section must not be empty"
        for title, body in rows:
            assert title.strip()
            assert body.strip()
