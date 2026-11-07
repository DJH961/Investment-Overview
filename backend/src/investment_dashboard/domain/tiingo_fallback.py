"""Pure decision core for the Tiingo desktop fallback — no I/O, no DB, no network.

This module answers the only hard question in the fallback: **when is it smart to
spend a Tiingo call?** It encodes the four gates and the NAV peer-confirmation +
canary logic from ``legacy/v5:docs/tiingo_fallback_plan.md`` as pure functions over explicit
inputs (the persisted timestamps/counters and the already-resolved market
calendar). Keeping it side-effect-free makes every gate and scenario unit-testable
in isolation; the wiring layer (``prices_service``) reads/writes the database and
calls these to decide.

Timing is evaluated as *elapsed since a stored stamp*, never as a live countdown:
a stamp plus the current instant is all each gate needs, so a due probe fires
immediately on app open rather than waiting out a timer the user isn't present for.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from enum import Enum
from zoneinfo import ZoneInfo

#: The exchange/budget timezone. Tiingo's shared daily limit resets at midnight
#: US/Eastern, and NAV publish habits are Eastern-clock phenomena.
EASTERN = ZoneInfo("America/New_York")

# --- Desktop budget (20 % of the shared 50/hr · 1000/day Tiingo account) -------
DESKTOP_HOURLY_CAP = 10
DESKTOP_DAILY_CAP = 200

# --- yfinance retry-before-escalate -------------------------------------------
#: Grace after a symbol first goes stale/missing before Tiingo may be considered.
#: Short on purpose: the apps are usually open only briefly and the hourly cap
#: self-regulates. Escalation *also* requires a confirmed repeat failure.
#:
#: NOTE: ``DESKTOP_GRACE`` was tuned for a desktop app that's open only briefly —
#: the user closes it, so a stuck symbol can only burn so many calls before the
#: process exits. On an always-on server the scheduler ticks every
#: ``DEFAULT_INTERVAL_SECONDS`` (60s, see ``services/auto_refresh.py``)
#: indefinitely, so once this grace elapses a single stuck symbol would
#: otherwise fire a fresh Tiingo call *every tick* — see
#: ``MARKET_SYMBOL_COOLDOWN`` below, which exists specifically to cap that.
DESKTOP_GRACE = timedelta(minutes=3)
#: Minimum gap between two Tiingo calls for the *same* market symbol, once gate
#: C (grace + confirmed repeat failure) has already fired once. Without this, a
#: 24/7 scheduler re-evaluates the same stuck symbol every tick and gate C stays
#: satisfied forever, so it would ask Tiingo again and again — at the default
#: 60s cadence that alone can exhaust ``DESKTOP_HOURLY_CAP`` (10/hr) in about
#: ten minutes, starving every *other* symbol's fallback for the rest of the
#: hour. 15 minutes matches the NAV path's in-window cooldown
#: (``NAV_COOLDOWN_IN_WINDOW``): it caps one stuck symbol at ~4 calls/hour,
#: leaving the remaining ~6 calls/hour of budget for other symbols.
MARKET_SYMBOL_COOLDOWN = timedelta(minutes=15)

# --- NAV-late: peer-confirmation + canary -------------------------------------
#: No Fidelity NAV realistically strikes before this Eastern wall-clock time, so
#: a canary probe is pure waste before it.
NAV_FIRST_PROBE_FLOOR = time(17, 30)
#: Added on top of the (floor or learned-earliest) publish time before the first
#: probe, so we don't probe at the very instant the earliest fund usually posts.
NAV_PROBE_GRACE = timedelta(minutes=15)
#: After the *first* peer NAV is observed via the primary, wait this long for the
#: normal trickle to finish before treating still-missing funds as real laggards.
NAV_PEER_GRACE = timedelta(minutes=30)
#: The active NAV-posting window (Eastern). Inside it we re-probe more eagerly.
NAV_WINDOW_START = time(17, 30)
NAV_WINDOW_END = time(19, 0)
#: Cooldown between canary probes — tighter inside the active window, looser when
#: NAVs are unusually late (deep evening).
NAV_COOLDOWN_IN_WINDOW = timedelta(minutes=15)
NAV_COOLDOWN_OFF_WINDOW = timedelta(minutes=30)
#: Hard backstop on canary probes per Eastern day, so even an all-evening primary
#: outage can't drip-spend more than this.
NAV_MAX_PROBES_PER_DAY = 8


def now_eastern(now_utc: datetime) -> datetime:
    """Convert a naive-UTC instant to a naive Eastern wall-clock datetime."""
    aware = now_utc.replace(tzinfo=ZoneInfo("UTC")) if now_utc.tzinfo is None else now_utc
    return aware.astimezone(EASTERN).replace(tzinfo=None)


def eastern_day(now_utc: datetime) -> date:
    """The Eastern calendar day for a naive-UTC instant (the budget reset key)."""
    return now_eastern(now_utc).date()


def is_new_budget_day(stamp_utc: datetime | None, now_utc: datetime) -> bool:
    """Whether ``now_utc`` falls on a later Eastern day than ``stamp_utc``.

    The persistence layer uses this to zero the hour/day counters at midnight ET
    without a scheduled job: the next read after midnight simply resets.
    """
    if stamp_utc is None:
        return True
    return eastern_day(now_utc) > eastern_day(stamp_utc)


@dataclass(frozen=True)
class Budget:
    """A side's remaining Tiingo allowance across the hour and day windows."""

    hour_used: int
    day_used: int
    hourly_cap: int = DESKTOP_HOURLY_CAP
    daily_cap: int = DESKTOP_DAILY_CAP

    def remaining(self) -> int:
        return max(0, min(self.hourly_cap - self.hour_used, self.daily_cap - self.day_used))

    def has_room(self) -> bool:
        return self.remaining() > 0


