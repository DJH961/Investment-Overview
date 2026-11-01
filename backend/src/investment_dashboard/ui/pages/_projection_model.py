"""Compatibility alias: moved to :mod:`investment_dashboard.readmodels.queries.projection_model`."""

import sys

from investment_dashboard.readmodels.queries import projection_model as _moved

sys.modules[__name__] = _moved
