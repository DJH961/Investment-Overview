"""Live 1D / 1W graph **springboard** export for the v3.0 browser companion.

The desktop already captures (and reconstructs) the within-day intraday "1 Day"
curve and the multi-day "1 Week" sleeve
(:mod:`investment_dashboard.services.intraday_snapshots_service`). Re-deriving
those on a phone means re-fetching intraday bars from the live provider on every
open — costly on the free tier and slow to first paint.

This read-model serialises those already-computed curves into the blob so the
web companion can **springboard** off them: paint the curve instantly from the
export and only fetch live bars to *extend the tip*, falling back to a full live
rebuild when the export is absent or too stale (see ``web/src/springboard.ts``).

Schema-v3 enrichment (``docs/centralized_data_export_plan.md``)
--------------------------------------------------------------
Alongside the legacy whole-book ``day`` / ``week`` curves (kept for backward
compatibility — older readers ignore everything else), the section now ships a
**homogeneous market-sleeve backbone** the web reapplies *its own* cash + NAV
base to, so blob and live data merge without base-change spikes:

* ``market_series`` — the aggregate **intraday-priced sleeve** value across the
  *whole* 1W window, un-downsampled, in compact columnar form: ``times[]`` (true
  instants), ``value_native[]`` (FX-free booked/USD sleeve value; ``null`` = gap)
  and ``fx_eur_usd[]`` (the rate in force at each instant; ``null`` → the web
  falls back to today's rate). Either currency is recoverable at the *true
  per-timestamp* rate, exactly as the desktop derives its own two lines.
* ``daily_close_native`` — the settled sleeve close per session date (the
  authoritative anchor the web fits finer points to / cross-checks against).
* ``nav_prices`` — per-day published NAV per NAV holding, so the web reapplies
  the NAV base per day.
* ``mm_value_native`` — per-day money-market / settlement **value** (USD) per
  fund (VMFXX, SPAXX …). Money-market funds pin a constant $1.00 NAV, so a NAV
  *price* line is uninformative; their value moves with the **share count**,
  which transactions (deposits/dividends) change — sometimes while the market is
  shut, so the freshest value is *newer* than the last market close. Shipping
  the value-as-of each session date lets the web step the base on the day a flow
  landed instead of shifting the whole 1D/1W curve up by today's balance.
* ``trail`` — the desktop's dense whole-book live samples, flagged
  ``display_only`` (never merged or cross-checked), downsampled so the blob stays
  small.

Only **market** (intraday-priced) symbols feed the backbone; NAV / cash price
once daily and ride in ``nav_prices`` + ``holdings[]``. The backbone is sourced
**at export time** from the cached ``IntradayValue`` samples the device already
holds, with any gap day in the window reconstructed for free via the token-less
yfinance range fetch (the desktop's privilege — no provider budget).

Shape — each legacy series is a list of **whole-book** points (the constant cash
+ NAV base already added in, exactly as the desktop renders it) in *both*
currencies:

    {
      "schema_version": 3,
      "captured_at": "2026-06-23T15:30:00Z",   # freshness stamp (meta.generated_at twin)
      "grid": "30m",
      "session_dates": ["2026-06-17", ..., "2026-06-23"],
      "market_series": {"times": [...], "value_native": [...], "fx_eur_usd": [...]},
      "daily_close_native": {"2026-06-22": "10310.40", ...},
      "nav_prices": {"FUND_X": [["2026-06-22", "102.40"], ...], ...},
      "mm_value_native": {"VMFXX": [["2026-06-22", "5000.00"], ...], ...},
      "trail": {"display_only": true, "points": [...]},
      "day":  {"session_date": "2026-06-23", "market_open": true, "points": [...]},
      "week": {"start_date": "2026-06-17", "end_date": "2026-06-23", ...}
    }

Currency model (proposal §10.8): ``value_usd`` is the booked, **FX-free** figure;
``value_eur`` carries each point's *own* per-minute EUR→USD rate, so the two
lines legitimately diverge — never a uniform rescale. Both columns are produced
by the very same desktop builders (:func:`build_intraday_value_series` /
:func:`build_week_value_series`), so the springboarded curve is identical to the
desktop's "1 Day" / "1 Week" lines.

The 1D session is **down-sampled** to at most :data:`MAX_DAY_POINTS` evenly
spaced points (keeping the first and last) so a dense live-captured session stays
small in the blob while remaining visually identical to the live curve. The v3
**backbone** is deliberately *not* hard-downsampled — it is one series for the
whole book regardless of symbol count, so it stays a handful of KB; only a
:data:`MAX_BACKBONE_CELLS` hard cap (coarsening older days to their close first)
bounds a pathologically long/dense window.

Absent-tolerant: returns ``None`` when there is nothing worth shipping (empty
ledger, no intraday history captured yet), so the section is simply omitted from
older or data-less exports.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import market_hours
from investment_dashboard.domain.money_market import MONEY_MARKET_NAV, is_money_market
from investment_dashboard.readmodels._context import ReadModelContext
from investment_dashboard.readmodels._serialize import dec, iso
from investment_dashboard.repositories import app_config_repo, transactions_repo
from investment_dashboard.services import (
    fx_service,
    intraday_snapshots_service,
    positions_service,
    prices_service,
)
from investment_dashboard.ui.pages._overview_query import (
    ValueSeriesPoint,
    build_intraday_value_series,
    build_week_value_series,
)

#: Cap on the 1D session's exported points (≈ a 5-min trading session's density).
#: A dense live-captured session can hold far more rows; down-sampling keeps the
#: blob small while the curve stays visually identical to the live one. Also
#: caps the display-only ``trail``.
MAX_DAY_POINTS = 80

#: Inner schema version of the ``live_graphs`` section. ``3`` adds the
#: market-sleeve backbone (``market_series`` + ``daily_close_native`` +
#: ``nav_prices`` + ``trail``); readers must stay absent-tolerant for ``1``/``2``
#: blobs (which carried only ``day`` / ``week``).
SCHEMA_VERSION = 3

#: Default bar width for the backbone — the desktop's native cadence, so today
#: costs zero extra compute and a gap day is one range call.
GRID_DEFAULT = "30m"

#: Grids the export setting accepts. ``"15m"`` gives a smoother backbone at still
#: only ~130 cells; anything else falls back to :data:`GRID_DEFAULT`.
GRID_CHOICES: frozenset[str] = frozenset({"30m", "15m"})

#: ``app_config`` key holding the configurable backbone grid.
_GRID_CONFIG_KEY = "live_graphs_grid"

#: Hard cap on the number of backbone cells (``times`` entries). A normal 1W
#: window is ~65 cells at 30m / ~130 at 15m, well under this; the cap only bites
#: on a pathologically long/dense window, where older days are coarsened to their
#: settled close first (newest days keep full intraday detail).
MAX_BACKBONE_CELLS = 200

#: Floor below which a holding's share count is treated as dust (mirrors the
#: intraday service's own threshold) when selecting NAV holdings for export.
_MIN_SHARES = Decimal("0.0000001")


def resolve_grid(session: Session) -> str:
    """The configured backbone grid, falling back to :data:`GRID_DEFAULT`.

    Read from ``app_config`` (key :data:`_GRID_CONFIG_KEY`) so the owner can opt
    into a denser ``"15m"`` backbone; an unset or unrecognised value yields the
    ``"30m"`` default.
    """
    configured = app_config_repo.get(session, _GRID_CONFIG_KEY)
    return configured if configured in GRID_CHOICES else GRID_DEFAULT


def build(
    session: Session,
    *,
    context: ReadModelContext,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Serialise the desktop's 1D session + 1W sleeve for the mobile springboard.

    Returns ``None`` when neither the legacy curves nor the v3 backbone have
    anything plottable, so the caller omits the section entirely (the web then
    falls back to a live build).
    """
    positions = positions_service.compute_positions(session, as_of=context.as_of)
    grid = resolve_grid(session)
    day = _day_series(session, positions=positions, now=now)
    week = _week_series(session, positions=positions, now=now)
    backbone = _market_series(session, now=now, grid=grid)
    nav_prices = _nav_prices(session, positions=positions, now=now)
    mm_value = _money_market_value_native(session, positions=positions, now=now)
    trail = _trail(day)
    if day is None and week is None and backbone is None:
        return None
    out: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "captured_at": _iso_utc(now or datetime.now(UTC)),
        "grid": grid,
    }
    if backbone is not None:
        out["session_dates"] = backbone["session_dates"]
        out["market_series"] = backbone["market_series"]
        out["daily_close_native"] = backbone["daily_close_native"]
    if nav_prices:
        out["nav_prices"] = nav_prices
    if mm_value:
        out["mm_value_native"] = mm_value
    if trail is not None:
        out["trail"] = trail
    if day is not None:
        out["day"] = day
    if week is not None:
        out["week"] = week
    return out