@dataclass(frozen=True)
class MarketSymbolState:
    """Everything the gates need to judge a single *market* (non-NAV) symbol.

    All dates/instants are caller-resolved: ``expected_date`` is the latest
    settled session for the symbol's market; ``stale_since`` /
    ``repeat_failure_confirmed`` come from persisted per-symbol metadata.
    """

    symbol: str
    held_date: date | None
    expected_date: date
    primary_failed: bool
    stale_since: datetime | None
    repeat_failure_confirmed: bool
    #: When Tiingo was last actually asked for this symbol (any outcome), or
    #: ``None`` if never. Drives the cooldown below; independent of
    #: ``stale_since`` (which is *when the symbol first went stale*, not when it
    #: was last probed).
    last_attempt_at: datetime | None = None


def market_symbol_eligible(
    state: MarketSymbolState,
    *,
    now_utc: datetime,
    grace: timedelta = DESKTOP_GRACE,
    cooldown: timedelta = MARKET_SYMBOL_COOLDOWN,
    manual: bool = False,
) -> bool:
    """Whether a market symbol has cleared gates A–D (budget applied separately).

    * **A — Trigger:** the primary failed/over-quota, or we hold nothing, or what
      we hold is older than the latest settled session.
    * **B — Worth it:** newer data actually exists — we hold nothing, or behind
      the settled session. A transient primary error while we *already* hold the
      expected session is therefore *not* worth a call.
    * **C — Timing:** past the stale-since grace **and** a confirmed repeat
      yfinance failure (not merely elapsed time on one bad poll).
    * **D — Cooldown:** at least ``cooldown`` since the *last* Tiingo attempt for
      this symbol, so a symbol that stays stuck for hours doesn't get asked
      again on every single scheduler tick.

    ``manual=True`` is a *user-initiated* refresh: it bypasses gates C and D
    (the grace/confirmed-repeat-failure and cooldown timing) but still enforces
    gate B (newer data must actually exist), so a manual pull while already up
    to date is a no-op, never a wasted call. Budget is applied by the caller
    regardless.
    """
    behind = state.held_date is None or state.held_date < state.expected_date
    triggered = state.primary_failed or behind
    if not triggered or not behind:  # gates A and B
        return False
    if manual:  # gates C/D bypassed by explicit user action; B still held above
        return True
    if state.stale_since is None or (now_utc - state.stale_since) < grace:
        return False
    if not state.repeat_failure_confirmed:
        return False
    within_cooldown = (
        state.last_attempt_at is not None and (now_utc - state.last_attempt_at) < cooldown
    )
    return not within_cooldown


