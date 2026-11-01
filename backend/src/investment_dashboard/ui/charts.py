"""Small, dependency-free helpers shared by the Plotly chart builders.

These keep the value-over-time graphs (Overview, Analytics, Yearly) fast and
readable:

* :func:`downsample` bounds how many points a long daily series sends to the
  browser, so multi-year curves render quickly instead of shipping thousands of
  points over the websocket.
* :func:`padded_range` fits a y-axis to the data with a little headroom instead
  of anchoring it to zero, so the real price *flow* is visible rather than a
  near-flat line squashed against a huge zero-based scale.

Neither helper imports Plotly; callers pass in plain Python values.
"""

from __future__ import annotations

#: Default ceiling on plotted points. ~2 years of daily data renders crisply
#: well under this; longer histories are thinned to roughly this many points,
#: which is indistinguishable on screen but far cheaper to ship and draw.
DEFAULT_MAX_POINTS = 800

#: Fraction of the data span added as top/bottom padding so the line doesn't
#: touch the plot edges.
DEFAULT_PAD_FRACTION = 0.06


def downsample[T](points: list[T], max_points: int = DEFAULT_MAX_POINTS) -> list[T]:
    """Return a visually-thinned copy of ``points``, capped at ``max_points``.

    A no-op when the series already fits, or when ``max_points < 2`` (in which
    case we return the full series rather than raising). The first and last
    points are always retained so the visible start/end values match the
    underlying data; the interior is sampled at a fixed stride. This is a
    *visual* simplification only — callers should still compute statistics on
    the full series.
    """
    n = len(points)
    if max_points < 2 or n <= max_points:
        return list(points)
    # Reserve the final slot for the last point; sample the rest by stride.
    stride = (n - 1) / (max_points - 1)
    out: list[T] = []
    seen: set[int] = set()
    for i in range(max_points):
        idx = round(i * stride)
        if idx >= n:
            idx = n - 1
        if idx not in seen:
            seen.add(idx)
            out.append(points[idx])
    if out[-1] is not points[n - 1]:
        out.append(points[n - 1])
    return out


def padded_range(
    values: list[float],
    *,
    pad_fraction: float = DEFAULT_PAD_FRACTION,
) -> tuple[float, float] | None:
    """Fit a y-axis ``[lo, hi]`` to ``values`` with a little headroom.

    Returns ``None`` for an empty input (let Plotly autorange). When every
    value is identical, a symmetric band around it keeps the line centred
    instead of collapsing to a zero-height axis. The range deliberately does
    **not** force zero into view — the point is to show how the value moves,
    not how big it is relative to nothing.
    """
    if not values:
        return None
    lo = min(values)
    hi = max(values)
    if lo == hi:
        # Flat series: open a band of ±1 (or ±10% of the level) around it.
        magnitude = abs(lo) * 0.1 or 1.0
        return lo - magnitude, hi + magnitude
    pad = (hi - lo) * pad_fraction
    return lo - pad, hi + pad
