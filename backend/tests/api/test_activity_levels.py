"""Which request outcomes land in Recent problems (WARNING) and which are routine (INFO)."""

from __future__ import annotations

import logging

import pytest

from investment_dashboard.api.activity import _level


@pytest.mark.parametrize(
    ("status", "path"),
    [
        (200, "/api/refresh"),
        (409, "/api/refresh"),  # a refresh was already running
        (409, "/api/maintenance/jobs/graphs.reload"),  # repair job already running
        (422, "/api/imports"),  # file the parser can't read: the UI shows why
        (401, "/api/settings/export"),  # scanner without a session
    ],
)
def test_routine_outcomes_are_info(status: int, path: str) -> None:
    assert _level(status, path) == logging.INFO


@pytest.mark.parametrize(
    ("status", "path"),
    [
        (401, "/api/auth/login"),  # failed login
        (422, "/api/auth/passkey"),
        (429, "/api/refresh"),
        (500, "/api/imports"),
    ],
)
def test_real_problems_stay_warning(status: int, path: str) -> None:
    assert _level(status, path) == logging.WARNING
