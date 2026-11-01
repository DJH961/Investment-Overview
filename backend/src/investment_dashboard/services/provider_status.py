"""Compatibility alias: this module moved to ``investment_dashboard.adapters.provider_status``.

The alias keeps one module object, so ``services.provider_status`` and
``adapters.provider_status`` share state and monkeypatching either works.
"""

from __future__ import annotations

import sys

from investment_dashboard.adapters import provider_status as _moved

sys.modules[__name__] = _moved
