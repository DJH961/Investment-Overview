"""Tests for ``investment_dashboard.ui.charts`` helpers."""

from __future__ import annotations

from investment_dashboard.ui.charts import downsample, padded_range


def test_downsample_is_noop_when_under_limit() -> None:
    pts = list(range(10))
    assert downsample(pts, max_points=50) == pts


def test_downsample_caps_point_count_and_keeps_ends() -> None:
    pts = list(range(10_000))
    out = downsample(pts, max_points=800)
    assert len(out) <= 800
    # First and last points are always retained so the visible endpoints match.
    assert out[0] == 0
    assert out[-1] == 9_999
    # Output stays in order and strictly increasing (no duplicates).
    assert out == sorted(set(out))


def test_downsample_handles_tiny_limit() -> None:
    pts = list(range(100))
    # max_points < 2 degrades to returning the full series rather than crashing.
    assert downsample(pts, max_points=1) == pts


def test_padded_range_none_for_empty() -> None:
    assert padded_range([]) is None


def test_padded_range_adds_headroom_without_forcing_zero() -> None:
    lo, hi = padded_range([100.0, 110.0, 105.0])
    # Range fits the data with padding and deliberately excludes zero so the
    # flow is visible rather than squashed against a zero baseline.
    assert lo > 0
    assert lo < 100.0
    assert hi > 110.0


def test_padded_range_flat_series_opens_a_band() -> None:
    lo, hi = padded_range([42.0, 42.0, 42.0])
    assert lo < 42.0 < hi
