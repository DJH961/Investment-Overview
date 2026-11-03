"""Memory reporting and the rate-limited RSS warning in diagnostics_service."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from investment_dashboard.services import diagnostics_service as ds

MB = 1024 * 1024


def test_memory_usage_parses_proc_status(tmp_path: Path) -> None:
    f = tmp_path / "status"
    f.write_text("Name:\tpython\nVmRSS:\t  2048 kB\nVmSwap:\t 1024 kB\n")
    assert ds.memory_usage(f) == (2048 * 1024, 1024 * 1024)


def test_memory_usage_absent_is_none(tmp_path: Path) -> None:
    assert ds.memory_usage(tmp_path / "missing") is None


def test_warning_is_rate_limited(caplog: pytest.LogCaptureFixture) -> None:
    ds._last_rss_warning = None
    caplog.set_level(logging.WARNING)
    assert ds.warn_if_memory_high((300 * MB, 0), now=1.0) is False
    assert ds.warn_if_memory_high((500 * MB, 0), now=1.0) is True
    assert ds.warn_if_memory_high((500 * MB, 0), now=100.0) is False
    assert ds.warn_if_memory_high((500 * MB, 0), now=1.0 + 7200) is True
    ds._last_rss_warning = None
