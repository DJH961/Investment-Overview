"""Bounded retry/backoff helper for external-call adapters.

Every adapter call to an external service (yfinance, Frankfurter, …) is a
single point of transient failure: a momentary network blip or an HTTP 429
rate-limit response would otherwise fail a whole refresh or import. This
module centralises a small, dependency-free retry policy so each adapter can
opt in without re-implementing backoff.

The policy is deliberately conservative:

* a bounded number of *attempts* (default 3),
* exponential backoff with a fixed base delay,
* retry only on exceptions the caller classifies as transient.

``sleep`` is injectable so tests can assert the backoff schedule without
actually waiting.
"""

from __future__ import annotations

import logging
import random
import time
from collections.abc import Callable

log = logging.getLogger(__name__)

#: Default number of attempts (1 initial try + retries).
DEFAULT_ATTEMPTS = 3
#: Base delay in seconds; attempt *n* waits ``base * 2 ** (n - 1)``.
DEFAULT_BACKOFF_SECONDS = 0.5


class RateLimitedError(RuntimeError):
    """Marker for an HTTP 429 (Too Many Requests) so callers can back off harder.

    Adapters raise this from inside the retried callable when they detect a
    429 response; :func:`retry_call` treats it as transient and additionally
    honours an optional ``retry_after`` hint.
    """

    def __init__(self, message: str, *, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


def retry_call[T](
    func: Callable[[], T],
    *,
    attempts: int = DEFAULT_ATTEMPTS,
    backoff_seconds: float = DEFAULT_BACKOFF_SECONDS,
    jitter: float = 0.0,
    retry_on: tuple[type[BaseException], ...] = (Exception,),
    sleep: Callable[[float], None] = time.sleep,
    rng: Callable[[], float] = random.random,
    description: str = "external call",
) -> T:
    """Call ``func`` with bounded exponential-backoff retries.

    Parameters
    ----------
    func
        Zero-argument callable performing the external request.
    attempts
        Total number of tries (must be >= 1). With ``attempts=3`` the call is
        made up to three times before the last exception is re-raised.
    backoff_seconds
        Base delay; the wait before retry *n* is ``backoff_seconds * 2**(n-1)``.
        A :class:`RateLimitedError` with a ``retry_after`` hint overrides the
        computed delay when the hint is larger.
    jitter
        Fractional randomised spread added on top of each computed delay, as
        ``delay * (1 + jitter * rng())`` (``rng`` yields ``[0, 1)``). Defaults
        to ``0.0`` (deterministic schedule); set >0 to de-correlate retries
        across concurrent callers so a transient blip doesn't escalate.
    retry_on
        Exception types treated as transient. Anything else propagates
        immediately (a programming error shouldn't be retried). A
        :class:`RateLimitedError` is always retried regardless of this tuple.
    sleep
        Injectable sleep, defaulting to :func:`time.sleep`.
    rng
        Injectable ``[0, 1)`` source for the jitter, defaulting to
        :func:`random.random` (only consulted when ``jitter`` > 0).
    description
        Human label used in log messages.
    """
    if attempts < 1:
        raise ValueError("attempts must be >= 1")

    def _delay(attempt: int) -> float:
        base = backoff_seconds * (2 ** (attempt - 1))
        return base * (1 + jitter * rng()) if jitter > 0 else base

    last_exc: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return func()
        except RateLimitedError as exc:
            last_exc = exc
            if attempt == attempts:
                break
            delay = _delay(attempt)
            if exc.retry_after is not None:
                delay = max(delay, exc.retry_after)
            log.warning(
                "%s rate-limited (attempt %d/%d); backing off %.2fs",
                description,
                attempt,
                attempts,
                delay,
            )
            sleep(delay)
        except retry_on as exc:
            last_exc = exc
            if attempt == attempts:
                break
            delay = _delay(attempt)
            log.warning(
                "%s failed (attempt %d/%d): %s; retrying in %.2fs",
                description,
                attempt,
                attempts,
                exc,
                delay,
            )
            sleep(delay)

    assert last_exc is not None  # loop always sets it before breaking
    raise last_exc
