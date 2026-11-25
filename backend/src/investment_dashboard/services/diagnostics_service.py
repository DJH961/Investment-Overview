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

import time
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.domain import ledger_completeness, market_hours
from investment_dashboard.domain.instruments import SYNTHETIC_ASSET_CLASSES
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.domain.money_market import is_money_market
from investment_dashboard.repositories import (
    accounts_repo,
    instrument_overrides_repo,
    instruments_repo,
    transactions_repo,
)
from investment_dashboard.services import (
    cashflows,
    fx_service,
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

#: Staleness grace, in *trading days*, before a price counts as genuinely stale.
#: One settled day is normal (today's close may not be fetched yet); the second
#: absorbs a single exchange holiday — which our weekday-only market clock would
#: otherwise mistake for a missed session and flag the morning after a long
#: weekend.
_STALE_GRACE_TRADING_DAYS = 2

#: Extra leeway for mutual funds (incl. money-market sweeps). Their NAV publishes
#: only once a day and routinely lands a day late, so they are legitimately
#: "behind" far more often than an exchange-traded instrument; flagging them on
#: the equity cadence produces a warning the user can never clear.
_MUTUAL_FUND_STALE_GRACE_TRADING_DAYS = 4

#: ``asset_class`` value shared by mutual funds and money-market sweeps.
_MUTUAL_FUND_ASSET_CLASS = "mutual_fund"


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
        if instr.asset_class not in SYNTHETIC_ASSET_CLASSES and instr.id not in inactive
    ]


#: Default for setting ``fx.stale_after_seconds`` (Settings > Data refresh).
FX_STALE_AFTER_SECONDS = 900


def _fx_stale_after_seconds() -> float:
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    try:
        return float(settings_service.get_or("fx.stale_after_seconds", FX_STALE_AFTER_SECONDS))
    except Exception:  # pragma: no cover - settings unreadable: keep the default
        return float(FX_STALE_AFTER_SECONDS)


def _hhmm(at: datetime) -> str:
    return at.astimezone(UTC).strftime("%H:%M UTC")


def _check_fx_live(session: Session, *, now: datetime | None = None) -> HealthItem:
    """Whether "now" is marked with a working live EUR/USD rate.

    The ECB fixing is each date's official rate, never a fault in itself: this only
    warns when a live rate *should* exist and does not, or has stopped moving. While
    currencies trade (Sunday 17:00 to Friday 17:00 ET) that is: no live rate at all,
    no refresh for longer than ``fx.stale_after_seconds``, or the same rate re-served
    for that long (a frozen feed). Over the weekend Friday's closing rate is expected;
    only its absence (a restart the backfill could not recover from) warns.
    """
    now = (now or datetime.now(UTC)).astimezone(UTC)
    title = "Live EUR/USD rate"
    spot = fx_service.active_live_spot("USD", now=now)

    def _warn(detail: str) -> HealthItem:
        info = fx_service.eur_quote_as_of(session, now=now)
        stand_in = (
            f" The ECB rate of {info.as_of.isoformat()} stands in for now."
            if info is not None and info.source == "eod"
            else ""
        )
        return HealthItem(
            key="fx_live",
            title=title,
            severity="warning",
            count=1,
            detail=detail
            + stand_in
            + " Run 'Refresh live FX rate now' to fetch it again; if the EUR 1D / 1W line"
            " has holes, 'Reload 1D / 1W graphs (prices + EUR/USD)' re-downloads its"
            " minute rates.",
        )

    if not market_hours.is_forex_market_open(now):
        if spot is None:
            return _warn("The currency market is closed and its last closing rate is missing.")
        return HealthItem(
            key="fx_live",
            title=title,
            severity="ok",
            count=0,
            detail=f"Currency market closed: showing its last close ({spot.rate}).",
        )
    if spot is None or spot.observed_at is None:
        return _warn("The currency market is open but there is no live EUR/USD rate.")
    limit = _fx_stale_after_seconds()
    minutes = round(limit / 60)
    if (now - spot.observed_at).total_seconds() > limit:
        return _warn(
            f"The live EUR/USD rate was last refreshed at {_hhmm(spot.observed_at)}, "
            f"more than {minutes} min ago."
        )
    changed = fx_service.live_spot_changed_at("USD")
    if changed is not None and (now - changed).total_seconds() > limit:
        return _warn(
            f"The live EUR/USD rate has not moved since {_hhmm(changed)} (over {minutes} min) "
            "while currencies trade: the feed may be frozen."
        )
    return HealthItem(
        key="fx_live",
        title=title,
        severity="ok",
        count=0,
        detail=f"Live EUR/USD {spot.rate}, refreshed at {_hhmm(spot.observed_at)}.",
    )


def _check_fx_legs(session: Session) -> HealthItem:
    """Transactions whose derived EUR/USD legs are incomplete (an FX gap).

    The legs come from ``net_native`` and that date's rate (P19); a gap means
    no EUR→USD rate on or before the trade date (or a third currency).
    """
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
            "Use Settings → Data refresh → Refresh FX rates; the legs fill in "
            "by themselves once the rate is cached."
        ),
        examples=_examples([d.isoformat() for d in dates]),
    )


