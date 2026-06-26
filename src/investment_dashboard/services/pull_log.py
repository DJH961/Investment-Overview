"""A single, readable narrative for every *data-pulling round*.

Pulling fresh prices used to scatter half a dozen unrelated ``log.info`` lines
across :mod:`prices_service`, the Tiingo fallback and the retry helper, with no
way to tell *who* asked for a pull, *what* actually settled, *what* failed, or
*how much* of the free Tiingo budget was left afterwards. Reading the log was an
exercise in detective work.

This module turns one pull into one coherent story. A :class:`PullRound` is
opened when a refresh begins (the live tick, a manual click, the startup
backfill, …) and stored in a :class:`~contextvars.ContextVar`, so the deep
service/adapter code can append events to *the round already in flight* without
threading an object through every signature. The round:

* prints a clear ``START`` banner naming the **trigger** ("who started it") and
  the **mode** (auto/TTL-due, manual full re-pull, startup backfill, …);
* narrates each step with a stable, greppable ``pull <id> | …`` prefix — what
  was requested, what **settled** (fresh closes), what **failed** or came back
  **suspect** (zero/negative closes), each **backoff**, and any **Tiingo
  fallback** with the **budget remaining** after it;
* prints an ``END`` banner with a one-line summary (closes written, symbols
  fresh, Tiingo coverage, failures, backoffs, elapsed) so the start *and* end of
  every round are unmistakable.

Everything is best-effort: a missing/short message never raises, and when no
round is active the helper functions degrade to a plain log line so a direct,
un-wrapped call (e.g. the Settings button) still says something useful.

The store is per-thread (a ``ContextVar``), which is exactly right here: each
refresh runs on its own daemon thread, so two overlapping pulls (the startup
backfill and a live tick) keep independent, non-interleaving round ids.
"""

from __future__ import annotations

import contextlib
import logging
import time as _time
import uuid
from collections.abc import Iterator, Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import date

log = logging.getLogger("investment_dashboard.pull")

#: Width of the START/END banner rules (kept modest so they read on a phone-
#: sized terminal too). ``cp1252``-safe characters only, so the Windows console
#: stream handler never trips on an un-encodable glyph.
_BANNER_WIDTH = 64

_current: ContextVar[PullRound | None] = ContextVar("current_pull_round", default=None)


def _banner(label: str) -> str:
    """Center ``label`` on a fixed-width rule of ``=`` signs."""
    text = f" {label} "
    if len(text) >= _BANNER_WIDTH:
        return text.strip()
    pad = _BANNER_WIDTH - len(text)
    left = pad // 2
    right = pad - left
    return f"{'=' * left}{text}{'=' * right}"


@dataclass
class _ProviderTally:
    """What one provider (yfinance / Tiingo) achieved this round."""

    requested: int = 0
    fresh: list[str] = field(default_factory=list)
    closes: int = 0
    failed: bool = False


