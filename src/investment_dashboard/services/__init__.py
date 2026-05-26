"""Use-case orchestration: services compose repositories + domain + adapters.

The UI calls only into this layer — never directly into ``repositories/``
or ``adapters/``. Each service module is named for its concern
(``fx_service``, ``prices_service``, …) and exposes pure functions that
take a SQLAlchemy :class:`Session`.
"""

from investment_dashboard.services import (
    fx_service,
    importer_service,
    metrics_service,
    positions_service,
    prices_service,
)

__all__ = [
    "fx_service",
    "importer_service",
    "metrics_service",
    "positions_service",
    "prices_service",
]
