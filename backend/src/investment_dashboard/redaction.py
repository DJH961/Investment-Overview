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
from collections.abc import Callable, Iterable

#: Replacement marker used for every redacted secret.
REDACTED = "«redacted»"

#: Known secret shapes paired with their replacement. Each entry is
#: ``(pattern, replacement)`` where ``replacement`` is a string or a callable
#: passed straight to :meth:`re.Pattern.sub`. GitHub personal-access tokens
#: (classic ``ghp_…`` and the fine-grained ``github_pat_…`` form) plus OAuth
#: tokens (``gho_…``) are the secrets this app actually handles for the live-web
#: companion. The ``bearer``/``token`` rule keeps the scheme word so the log
#: still reads sensibly while masking only the credential.
_PATTERNS: tuple[tuple[re.Pattern[str], str | Callable[[re.Match[str]], str]], ...] = (
    (re.compile(r"\bghp_[A-Za-z0-9]{20,}"), REDACTED),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), REDACTED),
    (re.compile(r"\bgho_[A-Za-z0-9]{20,}"), REDACTED),
    (
        re.compile(r"(?i)(bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}"),
        lambda m: f"{m.group(1)} {REDACTED}",
    ),
    # Credential-carrying HTTP headers as they appear in a dumped request or a
    # traceback repr: ``X-API-Token: abc``, ``Cookie: __Host-session=abc``.
    (
        re.compile(
            r"(?i)\b(x-api-token|authorization|proxy-authorization|cookie|set-cookie)"
            r"(['\"]?\s*[:=]\s*['\"]?)[^\r\n'\"]+"
        ),
        lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}",
    ),
    # ``password=...``, ``"passphrase": "..."``, ``?api_key=...`` style pairs.
    (
        re.compile(
            r"(?i)\b(pass(?:word|phrase)|secret|api[_-]?key|api[_-]?token|access[_-]?token"
            r"|session(?:[_-]?id)?)(['\"]?\s*[:=]\s*['\"]?)[^\s'\",;&)}\]]+"
        ),
        lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}",
    ),
)

#: Concrete secret values of this process (database/backup passphrases, API and
#: provider tokens). Registered once at startup by ``configure_logging`` so the
#: exact value is masked wherever it shows up, even without a known shape.
_registered: set[str] = set()


def register_secrets(*values: str | None) -> None:
    """Remember concrete secret values to mask in every later log record."""
    for v in values:
        if v and v.strip() and len(v) >= 4:
            _registered.add(v)


def registered_secrets() -> frozenset[str]:
    return frozenset(_registered)


def redact_secrets(text: str, *, extra: Iterable[str] = ()) -> str:
    """Return ``text`` with known secret shapes and any ``extra`` values masked.

    ``extra`` lets a caller mask a concrete secret it is holding (for example the
    exact PAT or passphrase) even if it doesn't match a built-in shape. Empty and
    whitespace-only ``extra`` entries are ignored so we never replace every space
    in the string with the marker.
    """
    if not text:
        return text
    extra = (*extra, *_registered)
    out = text
    # Mask explicit secrets first (longest first) so a token isn't partially
    # rewritten by a shape pattern before we get to it.
    for secret in sorted((s for s in extra if s and s.strip()), key=len, reverse=True):
        out = out.replace(secret, REDACTED)
    for pattern, replacement in _PATTERNS:
        out = pattern.sub(replacement, out)
    return out


class SecretRedactingFilter(logging.Filter):
    """A :class:`logging.Filter` that scrubs secrets from every record.

    Installed process-wide on the root handler. It rewrites the already-formatted
    message (and clears ``args``) so downstream formatters can't re-expand a
    secret that slipped through interpolation. The exception traceback
    (``exc_info``) and ``stack_info`` are rendered and scrubbed too: an exception
    message such as ``ValueError("bad token ghp_...")`` otherwise reaches the sink
    verbatim through the formatter.
    """

    _formatter = logging.Formatter()

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except (TypeError, ValueError):  # pragma: no cover - malformed log call
            return True
        redacted = redact_secrets(message)
        if redacted != message:
            record.msg = redacted
            record.args = None
        if record.exc_info and not record.exc_text:
            try:
                record.exc_text = self._formatter.formatException(record.exc_info)
            except Exception:  # pragma: no cover - never break logging
                record.exc_text = None
        if record.exc_text:
            record.exc_text = redact_secrets(record.exc_text)
        if record.stack_info:
            record.stack_info = redact_secrets(record.stack_info)
        return True
