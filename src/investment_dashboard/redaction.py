"""Central secret redaction for logs and error messages.

A defence-in-depth net against the "a secret reached a log sink" hazard. Rather
than fixing each call site, :func:`redact_secrets` scrubs known secret *shapes*
(GitHub PATs, ``Bearer``/``token`` credentials) from any string, and
:class:`SecretRedactingFilter` applies it to every emitted log record once it is
installed by :func:`investment_dashboard.logging.configure_logging`.

Call sites that hold a concrete secret (a passphrase, a specific token) can pass
it via ``extra`` so the exact value is masked even when it doesn't match a known
shape.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable

#: Replacement marker used for every redacted secret.
REDACTED = "«redacted»"

#: Known secret shapes. GitHub personal-access tokens (classic ``ghp_…`` and the
#: fine-grained ``github_pat_…`` form) plus OAuth tokens (``gho_…``) are the
#: secrets this app actually handles for the live-web companion.
_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bghp_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bgho_[A-Za-z0-9]{20,}"),
    # ``bearer <token>`` / ``token <token>`` — mask the credential but keep the
    # scheme word so the log still reads sensibly.
    re.compile(r"(?i)(bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}"),
)


def redact_secrets(text: str, *, extra: Iterable[str] = ()) -> str:
    """Return ``text`` with known secret shapes and any ``extra`` values masked.

    ``extra`` lets a caller mask a concrete secret it is holding (for example the
    exact PAT or passphrase) even if it doesn't match a built-in shape. Empty and
    whitespace-only ``extra`` entries are ignored so we never replace every space
    in the string with the marker.
    """
    if not text:
        return text
    out = text
    # Mask explicit secrets first (longest first) so a token isn't partially
    # rewritten by a shape pattern before we get to it.
    for secret in sorted((s for s in extra if s and s.strip()), key=len, reverse=True):
        out = out.replace(secret, REDACTED)
    for pattern in _PATTERNS:
        if "bearer|token" in pattern.pattern:
            out = pattern.sub(lambda m: f"{m.group(1)} {REDACTED}", out)
        else:
            out = pattern.sub(REDACTED, out)
    return out


class SecretRedactingFilter(logging.Filter):
    """A :class:`logging.Filter` that scrubs secrets from every record.

    Installed process-wide on the root handler. It rewrites the already-formatted
    message (and clears ``args``) so downstream formatters can't re-expand a
    secret that slipped through interpolation.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except (TypeError, ValueError):  # pragma: no cover - malformed log call
            return True
        redacted = redact_secrets(message)
        if redacted != message:
            record.msg = redacted
            record.args = None
        return True
