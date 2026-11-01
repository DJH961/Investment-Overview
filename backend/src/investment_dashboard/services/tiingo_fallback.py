"""Compatibility alias: this module moved to ``investment_dashboard.domain.tiingo_fallback``.

The alias keeps one module object, so ``services.tiingo_fallback`` and
``domain.tiingo_fallback`` share state and monkeypatching either works.
"""

from __future__ import annotations

import sys

from investment_dashboard.domain import tiingo_fallback as _moved

sys.modules[__name__] = _moved