#: Relative gap between a frozen leg and the one derived from ``net_native`` + the
#: FX table above which a transaction is flagged (0.5 %).
FROZEN_LEG_TOLERANCE = Decimal("0.005")


def _leg_differs(
    frozen: Decimal | None, derived: Decimal | None, tolerance: Decimal = FROZEN_LEG_TOLERANCE
) -> bool:
    if frozen is None or derived is None:
        return False
    scale = max(abs(frozen), abs(derived))
    if scale == 0:
        return False
    return abs(frozen - derived) / scale > tolerance


def _check_frozen_legs(session: Session) -> HealthItem:
    """Rows whose frozen ``net_eur``/``net_usd`` disagree with the derived legs.

    The cash legs are derived from ``net_native`` + the FX table; the frozen
    legs are read-only cross-checks (kept for the v5 rollback). A gap above
    0.5 % means the stored leg was struck at a different rate than the table.
    """
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    tol = settings_service.get_or("diagnostics.frozen_leg_tolerance", FROZEN_LEG_TOLERANCE, session)
    rates = fx_service.get_rates(session, base="EUR", quote="USD")
    bad: list[str] = []
    for t in transactions_repo.list_transactions(session):
        if _leg_differs(t.net_eur, cashflows.derived_eur(t, rates), tol) or _leg_differs(
            t.net_usd, cashflows.derived_usd(t, rates), tol
        ):
            bad.append(t.date.isoformat())
    if not bad:
        return HealthItem(
            key="frozen_legs",
            title="Frozen vs derived currency legs",
            severity="ok",
            count=0,
            detail="Every frozen EUR/USD leg matches the leg derived from the native amount.",
        )
    return HealthItem(
        key="frozen_legs",
        title="Frozen vs derived currency legs",
        severity="warning",
        count=len(bad),
        detail=(
            f"{len(bad)} transaction(s) have a frozen EUR or USD leg that differs "
            "from the leg derived from the native amount and the FX table by more "
            f"than {(tol * 100).normalize():f} %. Reports use the derived leg."
        ),
        examples=_examples(bad),
    )


#: Ledger cash below this (native units) counts as zero: rounding dust, not cash.
_CASH_DUST = Decimal("0.005")


def check_unconverted_deposits(session: Session) -> HealthItem:
    """Deposits valued at the ECB rate with no conversion (7.3): an *info* note, never a problem.

    The owner always has a few (dollars received directly, old deposits), so this is
    deliberately quiet: severity is ``info`` or ``ok``, it is not part of
    :func:`check_health` (so it never raises the badge or the problem count) and
    deposits marked "Received in USD (no conversion)" are left out. The Data Health
    read-model shows it and links to the Conversions page.
    """
    from investment_dashboard.services import fx_conversion_service  # noqa: PLC0415

    report = fx_conversion_service.pool_report(session)
    key, title = "ecb_fallback_deposits", "Deposits valued at the ECB rate"
    if not report.conversions:
        return HealthItem(
            key=key,
            title=title,
            severity="ok",
            count=0,
            detail="No currency conversions recorded, so deposits use their trade-date rate.",
        )
    fallen = fx_conversion_service.unconverted_deposits(report)
    if not fallen:
        return HealthItem(
            key=key,
            title=title,
            severity="ok",
            count=0,
            detail="Every USD deposit is covered by a conversion or marked as received in USD.",
        )
    return HealthItem(
        key=key,
        title=title,
        severity="info",
        count=len(fallen),
        detail=(
            f"{len(fallen)} deposits valued at the ECB rate with no conversion. "
            "Add the conversion, or mark a deposit as received in USD on the Conversions page."
        ),
        examples=tuple(f"{m.date.isoformat()} ({m.fallback_usd:f} USD)" for m in fallen[:5]),
    )


def _check_brokerage_cash(session: Session) -> HealthItem:
    """Brokerage accounts whose ledger cash balance is not zero (B-017, check only).

    Cash that sits in a brokerage account is valued only when it is booked as a
    money-market fund position (those legs net the cash move to zero). A non-zero
    ledger cash balance is therefore cash the portfolio total does not count. This
    only reports it; the valuation is unchanged.
    """
    flagged: list[str] = []
    for account in accounts_repo.list_accounts(session):
        if account.account_type != "brokerage":
            continue
        balance = positions_service.compute_cash_balance(session, account.id)
        if abs(balance) >= _CASH_DUST:
            flagged.append(
                f"{account.broker} {account.account_label}: "
                f"{balance:+,.2f} {account.native_currency.upper()}"
            )
    if not flagged:
        return HealthItem(
            key="brokerage_cash",
            title="Uninvested brokerage cash",
            severity="ok",
            count=0,
            detail="Every brokerage account's cash is booked in a money-market fund or is zero.",
        )
    return HealthItem(
        key="brokerage_cash",
        title="Uninvested brokerage cash",
        severity="warning",
        count=len(flagged),
        detail=(
            f"{len(flagged)} brokerage account(s) have a non-zero ledger cash balance "
            "that is not booked as a money-market fund position. That cash is not "
            "part of the portfolio total, so total value, capital gain and XIRR can "
            "be understated by it."
        ),
        examples=_examples(flagged),
    )


