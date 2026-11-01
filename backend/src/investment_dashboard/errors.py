"""Shared error types: services raise these, the API maps them to HTTP statuses.

Each class also inherits the builtin that the code raised before (``ValueError``
and friends), so existing ``except ValueError`` callers keep working. "No data"
stays ``None``; these are for invalid input, missing things, clashes and
upstream (provider) failures only.
"""

from __future__ import annotations


class DomainError(Exception):
    """Base class for errors the API turns into a 4xx/5xx response."""

    http_status = 500


class ValidationError(DomainError, ValueError):
    """The input is invalid (HTTP 422)."""

    http_status = 422


class NotFoundError(DomainError, LookupError):
    """A referenced record does not exist (HTTP 404)."""

    http_status = 404


class ConflictError(DomainError, ValueError):
    """The request clashes with existing data (HTTP 409)."""

    http_status = 409


class UpstreamError(DomainError, RuntimeError):
    """An external provider or system failed (HTTP 502)."""

    http_status = 502
