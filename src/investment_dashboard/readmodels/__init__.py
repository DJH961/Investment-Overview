"""UI-agnostic JSON read-models — the shared contract for every front-end.

This package is the seam that lets the NiceGUI web app and the Android
companion app share one body of logic. The actual computation lives in
``domain/`` and ``services/`` (and the per-page query helpers); these
modules only *serialize* that output into JSON-native structures, so a
change to the underlying logic flows to every client automatically.

Each section module exposes a ``build(session, *, context=...)`` function
returning a ``dict`` of JSON-native values. :func:`snapshot.build_snapshot`
assembles them all into the single document the mobile app consumes.
"""

from __future__ import annotations

from investment_dashboard.readmodels import (
    analytics,
    calculator,
    deposits,
    mobile_export,
    overview,
    periods,
    transactions,
)
from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels.mobile_export import build_mobile_export
from investment_dashboard.readmodels.snapshot import (
    SCHEMA_VERSION,
    build_meta,
    build_snapshot,
)

__all__ = [
    "SCHEMA_VERSION",
    "ReadModelContext",
    "analytics",
    "build_context",
    "build_meta",
    "build_mobile_export",
    "build_snapshot",
    "calculator",
    "deposits",
    "mobile_export",
    "overview",
    "periods",
    "transactions",
]
