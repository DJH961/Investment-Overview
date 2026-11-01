"""Compatibility alias: moved to :mod:`investment_dashboard.readmodels.queries.overview_query`."""

import sys

from investment_dashboard.readmodels.queries import overview_query as _moved

sys.modules[__name__] = _moved
