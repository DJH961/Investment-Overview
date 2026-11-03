"""Per-boot secret for the loopback-only "server is restarting" announcement.

``deploy/deploy.sh`` execs into the running container, reads the token from
:data:`TOKEN_PATH` and POSTs to ``/api/ops/announce-restart`` on 127.0.0.1. The
token is random per process start (created lazily on first use, written mode 600),
so a request from outside the container cannot guess it, and the route also
insists on a loopback client address.
"""

from __future__ import annotations

import contextlib
import hmac
import logging
import os
import secrets
import threading
from pathlib import Path

log = logging.getLogger(__name__)

#: Where the token lives inside the container (read by deploy.sh through ``docker exec``).
TOKEN_PATH = Path("/tmp/inv-restart.token")
TOKEN_HEADER = "X-Restart-Token"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1"})

_lock = threading.Lock()
_token: str | None = None
_path: Path = TOKEN_PATH


def configure(path: Path | None = None) -> None:
    """Forget the current token and (optionally) use another file; for tests."""
    global _token, _path  # noqa: PLW0603
    with _lock:
        _token = None
        _path = path or TOKEN_PATH


def token() -> str:
    """The token for this process; generated and written to disk on first use."""
    global _token  # noqa: PLW0603
    with _lock:
        if _token is None:
            value = secrets.token_urlsafe(32)
            try:
                _path.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w", encoding="ascii") as handle:
                    handle.write(value)
                with contextlib.suppress(OSError):
                    os.chmod(_path, 0o600)
            except OSError:
                log.warning("Could not write the restart token file")
            _token = value
        return _token


def ensure_token() -> None:
    """Create the token file now (call at app start so deploy.sh can find it)."""
    token()


def is_authorised(client_host: str | None, presented: str | None) -> bool:
    """True only for a loopback client that presents this boot's token."""
    if client_host not in LOOPBACK_HOSTS or not presented:
        return False
    return hmac.compare_digest(presented.encode(), token().encode())