def _market_series(
    session: Session,
    *,
    now: datetime | None,
    grid: str,
) -> dict[str, Any] | None:
    """Assemble the aggregate market-sleeve backbone for the whole 1W window.

    Sourced from :func:`intraday_snapshots_service.week_series_with_fx` (cache
    first, gap days reconstructed token-free at ``grid`` resolution), which yields
    ``(at_utc, market_value_eur, fx_eur_usd)`` — the *intraday-priced sleeve only*
    (cash + NAV excluded, reapplied by the web at render). Emits the columnar
    ``times`` / ``value_native`` / ``fx_eur_usd`` arrays plus the settled
    ``daily_close_native`` anchor per session date and the window's
    ``session_dates``.

    ``value_native`` is the FX-free booked (USD) sleeve value, recovered from the
    EUR pivot exactly as the desktop's own USD line does (multiply by that
    instant's rate; ``null`` only when neither the sample's rate nor today's spot
    is available). The backbone is *not* hard-downsampled — only a
    :data:`MAX_BACKBONE_CELLS` cap (coarsening older days first) bounds it.

    Returns ``None`` when fewer than two sleeve samples exist (nothing to draw).
    """
    samples = intraday_snapshots_service.week_series_with_fx(session, now=now, interval=grid)
    if len(samples) < 2:
        return None
    fallback_rate = fx_service.get_rate_eur_to_quote(
        session, (now or datetime.now(UTC)).date(), quote="USD"
    )
    capped = _cap_backbone(samples, MAX_BACKBONE_CELLS)
    times: list[str] = []
    value_native: list[str | None] = []
    fx_eur_usd: list[str | None] = []
    for at, market_eur, fx in capped:
        times.append(_iso_utc(at))
        value_native.append(dec(_native_usd(market_eur, fx, fallback_rate)))
        fx_eur_usd.append(dec(fx) if fx is not None else None)
    window = intraday_snapshots_service.recent_trading_sessions(now)
    return {
        "session_dates": [d.isoformat() for d in window],
        "market_series": {
            "times": times,
            "value_native": value_native,
            "fx_eur_usd": fx_eur_usd,
        },
        "daily_close_native": _daily_close_native(samples, fallback_rate),
    }


