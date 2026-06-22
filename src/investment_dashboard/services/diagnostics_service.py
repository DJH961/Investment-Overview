"""Data-health diagnostics — one read-only sweep of the *silent* failure modes.

The dashboard degrades gracefully when a price is missing, an FX rate hasn't
been fetched, an import row couldn't be mapped, or a transaction is missing one
of its currency legs. That graceful degradation is good for keeping the UI
alive, but it hides problems: a number quietly reads ``—`` or is computed
against stale data and the user never learns *why*.

This service turns those silent degradations into one explicit, structured
report. It is **read-only** — it never refreshes prices, backfills legs, or
writes anything — so it is safe to call on every render of the Data Health
page (``H1``) and to summarise in the header badge.

Every probe reuses an existing service/repository so the diagnostics can never
disagree with the figures the rest of the app shows.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from investment_dashboard.domain import market_hours
from investment_dashboard.repositories import instrument_overrides_repo, instruments_repo
from investment_dashboard.services import (
    positions_service,
    prices_service,
    provider_status,
    transaction_fx_service,
)

if TYPE_CHECKING:
    from investment_dashboard.models.instrument import Instrument

#: Severity ordering, worst last. Used to roll a set of items up to a single
#: headline severity for the nav badge.
_SEVERITY_RANK: dict[str, int] = {"ok": 0, "warning": 1, "error": 2}

#: How many specific examples (symbols/dates) to keep per item before the UI
#: collapses the rest into a "+N more" note. Keeps the report bounded on a
#: portfolio with hundreds of instruments.
_MAX_EXAMPLES = 25


@dataclass(frozen=True)
class HealthItem:
    """One diagnostic category and its current status."""

    key: str
    title: str
    severity: str  # "ok" | "warning" | "error"
    count: int
    detail: str
    examples: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return self.severity == "ok"


@dataclass(frozen=True)
class HealthReport:
    """The aggregate result of one diagnostics sweep."""

    items: tuple[HealthItem, ...]
    generated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    @property
    def problems(self) -> tuple[HealthItem, ...]:
        """Items that are not ``ok``, worst first."""
        return tuple(
            sorted(
                (i for i in self.items if not i.ok),
                key=lambda i: _SEVERITY_RANK[i.severity],
                reverse=True,
            )
        )

    @property
    def has_problems(self) -> bool:
        return bool(self.problems)

    @property
    def problem_count(self) -> int:
        """Total number of flagged underlying records across every item."""
        return sum(i.count for i in self.problems)

    @property
    def worst_severity(self) -> str:
        """The single headline severity for a badge: worst item wins."""
        if not self.items:
            return "ok"
        return max((i.severity for i in self.items), key=lambda s: _SEVERITY_RANK[s])


def _examples(values: list[str]) -> tuple[str, ...]:
    """Truncate a list of specifics to a bounded set of examples."""
    if len(values) <= _MAX_EXAMPLES:
        return tuple(values)
    return (*values[:_MAX_EXAMPLES], f"+{len(values) - _MAX_EXAMPLES} more")


def _active_instruments(session: Session) -> list[Instrument]:
    """Non-synthetic, user-active instruments — the ones that need live prices."""
    inactive = instrument_overrides_repo.inactive_ids(session)
    return [
        instr
        for instr in instruments_repo.list_instruments(session)
        if instr.asset_class not in prices_service._SYNTHETIC_ASSET_CLASSES
        and instr.id not in inactive
    ]


def _check_fx_legs(session: Session) -> HealthItem:
    """Transactions whose frozen EUR/USD legs are incomplete (an FX gap)."""
    dates: list[date] = transaction_fx_service.missing_fx_dates(session)
    count = len(dates)
    if count == 0:
        return HealthItem(
            key="fx_legs",
            title="Transaction currency legs",
            severity="ok",
            count=0,
            detail="Every transaction has both its EUR and USD legs.",
        )
    return HealthItem(
        key="fx_legs",
        title="Transaction currency legs",
        severity="warning",
        count=count,
        detail=(
            f"{count} trade date(s) have transactions missing a EUR or USD leg "
            "because the FX rate for that day wasn't available. Returns in the "
            "missing currency fall back to a blank rather than a wrong number. "
            "Use Settings → Data refresh → Refresh FX rates, which backfills the "
            "frozen legs once the rate is cached."
        ),
        examples=_examples([d.isoformat() for d in dates]),
    )


def _check_prices(session: Session) -> list[HealthItem]:
    """Missing, stale, and corrupt (non-positive) price coverage."""
    actives = _active_instruments(session)
    active_ids = [i.id for i in actives]

    missing: list[str] = []
    have_price_ids: list[int] = []
    for instr in actives:
        if prices_service.latest_close(session, instr.id) is None:
            missing.append(instr.symbol)
        else:
            have_price_ids.append(instr.id)

    # "Stale" = the newest cached close is more than one trading day behind, so
    # a fresh price genuinely failed to land (the provider is likely failing for
    # that symbol). A price that is merely past its short internal refresh TTL —
    # the normal state overnight, at weekends, or seconds after a tick — is *not*
    # stale: it still reflects the latest settled session, so flagging it just
    # produces a permanent warning the user can never clear. We compare each
    # instrument's latest close *date* against the previous trading day (a one
    # trading-day grace that absorbs "today's close hasn't been fetched yet").
    price_dates = prices_service.latest_price_dates_for(session, have_price_ids)
    cutoff = market_hours.previous_trading_day(date.today())
    have_price = set(have_price_ids)
    stale = sorted(
        instr.symbol
        for instr in actives
        if instr.id in have_price
        and (as_of := price_dates.get(instr.id)) is not None
        and as_of < cutoff
    )

    anomalies_ids = prices_service.instruments_with_price_anomalies(session, active_ids)
    by_id = {i.id: i for i in actives}
    anomalies = sorted(by_id[i].symbol for i in anomalies_ids if i in by_id)

    items: list[HealthItem] = []

    if missing:
        items.append(
            HealthItem(
                key="prices_missing",
                title="Instruments with no price",
                severity="error",
                count=len(missing),
                detail=(
                    f"{len(missing)} active instrument(s) have no cached price at "
                    "all, so their holdings value as blank and are excluded from "
                    "totals. Check the symbol is correct and run Settings → Data "
                    "refresh → Refresh prices."
                ),
                examples=_examples(sorted(missing)),
            )
        )
    else:
        items.append(
            HealthItem(
                key="prices_missing",
                title="Instruments with no price",
                severity="ok",
                count=0,
                detail="Every active instrument has a cached price.",
            )
        )

    if stale:
        items.append(
            HealthItem(
                key="prices_stale",
                title="Stale prices",
                severity="warning",
                count=len(stale),
                detail=(
                    f"{len(stale)} instrument(s) are more than a trading day "
                    "behind: their newest cached close predates the last "
                    "completed session, so a background refresh has not landed a "
                    "fresh price. The dashboard keeps using the last good price "
                    "meanwhile; a persistently stale instrument usually means the "
                    "provider is failing for that symbol."
                ),
                examples=_examples(stale),
            )
        )

    if anomalies:
        items.append(
            HealthItem(
                key="prices_anomaly",
                title="Corrupt price history",
                severity="error",
                count=len(anomalies),
                detail=(
                    f"{len(anomalies)} instrument(s) have a non-positive close in "
                    "their price history, which forward-fills into historical "
                    "valuations and understates them. Refresh prices to overwrite "
                    "the bad tick."
                ),
                examples=_examples(anomalies),
            )
        )

    return items


def _check_positions(session: Session) -> HealthItem:
    """Holdings that have shares but value to nothing (a missing price as-of)."""
    positions = positions_service.compute_positions(session)
    flagged = sorted({p.instrument.symbol for p in positions if getattr(p, "value_warning", False)})
    if not flagged:
        return HealthItem(
            key="position_value",
            title="Holdings without a value",
            severity="ok",
            count=0,
            detail="Every holding with shares also has a current value.",
        )
    return HealthItem(
        key="position_value",
        title="Holdings without a value",
        severity="warning",
        count=len(flagged),
        detail=(
            f"{len(flagged)} holding(s) hold shares but currently value to zero, "
            "which means the price for that instrument couldn't be resolved. The "
            "position is shown but contributes nothing to the portfolio total."
        ),
        examples=_examples(flagged),
    )


def _check_providers() -> HealthItem:
    """Last outcome of each external data provider (yfinance / Frankfurter)."""
    latest = provider_status.all_latest()
    if not latest:
        return HealthItem(
            key="providers",
            title="Data providers",
            severity="ok",
            count=0,
            detail=(
                "No provider calls have been made yet this session. Status "
                "appears here after the first price/FX refresh."
            ),
        )
    failing = sorted(
        f"{name}: {event.message}" for name, event in latest.items() if event.status == "error"
    )
    partial = sorted(name for name, event in latest.items() if event.status == "partial")
    if failing:
        return HealthItem(
            key="providers",
            title="Data providers",
            severity="error",
            count=len(failing),
            detail=(
                "The last call to one or more data providers failed. Live prices "
                "and FX rates won't update until the provider recovers."
            ),
            examples=_examples(failing),
        )
    if partial:
        return HealthItem(
            key="providers",
            title="Data providers",
            severity="warning",
            count=len(partial),
            detail=(
                "A provider returned only partial data on its last call (some "
                "symbols missing). The present figures are still usable."
            ),
            examples=_examples(partial),
        )
    return HealthItem(
        key="providers",
        title="Data providers",
        severity="ok",
        count=0,
        detail="Every data provider's last call succeeded.",
    )


def check_health(session: Session) -> HealthReport:
    """Run every read-only data-health probe and return one aggregate report.

    Safe to call on every render: it performs no network calls and never
    mutates the database — it only reads what the rest of the app already
    computed and reports the silent-degradation signals in one place.
    """
    items: list[HealthItem] = [
        _check_fx_legs(session),
        *_check_prices(session),
        _check_positions(session),
        _check_providers(),
    ]
    return HealthReport(items=tuple(items))


def quick_status(session: Session) -> tuple[str, int]:
    """Cheap headline ``(worst_severity, problem_count)`` for the nav badge.

    Runs only the inexpensive probes (FX legs, price coverage, providers) and
    deliberately skips the full positions walk so it is light enough to call on
    every page-header render. The dedicated Data Health page runs the complete
    :func:`check_health` sweep.
    """
    items: list[HealthItem] = [
        _check_fx_legs(session),
        *_check_prices(session),
        _check_providers(),
    ]
    report = HealthReport(items=tuple(items))
    return report.worst_severity, report.problem_count
