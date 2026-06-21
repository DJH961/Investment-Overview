"""Centralized logging configuration."""

from __future__ import annotations

import logging
import sys

from investment_dashboard.config import get_settings
from investment_dashboard.redaction import SecretRedactingFilter


def configure_logging() -> None:
    settings = get_settings()
    root = logging.getLogger()
    if root.handlers:
        return
    handler = logging.StreamHandler(stream=sys.stderr)
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s %(levelname)-7s %(name)s — %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    # Defence-in-depth: scrub secret-shaped strings from every record so an
    # accidental ``log.exception(resp.text)`` can't leak a credential.
    handler.addFilter(SecretRedactingFilter())
    root.addHandler(handler)
    root.setLevel(settings.log_level)