def _native_usd(
    market_eur: Decimal, fx: Decimal | None, fallback_rate: Decimal | None
) -> Decimal | None:
    """FX-free booked (USD) sleeve value recovered from the EUR pivot.

    Multiplies the EUR pivot by the rate it was struck at (``fx``), which cancels
    the FX exactly back to the native USD price — the same recovery the desktop's
    USD "1 Day"/"1 Week" line uses. Falls back to today's spot when the sample
    carries no rate, and yields ``None`` only when no rate is available at all.
    """
    rate = fx if fx is not None else fallback_rate
    return market_eur * rate if rate is not None else None


def _daily_close_native(
    samples: list[tuple[datetime, Decimal, Decimal | None]],
    fallback_rate: Decimal | None,
) -> dict[str, str | None]:
    """The settled sleeve close (native USD) per session date.

    The last sample of each exchange-day is its settled close — the authoritative
    endpoint the web fits finer points to and cross-checks against. Computed from
    the *full* (uncapped) sample set so coarsening the backbone never drops a
    day's true close.
    """
    last_per_day: dict[date, tuple[datetime, Decimal, Decimal | None]] = {}
    for sample in samples:
        day = intraday_snapshots_service.session_date_of(sample[0])
        current = last_per_day.get(day)
        if current is None or sample[0] >= current[0]:
            last_per_day[day] = sample
    return {
        day.isoformat(): dec(_native_usd(market_eur, fx, fallback_rate))
        for day, (_at, market_eur, fx) in sorted(last_per_day.items())
    }


