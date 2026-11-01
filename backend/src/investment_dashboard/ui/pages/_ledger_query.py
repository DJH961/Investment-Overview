"""Compatibility alias: moved to :mod:`investment_dashboard.readmodels.queries.ledger_query`."""

import sys

from investment_dashboard.readmodels.queries import ledger_query as _moved

sys.modules[__name__] = _moved