@dataclass
class PullRound:
    """A live, in-progress data-pulling round that narrates itself to the log.

    Construct via :func:`begin` (or :func:`round_scope`) so it is registered as
    the active round; close via :meth:`finish`. Event methods are safe to call
    in any order and never raise.
    """

    trigger: str
    mode: str
    rid: str = field(default_factory=lambda: uuid.uuid4().hex[:4])
    _started_at: float = field(default_factory=_time.monotonic)
    _providers: dict[str, _ProviderTally] = field(default_factory=dict)
    _suspect: list[str] = field(default_factory=list)
    _backoffs: int = 0
    _finished: bool = False

    # -- internals ---------------------------------------------------------
    def _tag(self, message: str) -> str:
        return f"pull {self.rid} | {message}"

    def _tally(self, provider: str) -> _ProviderTally:
        return self._providers.setdefault(provider, _ProviderTally())

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        """Print the START banner (called once by :func:`begin`)."""
        log.info(_banner(f"PULL {self.rid} START"))
        log.info(self._tag(f"trigger: {self.trigger}  |  mode: {self.mode}"))

    def finish(self) -> None:
        """Print the END summary + banner; idempotent and never raises."""
        if self._finished:
            return
        self._finished = True
        elapsed = _time.monotonic() - self._started_at
        total_closes = sum(t.closes for t in self._providers.values())
        fresh_syms = {s for t in self._providers.values() for s in t.fresh}
        requested = max((t.requested for t in self._providers.values()), default=0)
        tiingo = self._providers.get("tiingo")
        tiingo_n = len(tiingo.fresh) if tiingo else 0
        failed = [p for p, t in self._providers.items() if t.failed]

        parts = [
            f"{total_closes} close(s) written",
            f"{len(fresh_syms)}/{requested} symbol(s) fresh",
        ]
        if tiingo_n:
            parts.append(f"{tiingo_n} via Tiingo")
        if self._suspect:
            parts.append(f"{len(self._suspect)} suspect")
        if failed:
            parts.append(f"failed: {', '.join(sorted(failed))}")
        if self._backoffs:
            parts.append(f"backoff x{self._backoffs}")
        parts.append(f"{elapsed:.2f}s")

        level = logging.WARNING if (failed or self._suspect) else logging.INFO
        log.log(level, self._tag("summary: " + "  |  ".join(parts)))
        log.info(_banner(f"PULL {self.rid} END ({elapsed:.2f}s)"))

    # -- events ------------------------------------------------------------
    def requested_window(
        self,
        provider: str,
        symbols: Sequence[str],
        start: date,
        end: date,
        *,
        detail: str | None = None,
    ) -> None:
        """Record that ``provider`` was asked for ``symbols`` over a window."""
        self._tally(provider).requested = len(symbols)
        suffix = f" ({detail})" if detail else ""
        log.info(
            self._tag(
                f"{provider}: requesting {len(symbols)} symbol(s) "
                f"over {start}..{end}{suffix}: {', '.join(sorted(symbols)) or 'none'}"
            )
        )

    def settled(self, provider: str, result: Mapping[str, int]) -> None:
        """Record what ``provider`` actually returned (``{symbol: rows}``)."""
        tally = self._tally(provider)
        fresh = sorted(s for s, n in result.items() if n)
        tally.fresh = fresh
        tally.closes += sum(result.values())
        # Keep the "fresh / requested" denominator sensible even if a caller
        # records a result without a preceding ``requested_window`` call.
        tally.requested = max(tally.requested, len(result))
        if fresh:
            log.info(
                self._tag(
                    f"{provider}: settled {len(fresh)}/{len(result)} symbol(s), "
                    f"{sum(result.values())} new close(s): {', '.join(fresh)}"
                )
            )
        else:
            # Nothing new is normal after hours / before a NAV posts — keep it
            # quiet (no WARNING, so no toast) but still on the record.
            log.info(
                self._tag(f"{provider}: no new closes ({len(result)} symbol(s) already current)")
            )

    def provider_failed(self, provider: str, detail: str) -> None:
        """Record a hard provider failure (logged at WARNING)."""
        self._tally(provider).failed = True
        log.warning(self._tag(f"{provider}: FAILED — {detail}"))

    def suspect_data(self, provider: str, symbols: Sequence[str]) -> None:
        """Record symbols whose freshly-pulled close looks corrupt (<= 0)."""
        syms = [s for s in symbols if s]
        if not syms:
            return
        self._suspect.extend(syms)
        log.warning(
            self._tag(
                f"{provider}: SUSPECT data (non-positive close) for: {', '.join(sorted(syms))}"
            )
        )

    def backoff(
        self, description: str, attempt: int, attempts: int, delay: float, *, reason: str
    ) -> None:
        """Record one retry/backoff wait (logged at WARNING)."""
        self._backoffs += 1
        log.warning(
            self._tag(
                f"backed off ({reason}): {description} attempt {attempt}/{attempts}, "
                f"waiting {delay:.2f}s"
            )
        )

    def fallback(self, provider: str, result: Mapping[str, int], reasons: Sequence[str]) -> None:
        """Record a successful fallback that covered a primary gap."""
        tally = self._tally(provider)
        used = sorted(result)
        tally.fresh = used
        tally.requested = max(tally.requested, len(result))
        tally.closes += sum(result.values())
        why = "; ".join(r for r in reasons if r)
        log.info(
            self._tag(
                f"{provider} FALLBACK covered {len(used)} symbol(s), "
                f"{sum(result.values())} close(s): {', '.join(used)}"
                + (f"  [{why}]" if why else "")
            )
        )

    def budget(
        self,
        provider: str,
        *,
        hour_remaining: int,
        hourly_cap: int,
        day_remaining: int,
        daily_cap: int,
    ) -> None:
        """Record how much free-tier budget is left after a fallback round."""
        log.info(
            self._tag(
                f"{provider} budget remaining: {hour_remaining}/{hourly_cap} this hour, "
                f"{day_remaining}/{daily_cap} today"
            )
        )

    def note(self, message: str) -> None:
        """Record a free-form, low-priority step (logged at INFO)."""
        log.info(self._tag(message))


# --- module-level helpers ----------------------------------------------------


def current() -> PullRound | None:
    """Return the pull round in flight on this thread, or ``None``."""
    return _current.get()


def begin(trigger: str, *, mode: str) -> PullRound:
    """Open a pull round, register it as current, and print its START banner."""
    round_ = PullRound(trigger=trigger, mode=mode)
    _current.set(round_)
    round_.start()
    return round_


def end(round_: PullRound) -> None:
    """Close ``round_``: print its END summary and clear the active slot."""
    round_.finish()
    if _current.get() is round_:
        _current.set(None)


@contextlib.contextmanager
def round_scope(trigger: str, *, mode: str) -> Iterator[PullRound]:
    """Context manager opening a round for ``trigger`` and closing it on exit."""
    round_ = begin(trigger, mode=mode)
    try:
        yield round_
    finally:
        end(round_)


def reset() -> None:
    """Clear any active round. Test-only helper."""
    _current.set(None)
