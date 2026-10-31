"""Headless JSON API for the mobile companion app.

See :mod:`investment_dashboard.api.app` for the routes. The API is
read-only and reuses :mod:`investment_dashboard.readmodels`, so it shares
all business logic with the NiceGUI web app.
"""

from __future__ import annotations

from investment_dashboard.api.app import (
    API_PREFIX,
    create_app,
    create_router,
    mount_api,
    run,
)

__all__ = ["API_PREFIX", "create_app", "create_router", "mount_api", "run"]
