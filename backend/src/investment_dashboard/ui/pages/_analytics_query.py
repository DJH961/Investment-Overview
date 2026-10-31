"""Compatibility alias: moved to :mod:`investment_dashboard.readmodels.queries.analytics_query`."""

import sys

from investment_dashboard.readmodels.queries import analytics_query as _moved

sys.modules[__name__] = _moved