def _cap_backbone(
    samples: list[tuple[datetime, Decimal, Decimal | None]],
    cap: int,
) -> list[tuple[datetime, Decimal, Decimal | None]]:
    """At most ``cap`` backbone cells, coarsening **older days first** to their close.

    Within-reason guard for a pathologically long/dense window: while the total
    exceeds ``cap``, the oldest still-detailed session is collapsed to just its
    settled close (last sample), so the newest days keep their full intraday
    detail. Returns the samples unchanged when already within ``cap``.
    """
    if len(samples) <= cap:
        return samples
    by_day: dict[date, list[tuple[datetime, Decimal, Decimal | None]]] = {}
    for sample in samples:
        by_day.setdefault(intraday_snapshots_service.session_date_of(sample[0]), []).append(sample)
    for day in sorted(by_day):  # oldest first
        if sum(len(v) for v in by_day.values()) <= cap:
            break
        if len(by_day[day]) > 1:
            by_day[day] = [max(by_day[day], key=lambda s: s[0])]
    flattened = [sample for day in sorted(by_day) for sample in by_day[day]]
    return sorted(flattened, key=lambda s: s[0])


def _nav_prices(
    session: Session,
    *,
    positions: list[positions_service.Position],
    now: datetime | None,
) -> dict[str, list[list[str | None]]]:
    """Per-day published NAV per NAV holding over the 1W window.

    NAV / cash holdings price once daily (constant intraday), so rather than ride
    the intraday backbone they ship as ``{symbol: [[date, price_native], ...]}``
    and the web reapplies them as the render-time base per day. Reads only the
    settled closes the daily pull already persisted (no network), keeping each
    holding's prints within the exported session window. Symbols share an
    instrument across accounts → de-duplicated by instrument.
    """
    window = intraday_snapshots_service.recent_trading_sessions(now)
    if not window:
        return {}
    symbols_by_id: dict[int, str] = {
        p.instrument.id: p.instrument.symbol
        for p in positions
        if p.shares > _MIN_SHARES and not intraday_snapshots_service.is_intraday_priced(p)
    }
    if not symbols_by_id:
        return {}
    window_dates = set(window)
    recent = prices_service.recent_closes_by_instrument(
        session, list(symbols_by_id), on_or_before=window[-1], limit=len(window)
    )
    out: dict[str, list[list[str | None]]] = {}
    for instrument_id, symbol in symbols_by_id.items():
        rows = sorted((d, close) for d, close in recent.get(instrument_id, []) if d in window_dates)
        if rows:
            out[symbol] = [[iso(d), dec(close)] for d, close in rows]
    return out


def _money_market_value_native(
    session: Session,
    *,
    positions: list[positions_service.Position],
    now: datetime | None,
) -> dict[str, list[list[str | None]]]:
    """Per-day money-market / settlement value (native USD) over the 1W window.

    Money-market funds (VMFXX, SPAXX …) hold a constant $1.00 NAV by design, so
    ``nav_prices`` would ship a flat, uninformative ``$1`` line — yet their value
    *does* move, because **transactions** (deposits, withdrawals, dividend
    reinvests) change the *share count*. Those flows can settle while the US
    market is shut, so a fund's freshest value is genuinely **newer** than the
    last market close: pinning the web's base to today's balance retroactively
    shifts the *whole* 1D/1W curve up by a deposit it never had, instead of
    stepping at the day it landed. The fix is to ship the **value-as-of each
    session date** (cumulative shares × par NAV) so the web reapplies the *right*
    base per day and shows the correct settled close.

    Shape: ``{symbol: [[date, value_native], ...]}`` over the window's session
    dates, de-duplicated by symbol (one instrument may span accounts). Sourced
    purely from the ledger — no network. ``value_native[-1]`` is the latest
    settled close per fund. Empty when the book holds no money-market funds.
    """
    window = intraday_snapshots_service.recent_trading_sessions(now)
    if not window:
        return {}
    mm_ids = {
        p.instrument.id
        for p in positions
        if is_money_market(p.instrument.symbol, name=p.instrument.name)
    }
    if not mm_ids:
        return {}
    symbol_by_id = {p.instrument.id: p.instrument.symbol for p in positions}
    txns = transactions_repo.list_transactions(session, end=window[-1])
    out: dict[str, list[list[str | None]]] = {}
    for iid in mm_ids:
        running = Decimal(0)
        rows: list[list[str | None]] = []
        cursor = 0
        ordered = [t for t in txns if t.instrument_id == iid]
        for d in window:
            while cursor < len(ordered) and ordered[cursor].date <= d:
                running += ordered[cursor].quantity or Decimal(0)
                cursor += 1
            rows.append([iso(d), dec(running * MONEY_MARKET_NAV)])
        if rows:
            out[symbol_by_id[iid]] = rows
    return out


