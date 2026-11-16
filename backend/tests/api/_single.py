"""Read one currency's body through a ``/both`` route (the single-currency GETs are gone)."""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit

from fastapi.testclient import TestClient


def get_one(client: TestClient, url: str) -> Any:
    """GET ``<path>/both?<params without ccy>`` and return the ``ccy`` side (default EUR)."""
    parts = urlsplit(url)
    params = parse_qsl(parts.query)
    ccy = next((v for k, v in params if k == "ccy"), "EUR")
    rest = [(k, v) for k, v in params if k != "ccy"]
    query = f"?{urlencode(rest)}" if rest else ""
    resp = client.get(f"{parts.path}/both{query}")
    assert resp.status_code == 200, resp.text
    return resp.json()[ccy]
