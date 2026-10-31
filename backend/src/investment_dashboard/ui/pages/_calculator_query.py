"""Compatibility alias: moved to :mod:`investment_dashboard.readmodels.queries.calculator_query`."""

import sys

from investment_dashboard.readmodels.queries import calculator_query as _moved

sys.modules[__name__] = _moved
