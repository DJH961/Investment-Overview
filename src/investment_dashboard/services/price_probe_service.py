"""One-shot single-symbol price probe for the desktop Settings page.

The Connectivity panel shows whether the *last* call to each provider
succeeded, but it can't answer "why won't *this* symbol price?" on demand.
This mirrors the web companion's "Probe a price service" diagnostic
(``web/src/probe.ts``): it fires a single, deliberate request for one
user-chosen symbol against one provider (the keyless yfinance primary or
the Tiingo fallback) and reports the **classified outcome** — the price it
found, or a plain-language verdict naming the likely cause (no token, no
quote for the symbol, rate-limited, unreachable).

It is deliberately self-contained: the provider fetchers are injectable so
the probe is unit-testable without the network, and it never touches the
background refresh caches, budgets or the provider-status log.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Literal

from investment_dashboard.adapters import tiingo_client, yfinance_client
from investment_dashboard.adapters._retry import RateLimitedError

#: Which provider a probe targets. ``yfinance`` is the keyless primary; the
#: ``tiingo`` fallback needs a token (resolved from settings / OS keyring).
ProbeProvider = Literal["yfinance", "tiingo"]

#: Classified verdicts, named so the UI can colour/word them.
ProbeVerdict = Literal[
    "ok",  # a usable price came back for the symbol
    "no-quote",  # reached the provider, but it had no price for this symbol
    "not-configured",  # the Tiingo fallback has no token set
    "rate-limited",  # the provider refused us for sending too many requests
    "unreachable",  # never got a usable response (network/DNS/provider down)
]


@dataclass(frozen=True)
class ProbeOutcome:
    """The structured result of a single probe."""

    provider: ProbeProvider
    provider_label: str
    symbol: str
    price: Decimal | None
    as_of: date | None
    duration_ms: int
    verdict: ProbeVerdict
    detail: str


def probe_provider_label(provider: ProbeProvider) -> str:
    """A short, friendly provider label for headlines."""
    if provider == "yfinance":
        return "yfinance (primary)"
    if provider == "tiingo":
        return "Tiingo (backup)"
    raise ValueError(f"unknown probe provider: {provider!r}")


#: A fetcher returns ``(date, close)`` for a symbol, or ``None`` when the
#: provider was reached but had no price. It may raise to signal a transport or
#: rate-limit failure.
YfinanceFetcher = Callable[[str], "tuple[date, Decimal] | None"]
TiingoFetcher = Callable[[str, str], "tuple[date, Decimal] | None"]


def _default_yfinance_fetcher(symbol: str) -> tuple[date, Decimal] | None:
    record = yfinance_client.fetch_latest_close(symbol)
    if record is None:
        return None
    return record.date, record.close


def _default_tiingo_fetcher(symbol: str, token: str) -> tuple[date, Decimal] | None:
    return tiingo_client.fetch_latest_close(symbol, token=token)


def probe_yfinance(
    symbol: str,
    *,
    fetcher: YfinanceFetcher | None = None,
) -> ProbeOutcome:
    """Probe the keyless yfinance primary for one symbol."""
    fetch = fetcher or _default_yfinance_fetcher
    label = probe_provider_label("yfinance")
    started = time.monotonic()
    try:
        result = fetch(symbol)
    except Exception as exc:
        return _outcome(
            "yfinance",
            label,
            symbol,
            started,
            price=None,
            as_of=None,
            verdict="unreachable",
            detail=f"Could not reach yfinance for {symbol}: {exc}",
        )
    if result is None:
        return _outcome(
            "yfinance",
            label,
            symbol,
            started,
            price=None,
            as_of=None,
            verdict="no-quote",
            detail=(
                f"yfinance returned no recent close for {symbol}. Check the ticker "
                "spelling (yfinance uses suffixes like .L / .DE for some venues)."
            ),
        )
    when, close = result
    return _outcome(
        "yfinance",
        label,
        symbol,
        started,
        price=close,
        as_of=when,
        verdict="ok",
        detail=f"yfinance returned {close} (native currency) as of {when.isoformat()}.",
    )


def probe_tiingo(
    symbol: str,
    *,
    token: str | None,
    fetcher: TiingoFetcher | None = None,
) -> ProbeOutcome:
    """Probe the Tiingo fallback for one symbol.

    ``token`` is the resolved Tiingo token (``None`` disables the fallback).
    """
    fetch = fetcher or _default_tiingo_fetcher
    label = probe_provider_label("tiingo")
    started = time.monotonic()
    if not token:
        return _outcome(
            "tiingo",
            label,
            symbol,
            started,
            price=None,
            as_of=None,
            verdict="not-configured",
            detail=(
                "No Tiingo token set. Add one under Connectivity → Tiingo fallback "
                "to enable the backup price source."
            ),
        )
    try:
        result = fetch(symbol, token)
    except RateLimitedError as exc:
        return _outcome(
            "tiingo",
            label,
            symbol,
            started,
            price=None,
            as_of=None,
            verdict="rate-limited",
            detail=f"Tiingo refused the request (rate limited): {exc}",
        )
    except Exception as exc:
        return _outcome(
            "tiingo",
            label,
            symbol,
            started,
            price=None,
            as_of=None,
            verdict="unreachable",
            detail=f"Could not get a Tiingo quote for {symbol}: {exc}",
        )
    if result is None:
        return _outcome(
            "tiingo",
            label,
            symbol,
            started,
            price=None,
            as_of=None,
            verdict="no-quote",
            detail=f"Tiingo returned no recent close for {symbol}. Check the ticker spelling.",
        )
    when, close = result
    return _outcome(
        "tiingo",
        label,
        symbol,
        started,
        price=close,
        as_of=when,
        verdict="ok",
        detail=f"Tiingo returned {close} (native currency) as of {when.isoformat()}.",
    )


def _outcome(
    provider: ProbeProvider,
    label: str,
    symbol: str,
    started_monotonic: float,
    *,
    price: Decimal | None,
    as_of: date | None,
    verdict: ProbeVerdict,
    detail: str,
) -> ProbeOutcome:
    duration_ms = int((time.monotonic() - started_monotonic) * 1000)
    return ProbeOutcome(
        provider=provider,
        provider_label=label,
        symbol=symbol,
        price=price,
        as_of=as_of,
        duration_ms=duration_ms,
        verdict=verdict,
        detail=detail,
    )
