"""Compatibility alias: moved to :mod:`investment_dashboard.readmodels.queries.projection_query`."""

import sys

from investment_dashboard.readmodels.queries import projection_query as _moved

sys.modules[__name__] = _moved