def _check_missing_dividends(session: Session, *, today: date | None = None) -> HealthItem:
    """Provider ex-dividend dates with shares held but no dividend row (v7 P7, hints only).

    Reads the ex-dates cached by the history refresh
    (:mod:`~investment_dashboard.services.dividend_history_service`); makes no provider
    call. Money-market funds are judged per month, everything else per ex-date.
    """
    from investment_dashboard.services import dividend_history_service  # noqa: PLC0415

    today = today or exchange_today()
    ex_dates = dividend_history_service.load(session)
    title = "Possibly missing dividends"
    if not ex_dates:
        return HealthItem(
            key="missing_dividends",
            title=title,
            severity="ok",
            count=0,
            detail="No provider dividend history cached yet: it is fetched with the history refresh.",
        )
    events: dict[int, list[ledger_completeness.LedgerEvent]] = {}
    for t in transactions_repo.list_transactions(session):
        if t.instrument_id is None:
            continue
        events.setdefault(t.instrument_id, []).append(
            ledger_completeness.LedgerEvent(date=t.date, kind=t.kind, quantity=t.quantity)
        )
    hints: list[str] = []
    for instr in instruments_repo.list_instruments(session):
        dates = ex_dates.get(instr.id)
        rows = events.get(instr.id)
        if not dates or not rows:
            continue
        if is_money_market(instr.symbol, asset_class=instr.asset_class, name=instr.name):
            missing = ledger_completeness.find_missing_money_market_distributions(
                dates, rows, today=today
            )
        else:
            missing = ledger_completeness.find_missing_dividends(dates, rows, today=today)
        hints.extend(
            f"possible missing dividend: {instr.symbol}, ex-date {m.ex_date.isoformat()}, "
            f"{m.shares_held.normalize():f} shares held"
            for m in missing
        )
    if not hints:
        return HealthItem(
            key="missing_dividends",
            title=title,
            severity="ok",
            count=0,
            detail="Every provider dividend on shares you held has a matching ledger row.",
        )
    return HealthItem(
        key="missing_dividends",
        title=title,
        severity="warning",
        count=len(hints),
        detail=(
            f"{len(hints)} dividend(s) the data provider reports on shares you held have no "
            "dividend or reinvestment row in the ledger within 60 days (money-market funds: "
            "no distribution in the month). Hints only: check the broker statement, nothing "
            "is changed automatically."
        ),
        examples=_examples(hints),
    )


def _ledger_events_by_instrument(
    session: Session,
) -> dict[int, list[ledger_completeness.LedgerEvent]]:
    events: dict[int, list[ledger_completeness.LedgerEvent]] = {}
    for t in transactions_repo.list_transactions(session):
        if t.instrument_id is None:
            continue
        events.setdefault(t.instrument_id, []).append(
            ledger_completeness.LedgerEvent(
                date=t.date, kind=t.kind, quantity=t.quantity, account_id=t.account_id
            )
        )
    return events


def _provider_splits(session: Session, instrument_id: int) -> list[tuple[date, Decimal]]:
    """The feed's cached splits (manual entries are the owner's own and are left out)."""
    return [
        (on, ratio)
        for on, ratio, source in prices_service.list_splits(session, instrument_id)
        if source != prices_service.MANUAL_SOURCE
    ]


def _check_splits(session: Session) -> list[HealthItem]:
    """Provider splits missing from the ledger, and ledger splits the provider lacks (hints).

    Reads the splits cached by the split refresh through ``prices_service``; no provider call.
    """
    events = _ledger_events_by_instrument(session)
    missing: list[str] = []
    unmatched: list[str] = []
    for instr in instruments_repo.list_instruments(session):
        rows = events.get(instr.id)
        if not rows or instr.asset_class in SYNTHETIC_ASSET_CLASSES:
            continue
        provider = _provider_splits(session, instr.id)
        missing.extend(
            f"possible missing split: {instr.symbol}, {m.date.isoformat()}, "
            f"ratio {m.ratio.normalize():f}, {m.shares_held.normalize():f} shares held"
            for m in ledger_completeness.find_missing_splits(provider, rows)
        )
        unmatched.extend(
            f"ledger split without a provider split: {instr.symbol}, {s.date.isoformat()}, "
            f"ratio {s.ratio.normalize():f}"
            for s in ledger_completeness.find_unmatched_ledger_splits(provider, rows)
        )
    return [
        HealthItem(
            key="missing_splits",
            title="Possibly missing splits",
            severity="warning" if missing else "ok",
            count=len(missing),
            detail=(
                f"{len(missing)} split(s) the data provider reports on shares you held have no "
                "matching split row in the ledger (same ratio, within 3 days). Hints only: "
                "check the broker statement, nothing is changed automatically."
                if missing
                else "Every provider split on shares you held has a matching ledger split row."
            ),
            examples=_examples(missing),
        ),
        HealthItem(
            key="unmatched_ledger_splits",
            title="Ledger splits the provider does not know",
            severity="warning" if unmatched else "ok",
            count=len(unmatched),
            detail=(
                f"{len(unmatched)} split row(s) in the ledger have no matching provider split "
                "(it may simply not be fetched yet). A softer hint: check the ratio and date."
                if unmatched
                else "Every ledger split row has a matching provider split."
            ),
            examples=_examples(unmatched),
        ),
    ]


