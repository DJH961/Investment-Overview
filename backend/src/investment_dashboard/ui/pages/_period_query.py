"""Compatibility alias: moved to :mod:`investment_dashboard.readmodels.queries.period_query`."""

import sys

from investment_dashboard.readmodels.queries import period_query as _moved

sys.modules[__name__] = _moved
