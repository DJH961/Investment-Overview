"""HTTP API.

* :mod:`investment_dashboard.api.app` — the v6 server (``create_app``): one
  router module per resource, all mounted under ``/api``.
* :mod:`investment_dashboard.api.legacy_v5` — the v5 read-only API mounted on
  the NiceGUI app; deleted at cutover.
"""
