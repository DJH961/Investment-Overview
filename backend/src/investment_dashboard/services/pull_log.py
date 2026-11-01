"""Compatibility alias: this module moved to ``investment_dashboard.adapters.pull_log``.

The alias keeps one module object, so ``services.pull_log`` and
``adapters.pull_log`` share state and monkeypatching either works.
"""

from __future__ import annotations

import sys

from investment_dashboard.adapters import pull_log as _moved

sys.modules[__name__] = _moved