def select_within_budget(symbols: Sequence[str], budget: Budget) -> list[str]:
    """Trim an eligible-symbol list to what the budget can actually pay for."""
    room = budget.remaining()
    return list(symbols[:room]) if room > 0 else []


class NavAction(Enum):
    """What the NAV path should do this cycle."""

    WAIT = "wait"
    FETCH_LAGGARDS = "fetch_laggards"
    CANARY = "canary"


@dataclass(frozen=True)
class NavDecision:
    action: NavAction
    symbols: tuple[str, ...]
    reason: str


def nav_cooldown_for(now_et_time: time) -> timedelta:
    """The probe cooldown that applies at an Eastern wall-clock time."""
    in_window = NAV_WINDOW_START <= now_et_time <= NAV_WINDOW_END
    return NAV_COOLDOWN_IN_WINDOW if in_window else NAV_COOLDOWN_OFF_WINDOW


def first_probe_time(earliest_habit: time | None) -> time:
    """The earliest Eastern time a canary may fire.

    ``max(17:30 floor, earliest learned publish habit) + 15 min``. With no
    learned habit yet the floor governs, so the first probe lands ~17:45 ET.
    """
    base = max(NAV_FIRST_PROBE_FLOOR, earliest_habit) if earliest_habit else NAV_FIRST_PROBE_FLOOR
    combined = (datetime.combine(date.min, base) + NAV_PROBE_GRACE).time()
    # Guard the (impossible here, but defensive) midnight wrap.
    return combined if combined > base else base


#: Weight on the publish-time spread when scoring a canary: a fund's "expected
#: latest publish" ≈ mean + this × stddev. >0 so an *inconsistent* early
#: publisher loses to a slightly later but rock-steady one (we want the fund most
#: reliably out *by now*, not merely the one with the earliest lucky day).
CANARY_CONSISTENCY_WEIGHT = 1.0


def _minutes(t: time) -> int:
    return t.hour * 60 + t.minute


def canary_score(times: Sequence[time]) -> float | None:
    """Score a fund's NAV-publish habit — *lower is a better canary*.

    The score estimates the Eastern minute-of-day by which this fund has
    *reliably* published: ``mean + CANARY_CONSISTENCY_WEIGHT × stddev`` over the
    observed publish times. A fund that posts early *and* consistently scores
    lowest (most likely already out, so the best single probe); a fund with no
    history scores ``None`` (no evidence — falls back to holding size).
    """
    mins = [_minutes(t) for t in times]
    if not mins:
        return None
    mean = sum(mins) / len(mins)
    if len(mins) > 1:
        variance = sum((m - mean) ** 2 for m in mins) / len(mins)
        std = float(variance**0.5)
    else:
        std = 0.0
    return mean + CANARY_CONSISTENCY_WEIGHT * std


def choose_canary(
    missing_funds: Sequence[str],
    *,
    holding_values: Mapping[str, Decimal] | None = None,
    publish_habits: Mapping[str, Sequence[time]] | None = None,
) -> str | None:
    """Pick the single fund to probe when there's no free peer NAV evidence.

    Per ``legacy/v5:docs/tiingo_fallback_plan.md``: probe the fund *most likely to have
    published by now*. We prefer **learned evidence** over guesswork:

    1. **Habit-driven** — among funds with an observed publish history, take the
       lowest :func:`canary_score` (earliest *and* tightest publisher). Ties
       break toward the **largest holding**, then symbol for determinism.
    2. **Cold start** — when *no* missing fund has any habit yet, fall back to
       the **largest holding** (the user's stated preference and the most
       valuable NAV to confirm), tie-broken by symbol.

    All inputs are caller-resolved facts; this stays pure and fully testable.
    """
    if not missing_funds:
        return None
    values = holding_values or {}
    habits = publish_habits or {}

    scored = [(s, canary_score(habits.get(s, ()))) for s in missing_funds]
    with_habit = [(s, score) for s, score in scored if score is not None]
    if with_habit:
        # Lowest score wins; tiebreak largest holding (negate), then symbol.
        return min(
            with_habit,
            key=lambda item: (item[1], -values.get(item[0], Decimal(0)), item[0]),
        )[0]

    # Cold start: largest holding, deterministic by symbol on a tie.
    return min(missing_funds, key=lambda s: (-values.get(s, Decimal(0)), s))