def _check_share_counts(session: Session) -> HealthItem:
    """Ledger shares against the counts the owner typed from the broker (optional, hints)."""
    from investment_dashboard.services import broker_share_counts_service  # noqa: PLC0415

    title = "Share counts against the broker"
    typed = {(a, i): s for a, i, s in broker_share_counts_service.load(session)}
    if not typed:
        return HealthItem(
            key="share_counts",
            title=title,
            severity="ok",
            count=0,
            detail="Not set up: type the share counts your broker shows to enable this check.",
        )
    totals = ledger_completeness.ledger_share_totals(_ledger_events_by_instrument(session))
    mismatches = ledger_completeness.find_share_count_mismatches(totals, typed)
    if not mismatches:
        return HealthItem(
            key="share_counts",
            title=title,
            severity="ok",
            count=0,
            detail=f"All {len(typed)} typed share count(s) match the ledger.",
        )
    symbols = {i.id: i.symbol for i in instruments_repo.list_instruments(session)}
    names = {a.id: f"{a.broker} {a.account_label}" for a in accounts_repo.list_accounts(session)}
    lines = [
        f"share count differs: {symbols.get(m.instrument_id, m.instrument_id)} in "
        f"{names.get(m.account_id, m.account_id)}, ledger {m.ledger.normalize():f}, "
        f"broker {m.typed.normalize():f}"
        for m in mismatches
    ]
    return HealthItem(
        key="share_counts",
        title=title,
        severity="warning",
        count=len(mismatches),
        detail=(
            f"{len(mismatches)} share count(s) you typed differ from the ledger. Hints only: "
            "a missing buy, sale, split or reinvestment is the usual cause."
        ),
        examples=_examples(lines),
    )


#: An account with no import for this many days is mentioned in the import-age hint.
_IMPORT_STALE_DAYS = 45


def _check_import_age(session: Session, *, today: date | None = None) -> HealthItem:
    """Days since the last import per account (hint only)."""
    from investment_dashboard.repositories import import_batches_repo  # noqa: PLC0415

    today = today or exchange_today()
    last = import_batches_repo.last_import_by_account(session)
    lines: list[str] = []
    stale = 0
    for account in accounts_repo.list_accounts(session):
        if account.account_type != "brokerage":
            continue
        at = last.get(account.id)
        days = ledger_completeness.days_since(at.date() if at else None, today)
        name = f"{account.broker} {account.account_label}"
        if days is None:
            lines.append(f"{name}: never imported")
            continue
        lines.append(f"{name}: {days} day(s) since the last import")
        if days > _IMPORT_STALE_DAYS:
            stale += 1
    return HealthItem(
        key="import_age",
        title="Days since the last import",
        severity="warning" if stale else "ok",
        count=stale,
        detail=(
            f"{stale} brokerage account(s) have not been imported for over "
            f"{_IMPORT_STALE_DAYS} days: new dividends and trades may be missing."
            if stale
            else "Every imported brokerage account was imported recently."
        ),
        examples=_examples(lines),
    )


#: Backup age (7.4): a warning after this many days without a snapshot ...
_BACKUP_WARN_DAYS = 2
#: ... and an error after this many.
_BACKUP_ERROR_DAYS = 7


