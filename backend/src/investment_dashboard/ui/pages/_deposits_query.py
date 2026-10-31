"""Compatibility alias: moved to :mod:`investment_dashboard.readmodels.queries.deposits_query`."""

import sys

from investment_dashboard.readmodels.queries import deposits_query as _moved

sys.modules[__name__] = _moved
