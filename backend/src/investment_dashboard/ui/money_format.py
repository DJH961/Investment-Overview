"""Compatibility alias: moved to :mod:`investment_dashboard.readmodels.money_format`."""

import sys

from investment_dashboard.readmodels import money_format as _moved

sys.modules[__name__] = _moved