def check_backup_age(*, now: datetime | None = None) -> HealthItem:
    """Days since the newest backup snapshot (7.4, lane E)."""
    from investment_dashboard.services import backup_service  # noqa: PLC0415

    title = "Backup age"
    if not backup_service.is_configured():
        return HealthItem(
            key="backup_age",
            title=title,
            severity="ok",
            count=0,
            detail="Backups are not set up on this machine.",
        )
    last = backup_service.last_snapshot_time()
    moment = now or datetime.now(UTC)
    if last is None:
        return HealthItem(
            key="backup_age",
            title=title,
            severity="error",
            count=1,
            detail="No backup snapshot exists yet. Run a backup from Settings.",
        )
    age = moment - last
    days = age.days
    when = f"{last.day} {last.strftime('%b %Y')}, {_hhmm(last)}"
    if age > timedelta(days=_BACKUP_ERROR_DAYS):
        severity = "error"
    elif age > timedelta(days=_BACKUP_WARN_DAYS):
        severity = "warning"
    else:
        severity = "ok"
    hours = int(age.total_seconds() // 3600)
    ago = f"{days} day(s)" if days >= 1 else f"{hours} hour(s)"
    detail = (
        f"The last backup is {ago} old ({when})."
        if severity == "ok"
        else f"The last backup is {ago} old ({when}). Backups should run every night: "
        "check the backup job on this page."
    )
    return HealthItem(
        key="backup_age",
        title=title,
        severity=severity,
        count=0 if severity == "ok" else 1,
        detail=detail,
    )


def check_eod_steps(session: Session) -> HealthItem:
    """Which steps of the last end-of-day job failed (7.4, lane E)."""
    from investment_dashboard.db import config_read_session  # noqa: PLC0415
    from investment_dashboard.services import scheduler  # noqa: PLC0415

    with config_read_session(session) as cfg:
        at, steps = scheduler.load_eod_result(cfg)
    title = "End-of-day job"
    if at is None:
        return HealthItem(
            key="eod_steps",
            title=title,
            severity="ok",
            count=0,
            detail="The end-of-day job has not run on this server yet.",
        )
    when = f"{at.day} {at.strftime('%b %Y')}, {_hhmm(at)}"
    if not steps:
        return HealthItem(
            key="eod_steps",
            title=title,
            severity="ok",
            count=0,
            detail=f"Every step of the last end-of-day job ({when}) finished.",
        )
    names = [s.removeprefix("_").replace("_", " ") for s in steps]
    return HealthItem(
        key="eod_steps",
        title=title,
        severity="warning",
        count=len(steps),
        detail=(
            f"{len(steps)} step(s) of the last end-of-day job ({when}) failed. "
            "The activity log (market data) has the details; the next run tries again."
        ),
        examples=_examples(names),
    )


def _check_estimated_rows(session: Session) -> HealthItem:
    """One quiet prompt for recurring-plan est. rows still to settle (7.3, P14)."""
    from investment_dashboard.repositories import recurring_repo  # noqa: PLC0415
    from investment_dashboard.services import recurring_service  # noqa: PLC0415

    txns = recurring_repo.list_estimate_transactions(session)
    convs = recurring_repo.list_estimate_conversions(session)
    count = recurring_service.estimate_count(session)  # a plan's due date is one item
    lines = [f"Buy on {t.date.isoformat()}" for t in txns[:3]] + [
        f"Conversion on {c.date.isoformat()}" for c in convs[:3]
    ]
    return HealthItem(
        key="estimated_rows",
        title="Estimated rows to settle",
        severity="warning" if count else "ok",
        count=count,
        detail=(
            f"{count} estimated row(s) from recurring plans: import the broker file or type "
            "what you got to settle them."
            if count
            else "No estimated rows waiting to be settled."
        ),
        examples=_examples(lines),
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

    # "Stale" = the newest cached close is more than the staleness grace behind,
    # so a fresh price genuinely failed to land (the provider is likely failing
    # for that symbol). A price that is merely past its short internal refresh
    # TTL — the normal state overnight, at weekends, or seconds after a tick — is
    # *not* stale: it still reflects the latest settled session, so flagging it
    # just produces a permanent warning the user can never clear. The grace is
    # measured in trading days and absorbs a single exchange holiday (our clock
    # ignores holidays); mutual funds get extra leeway because their NAV publishes
    # only once a day and routinely lands a day late.
    price_dates = prices_service.latest_price_dates_for(session, have_price_ids)
    today = exchange_today()
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    grace = settings_service.get_or(
        "diagnostics.stale_grace_trading_days", _STALE_GRACE_TRADING_DAYS, session
    )
    mf_grace = settings_service.get_or(
        "diagnostics.mutual_fund_stale_grace_trading_days",
        _MUTUAL_FUND_STALE_GRACE_TRADING_DAYS,
        session,
    )
    general_cutoff = market_hours.trading_days_before(today, int(grace))
    mutual_fund_cutoff = market_hours.trading_days_before(today, int(mf_grace))

    def _cutoff_for(instr: Instrument) -> date:
        if instr.asset_class == _MUTUAL_FUND_ASSET_CLASS:
            return mutual_fund_cutoff
        return general_cutoff

    # Manual / delisted instruments are never fetched: their last close is the
    # intended value, so an old date is not a fault to flag.
    have_price = set(have_price_ids) - instrument_overrides_repo.not_fetched_ids(session)
    stale = sorted(
        instr.symbol
        for instr in actives
        if instr.id in have_price
        and (as_of := price_dates.get(instr.id)) is not None
        and as_of < _cutoff_for(instr)
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
                    f"{len(stale)} instrument(s) are several trading days "
                    "behind: their newest cached close predates the last "
                    "completed session by more than the staleness grace (which "
                    "absorbs holidays, and gives mutual-fund NAVs extra leeway "
                    "for their once-a-day, often-late publish), so a background "
                    "refresh has not landed a fresh price. The dashboard keeps "
                    "using the last good price meanwhile; a persistently stale "
                    "instrument usually means the provider is failing for that "
                    "symbol."
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


def _check_intraday_graph(session: Session) -> HealthItem:
    """The live "1 Day" / "1 Week" graphs that the backfill couldn't fill.

    The background auto-update tops up the intraday graphs to their coverage
    target on every refresh (see
    :func:`investment_dashboard.services.intraday_snapshots_service.backfill_graphs`).
    This probe reports the *finished* sessions that are still below target — days
    the price feed never served enough intraday bars for — so a persistently
    gappy graph is surfaced rather than silently drawn short. In-progress
    sessions (still filling) and days with nothing intraday held are ignored.
    Read-only: it re-derives coverage from the cache and makes no network calls.
    """
    from investment_dashboard.services import intraday_snapshots_service  # noqa: PLC0415

    coverage = intraday_snapshots_service.assess_graph_coverage(session)
    if not coverage.has_gaps:
        return HealthItem(
            key="intraday_graph",
            title="Intraday graph coverage",
            severity="ok",
            count=0,
            detail="The 1 Day and 1 Week graphs are filled to their coverage target.",
        )

    graphs: list[str] = []
    if coverage.day_below_target:
        graphs.append("1 Day")
    examples = [d.isoformat() for d in coverage.week_days_below_target]
    if examples:
        graphs.append("1 Week")
    count = (1 if coverage.day_below_target else 0) + len(coverage.week_days_below_target)
    return HealthItem(
        key="intraday_graph",
        title="Intraday graph coverage",
        severity="warning",
        count=count,
        detail=(
            f"The {' and '.join(graphs)} graph could not be filled to its "
            "coverage target: the price feed returned too few intraday bars for "
            "one or more finished sessions. The background auto-update keeps "
            "retrying on each refresh; a session that stays short usually means "
            "the provider has no intraday history for that day. The graph is "
            "still drawn from the points that are available."
        ),
        examples=_examples(examples),
    )


def _check_holding_intraday(session: Session) -> HealthItem:
    """Held stocks/ETFs missing per-holding 1W intraday bars (``intraday_symbol_prices``)."""
    from investment_dashboard.services import intraday_snapshots_service  # noqa: PLC0415

    coverage = intraday_snapshots_service.assess_holding_intraday_coverage(session)
    if not coverage.has_gaps:
        return HealthItem(
            key="holding_intraday_graph",
            title="Per-holding 1W intraday bars",
            severity="ok",
            count=0,
            detail="Every held stock and ETF has 1 Week intraday price bars.",
        )

    missing = list(coverage.missing_symbols)
    return HealthItem(
        key="holding_intraday_graph",
        title="Per-holding 1W intraday bars",
        severity="warning",
        count=len(missing),
        detail=(
            f"{len(missing)} held stock(s)/ETF(s) are missing 1 Week intraday bars "
            "(leaving per-holding 1W charts or list peeks empty even when the "
            "portfolio 1W line is cached). Run 'Backfill 1W holding bars' to "
            "fill them without altering the portfolio curve."
        ),
        examples=_examples(missing),
    )


def _check_price_feed(session: Session) -> HealthItem:
    """Stretches where the provider served frozen quotes (in the last 7 days).

    A stalled feed still answers every pull, so the provider check above stays
    green; this probe reports the stall windows the price refresh recorded (see
    :mod:`investment_dashboard.services.feed_stall_service`). Read-only.
    """
    from investment_dashboard.services import feed_stall_service  # noqa: PLC0415

    now = datetime.now(UTC)
    windows = feed_stall_service.windows_between(session, now - timedelta(days=7), now, now=now)
    since = feed_stall_service.stalled_since()
    examples = [
        f"{s.strftime('%a %d %b %H:%M')}-{e.strftime('%H:%M')} UTC "
        f"({(e - s).total_seconds() / 60:.0f} min)"
        for s, e in reversed(windows)
    ]
    if since is not None:
        return HealthItem(
            key="price_feed",
            title="Live price feed",
            severity="error",
            count=len(windows),
            detail=(
                "The price provider keeps answering but its stock/ETF quotes have not "
                f"moved since {since.strftime('%H:%M')} UTC. The figures are not shown as "
                "Live and the 1 Day graph stores no points until it recovers; the gap is "
                "re-pulled from the provider's minute bars afterwards, where it has them."
            ),
            examples=_examples(examples),
        )
    if windows:
        return HealthItem(
            key="price_feed",
            title="Live price feed",
            severity="warning",
            count=len(windows),
            detail=(
                "The price provider served frozen quotes for a while in the last 7 days. "
                "Those stretches show as a gap in the 1 Day / 1 Week graphs. Reload graphs "
                "fills a gap when the provider later published its bars; if it never did, "
                "no source has the data (a Tiingo token in Settings adds a backup)."
            ),
            examples=_examples(examples),
        )
    return HealthItem(
        key="price_feed",
        title="Live price feed",
        severity="ok",
        count=0,
        detail="No frozen-quote stretches from the price provider in the last 7 days.",
    )


#: Log a warning (system activity log) when the app's resident memory passes this.
RSS_WARN_BYTES = 400 * 1024 * 1024
#: At most one such warning per this many seconds.
_RSS_WARN_INTERVAL_S = 3600.0
_last_rss_warning: float | None = None
_PROC_STATUS = Path("/proc/self/status")


def memory_usage(status_path: Path | None = None) -> tuple[int, int] | None:
    """``(rss_bytes, swap_bytes)`` of this process from ``/proc/self/status``.

    ``None`` when the file is absent or unreadable (Windows, macOS).
    """
    try:
        text = (status_path or _PROC_STATUS).read_text(encoding="ascii", errors="replace")
    except OSError:
        return None
    values: dict[str, int] = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        if key in ("VmRSS", "VmSwap"):
            parts = rest.split()
            if parts and parts[0].isdigit():
                values[key] = int(parts[0]) * 1024  # reported in kB
    if "VmRSS" not in values:
        return None
    return values["VmRSS"], values.get("VmSwap", 0)


def _mb(value: int) -> str:
    return f"{value / (1024 * 1024):.0f} MB"


def warn_if_memory_high(usage: tuple[int, int] | None, *, now: float | None = None) -> bool:
    """Log a rate-limited warning when RSS exceeds :data:`RSS_WARN_BYTES`."""
    global _last_rss_warning  # noqa: PLW0603
    if usage is None or usage[0] <= RSS_WARN_BYTES:
        return False
    stamp = time.monotonic() if now is None else now
    if _last_rss_warning is not None and stamp - _last_rss_warning < _RSS_WARN_INTERVAL_S:
        return False
    _last_rss_warning = stamp
    activity("system").warning(
        "memory high: rss=%s swap=%s (warn above %s)",
        _mb(usage[0]),
        _mb(usage[1]),
        _mb(RSS_WARN_BYTES),
    )
    return True


def _check_memory() -> HealthItem | None:
    usage = memory_usage()
    if usage is None:
        return None
    warn_if_memory_high(usage)
    return HealthItem(
        key="memory",
        title="Memory",
        severity="ok",
        count=0,
        detail=f"App memory {_mb(usage[0])} resident, {_mb(usage[1])} swapped out.",
    )


def check_health(session: Session) -> HealthReport:
    """Run every read-only data-health probe and return one aggregate report.

    Safe to call on every render: it performs no network calls and never
    mutates the database — it only reads what the rest of the app already
    computed and reports the silent-degradation signals in one place.
    """
    items: list[HealthItem] = [
        _check_fx_live(session),
        _check_fx_legs(session),
        _check_frozen_legs(session),
        *_check_prices(session),
        _check_positions(session),
        _check_brokerage_cash(session),
        _check_missing_dividends(session),
        *_check_splits(session),
        _check_share_counts(session),
        _check_import_age(session),
        _check_estimated_rows(session),
        _check_intraday_graph(session),
        _check_holding_intraday(session),
        _check_price_feed(session),
        _check_providers(),
        # 7.4 journey checks (withdrawals_not_converted is info: shown by the read model).
        *(
            check(session)
            for check in JOURNEY_CHECKS
            if check is not check_withdrawals_not_converted
        ),
    ]
    memory = _check_memory()
    if memory is not None:
        items.append(memory)
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


# ----------------------------------------------------------------- 7.4 journey (lane C)
#
# Each check has a pure ``journey_*`` form over the journey inputs (tests feed it a
# synthetic pool) and a session form ``check_*``. Without the cash pool service every
# session form reports ok. Fix links live in ``readmodels/diagnostics.py`` ``_LINKS``.


def _journey_inputs(session: Session) -> object | None:
    from investment_dashboard.readmodels import journey_fields  # noqa: PLC0415

    return journey_fields.inputs_for(session)


def journey_idle_dollars(inputs: object) -> HealthItem:
    """Converted dollars no deposit took for over 30 days (warning)."""
    from investment_dashboard.readmodels import currency_journey as cj  # noqa: PLC0415

    assert isinstance(inputs, cj.JourneyInputs)
    idle = cj.build_journey(inputs).idle
    key, title = "idle_dollars", "Idle dollars"
    if not idle:
        return HealthItem(key, title, "ok", 0, "No converted dollars have waited over 30 days.")
    days = cj.IDLE_DAYS
    return HealthItem(
        key,
        title,
        "warning",
        len(idle),
        f"{len(idle)} conversion(s) left dollars in your USD account for over {days} days. "
        "Record the deposit that took them, or mark them as kept on the Conversions page.",
        _examples([f"{r.date.isoformat()} ({r.undeposited_usd:,.2f} USD)" for r in idle]),
    )


def journey_uncovered_buys(inputs: object) -> HealthItem:
    """Buys the cash pool could not pay from converted dollars (ECB fallback)."""
    from investment_dashboard.domain import kinds  # noqa: PLC0415
    from investment_dashboard.readmodels import currency_journey as cj  # noqa: PLC0415

    assert isinstance(inputs, cj.JourneyInputs)
    ids = [
        t
        for t in inputs.snapshot.state.uncovered
        if (info := inputs.txns.get(t)) is not None and info.kind == kinds.BUY
    ]
    key, title = "uncovered_buys", "Buys valued at the ECB rate"
    if not ids:
        return HealthItem(key, title, "ok", 0, "Every buy is paid from dollars with a known cost.")
    examples = []
    for t in ids:
        info = inputs.txns[t]
        examples.append(f"{info.date.isoformat()} {info.symbol or ''} ({info.amount:,.2f} USD)")
    return HealthItem(
        key,
        title,
        "warning",
        len(ids),
        f"{len(ids)} buy(s) used more dollars than the broker cash held, so the rest is "
        "valued at the ECB rate of the buy date. A deposit or conversion is probably "
        "missing from the ledger.",
        _examples(examples),
    )


def journey_negative_broker_cash(balances: dict[str, Decimal]) -> HealthItem:
    """Brokerage accounts whose ledger cash is below zero (counted as 0 in the total)."""
    key, title = "negative_broker_cash", "Negative broker cash"
    flagged = [f"{name}: {bal:+,.2f}" for name, bal in balances.items() if bal <= -_CASH_DUST]
    if not flagged:
        return HealthItem(key, title, "ok", 0, "No brokerage account has negative cash.")
    return HealthItem(
        key,
        title,
        "warning",
        len(flagged),
        f"{len(flagged)} brokerage account(s) spent more cash than the ledger brought in. "
        "The total counts that cash as zero; a deposit or a sale is probably missing.",
        _examples(flagged),
    )


def journey_withdrawals_not_converted(inputs: object) -> HealthItem:
    """Withdrawn dollars still in the USD account (info: a cash-out not recorded yet)."""
    from investment_dashboard.readmodels import currency_journey as cj  # noqa: PLC0415

    assert isinstance(inputs, cj.JourneyInputs)
    ids = sorted(
        {
            lot.source_txn_id
            for lot in inputs.snapshot.state.lots
            if lot.account_key == cj.OUTSIDE_ACCOUNT
            and lot.source_kind == "withdrawal"
            and lot.amount > _CASH_DUST
            and lot.source_txn_id is not None
        }
    )
    key, title = "withdrawals_not_converted", "Withdrawals not converted back"
    if not ids:
        return HealthItem(key, title, "ok", 0, "Every withdrawal has gone back to euros.")
    examples = []
    for t in ids:
        info = inputs.txns.get(t)
        if info is not None:
            examples.append(f"{info.date.isoformat()} ({info.amount:,.2f} USD)")
    return HealthItem(
        key,
        title,
        "info",
        len(ids),
        f"{len(ids)} withdrawal(s) are still dollars in your USD account. When you convert "
        "them to euros, record it as a conversion back to see the realised result.",
        _examples(examples),
    )


def journey_conversion_back_uncovered(inputs: object) -> HealthItem:
    """Conversions back with more dollars than the USD account held (ECB fallback)."""
    from investment_dashboard.readmodels import currency_journey as cj  # noqa: PLC0415

    assert isinstance(inputs, cj.JourneyInputs)
    bad = [
        (cid, sum((d.amount for d in draws if d.lot_id.startswith("uncovered:")), Decimal(0)))
        for cid, draws in inputs.snapshot.state.conversions_back.items()
    ]
    bad = [(cid, usd) for cid, usd in bad if usd > 0]
    key, title = "conversion_back_uncovered", "Conversions back without dollars"
    if not bad:
        return HealthItem(key, title, "ok", 0, "Every conversion back is covered by dollars.")
    dates = {c.conversion_id: c.date for c in inputs.snapshot.cash_outs}
    return HealthItem(
        key,
        title,
        "warning",
        len(bad),
        f"{len(bad)} conversion(s) back to euros sent more dollars than the USD account "
        "held, so the rest is valued at the ECB rate. Record the withdrawal that brought "
        "those dollars out of the broker.",
        _examples(
            [f"{dates.get(cid, '?')} ({usd:,.2f} USD not covered)" for cid, usd in sorted(bad)]
        ),
    )


def _journey_check(session: Session, fn: object, key: str, title: str) -> HealthItem:
    inputs = _journey_inputs(session)
    if inputs is None:
        return HealthItem(key, title, "ok", 0, "The cash pool is not available yet.")
    assert callable(fn)
    item = fn(inputs)
    assert isinstance(item, HealthItem)
    return item


def check_idle_dollars(session: Session) -> HealthItem:
    return _journey_check(session, journey_idle_dollars, "idle_dollars", "Idle dollars")


def check_uncovered_buys(session: Session) -> HealthItem:
    return _journey_check(
        session, journey_uncovered_buys, "uncovered_buys", "Buys valued at the ECB rate"
    )


def check_negative_broker_cash(session: Session) -> HealthItem:
    """Reads the P18 ledger-cash rule (``positions_service.broker_cash_shortfalls``).

    The rule holds a brokerage account's cash at zero on a day it would end below
    zero; each account's balance here is minus the cash it went short in total (the
    deposits probably missing), so an account that ever went negative is flagged.
    """
    short: dict[int, Decimal] = {}
    for s in positions_service.broker_cash_shortfalls(session):
        short[s.account_id] = short.get(s.account_id, Decimal(0)) + s.native
    balances: dict[str, Decimal] = {}
    for account in accounts_repo.list_accounts(session):
        if account.account_type in positions_service.CASH_ACCOUNT_TYPES:
            continue
        name = f"{account.broker} {account.account_label} ({account.native_currency.upper()})"
        balances[name] = -short.get(account.id, Decimal(0))
    return journey_negative_broker_cash(balances)


def check_withdrawals_not_converted(session: Session) -> HealthItem:
    return _journey_check(
        session,
        journey_withdrawals_not_converted,
        "withdrawals_not_converted",
        "Withdrawals not converted back",
    )


def check_conversion_back_uncovered(session: Session) -> HealthItem:
    return _journey_check(
        session,
        journey_conversion_back_uncovered,
        "conversion_back_uncovered",
        "Conversions back without dollars",
    )


#: Lane C's checks, for the orchestrator to register in :func:`check_health`.
JOURNEY_CHECKS = (
    check_idle_dollars,
    check_uncovered_buys,
    check_negative_broker_cash,
    check_withdrawals_not_converted,
    check_conversion_back_uncovered,
)