def _decide_nav_peer(
    missing_funds: Sequence[str],
    peer_published_at: datetime | None,
    now_utc: datetime,
    budget: Budget,
    *,
    manual: bool = False,
) -> NavDecision:
    """Tier 1: the primary already returned a fresh NAV for some *other* fund."""
    if (
        not manual
        and peer_published_at is not None
        and (now_utc - peer_published_at) < NAV_PEER_GRACE
    ):
        return NavDecision(NavAction.WAIT, (), "within peer-trickle grace")
    laggards = select_within_budget(list(missing_funds), budget)
    if not laggards:
        return NavDecision(NavAction.WAIT, (), "budget exhausted")
    return NavDecision(NavAction.FETCH_LAGGARDS, tuple(laggards), "peer-confirmed laggards")


def _decide_nav_canary(
    canary_pick: str | None,
    earliest_habit: time | None,
    last_canary_at: datetime | None,
    canary_count_today: int,
    now_utc: datetime,
    *,
    manual: bool = False,
) -> NavDecision:
    """Tier 2: no peer evidence — probe a single fund, gated by time/cooldown/cap.

    ``manual=True`` bypasses the first-probe-time floor and the inter-probe
    cooldown (the *timing* gates), but the per-day probe cap still stands as a
    hard budget backstop, and the result is still a single canary — never a batch
    burn — so a manual NAV refresh before publication costs at most one probe.
    """
    now_et = now_eastern(now_utc)
    if not manual and now_et.time() < first_probe_time(earliest_habit):
        return NavDecision(NavAction.WAIT, (), "before first-probe time")
    if canary_count_today >= NAV_MAX_PROBES_PER_DAY:
        return NavDecision(NavAction.WAIT, (), "daily canary cap reached")
    if not manual:
        cooldown = nav_cooldown_for(now_et.time())
        if last_canary_at is not None and (now_utc - last_canary_at) < cooldown:
            return NavDecision(NavAction.WAIT, (), "within canary cooldown")
    if canary_pick is None:
        return NavDecision(NavAction.WAIT, (), "no canary candidate")
    return NavDecision(NavAction.CANARY, (canary_pick,), "canary probe")


def decide_nav(
    *,
    missing_funds: Sequence[str],
    peer_published: bool,
    peer_published_at: datetime | None,
    canary_pick: str | None,
    earliest_habit: time | None,
    last_canary_at: datetime | None,
    canary_count_today: int,
    now_utc: datetime,
    budget: Budget,
    manual: bool = False,
) -> NavDecision:
    """Decide the NAV path for one refresh cycle (see the plan's two tiers).

    Inputs are all caller-resolved facts:

    * ``missing_funds`` — held NAV funds still missing the target session's NAV.
    * ``peer_published`` / ``peer_published_at`` — did the *primary* return a
      fresh target-date NAV for some other fund, and when was that first seen?
    * ``canary_pick`` — the single fund to probe when there's no peer evidence
      (earliest/most-reliable publisher; ``None`` if none qualifies).
    * ``earliest_habit`` — earliest learned Eastern publish time, or ``None``.
    * ``last_canary_at`` / ``canary_count_today`` — persisted probe stamps (ET day).
    * ``manual`` — a user-initiated refresh; bypasses the NAV timing gates
      (peer-trickle grace, first-probe floor, cooldown) but keeps worth-it,
      budget and the per-day probe cap, so it's still at most a single canary.

    Returns a :class:`NavDecision`; the wiring layer executes it and, on a *fresh*
    canary result, immediately promotes ``missing_funds`` to a laggard fetch.
    """
    if not missing_funds:
        return NavDecision(NavAction.WAIT, (), "no missing NAV funds")
    if not budget.has_room():
        return NavDecision(NavAction.WAIT, (), "budget exhausted")
    if peer_published:
        return _decide_nav_peer(missing_funds, peer_published_at, now_utc, budget, manual=manual)
    return _decide_nav_canary(
        canary_pick,
        earliest_habit,
        last_canary_at,
        canary_count_today,
        now_utc,
        manual=manual,
    )