def _trail(day: dict[str, Any] | None) -> dict[str, Any] | None:
    """The desktop's dense whole-book live samples as a display-only trail.

    Reuses the already-downsampled 1D whole-book points (``value_eur`` /
    ``value_usd``), flagged :data:`display_only` so the web rebases and splices
    them after its freshest real point but **never** merges or cross-checks them.
    Returns ``None`` when there is no intraday day session to ship.
    """
    if day is None:
        return None
    points = day["points"]
    if len(points) < 2:
        return None
    return {"display_only": True, "points": _downsample(points, MAX_DAY_POINTS)}


def _day_series(
    session: Session,
    *,
    positions: list[positions_service.Position],
    now: datetime | None,
) -> dict[str, Any] | None:
    """The intraday "1 Day" whole-book curve in both currencies, down-sampled."""
    eur = build_intraday_value_series(
        session, currency="EUR", tz=None, now=now, positions=positions
    )
    if len(eur) < 2:
        return None
    usd = build_intraday_value_series(
        session, currency="USD", tz=None, now=now, positions=positions
    )
    points = _downsample(_zip_points(eur, usd), MAX_DAY_POINTS)
    ref = now or datetime.now(UTC)
    return {
        "session_date": intraday_snapshots_service.last_session_date(ref).isoformat(),
        "market_open": market_hours.is_us_market_open(ref),
        "points": points,
    }


def _week_series(
    session: Session,
    *,
    positions: list[positions_service.Position],
    now: datetime | None,
) -> dict[str, Any] | None:
    """The multi-day "1 Week" whole-book curve in both currencies.

    Sourced cache-first (no live fetcher passed) so the export stays offline-safe;
    when no intraday history is cached the series is simply omitted.
    """
    eur = build_week_value_series(session, currency="EUR", tz=None, now=now, positions=positions)
    if len(eur) < 2:
        return None
    usd = build_week_value_series(session, currency="USD", tz=None, now=now, positions=positions)
    points = _downsample(_zip_points(eur, usd), MAX_DAY_POINTS)
    window = intraday_snapshots_service.recent_trading_sessions(now)
    ref = now or datetime.now(UTC)
    return {
        "start_date": window[0].isoformat(),
        "end_date": window[-1].isoformat(),
        "market_open": market_hours.is_us_market_open(ref),
        "points": points,
    }


def _zip_points(eur: list[ValueSeriesPoint], usd: list[ValueSeriesPoint]) -> list[dict[str, Any]]:
    """Pair the per-currency value series (same timestamps) into export points.

    Both lists come from the same builder with the same ``now``/positions, so they
    share timestamps and length; ``zip`` aligns them defensively by index.
    """
    return [
        {"t": _iso_utc(e.date), "value_eur": dec(e.value), "value_usd": dec(u.value)}
        for e, u in zip(eur, usd, strict=False)
    ]


def _iso_utc(when: object) -> str:
    """ISO-8601 UTC string with a ``Z`` suffix for a naive-UTC datetime.

    The intraday samples carry naive-UTC timestamps; an explicit ``Z`` makes the
    instant unambiguous for the browser's ``Date.parse`` (a bare ``T``-time would
    otherwise be read as local time).
    """
    dt = when if isinstance(when, datetime) else datetime(when.year, when.month, when.day)  # type: ignore[attr-defined]
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _downsample(points: list[dict[str, Any]], max_points: int) -> list[dict[str, Any]]:
    """At most ``max_points`` evenly spaced points, always keeping first and last."""
    n = len(points)
    if n <= max_points or max_points < 2:
        return points
    idx = sorted({round(i * (n - 1) / (max_points - 1)) for i in range(max_points)})
    return [points[i] for i in idx]
