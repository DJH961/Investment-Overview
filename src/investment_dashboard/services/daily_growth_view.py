"""Presentation helper for the Overview *Daily Growth* card caption.

The percentage itself is computed in :mod:`metrics_service`; this module turns
the surrounding context — which trading day the move lands on, the user's
display currency and timezone, and whether the market is open right now — into
the small, tight caption under the card.

Three shapes, mirroring the user's mental model:

* **Market open / live** (we have today's prints *and* the NYSE session is live):
  the figure tracks the moving session, so a clock time is redundant next to the
  ``· live`` flag — it is omitted ("as of today · live").
* **Closed, but today's close is in** (TODAY): the price is settled, so the
  caption stamps *when it is from* on the exchange — the provider's market time
  (``price_market_at``, e.g. when a mutual fund's NAV published) — and trails
  our own pull instant as "· updated …" so the figure is dated by the market,
  not by our fetch. When the provider publishes no market time it falls back to
  the pull instant (``price_observed_at``) and then to the modelled
  regular-session close.
* **Older close**: the caption pins to that date ("as of Fri 20 Jun").

A compact exchange-rate detail trails the caption when an EUR/USD mark is
available — quoted relative to the display currency and tightened to the spot
plus its percentage move versus the prior trading day's mark ("€1≈$1.0830
(+0.10%)" for USD users, "$1≈€0.9234 (−0.10%)" for EUR users). The move is a
*percentage only* (no absolute), and reads live while the session is open
because the metrics layer overlays the live spot onto today's mark.

Pure and timezone-aware so it can be unit-tested without a NiceGUI context.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, tzinfo
from decimal import Decimal

from investment_dashboard.domain.market_hours import regular_session_close


@dataclass(frozen=True)
class DailyGrowthCaption:
    """Rendered pieces of the Daily Growth caption.

    ``as_of_text`` is always present; ``updated_text`` carries the optional
    "updated …" pull-time stamp shown next to a market-dated settled figure;
    ``fx_text`` is ``None`` only when no FX mark is available (e.g. a brand-new
    portfolio with no EUR/USD history). ``is_live`` drives the small "live"
    affordance in the combined line.
    """

    as_of_text: str
    fx_text: str | None
    is_live: bool
    updated_text: str | None = None

    def combined(self) -> str:
        """Single tight caption line: ``as of … · updated … · live · €1≈$…``.

        All parts after ``as of …`` are optional; ``updated …`` only appears in
        the settled-today state when the figure is dated by the exchange's market
        time and we also know our own pull instant.
        """
        parts = [self.as_of_text]
        if self.updated_text is not None:
            parts.append(self.updated_text)
        if self.is_live:
            parts.append("live")
        if self.fx_text is not None:
            parts.append(self.fx_text)
        return " \u00b7 ".join(parts)


def _display_rate(eur_usd: Decimal, display_ccy: str) -> Decimal:
    """The spot quoted relative to the display currency.

    ``eur_usd`` is USD per 1 EUR (the storage convention). USD users price EUR
    in USD (the rate as-is); EUR users price the foreign USD unit in EUR (its
    inverse).
    """
    if display_ccy.upper() == "USD":
        return eur_usd
    return Decimal(1) / eur_usd


def _format_fx_tight(eur_usd: Decimal, eur_usd_prev: Decimal | None, display_ccy: str) -> str:
    """Compact display-relative spot plus its percentage move.

    USD users read ``€1≈$1.0830 (+0.10%)``; EUR users read ``$1≈€0.9234
    (−0.10%)``. The move is a *percentage only* (no absolute) versus the prior
    trading day's mark; it is omitted when no comparison mark is available.
    """
    rate = _display_rate(eur_usd, display_ccy)
    text = (
        f"\u20ac1\u2248${rate:.4f}" if display_ccy.upper() == "USD" else f"$1\u2248\u20ac{rate:.4f}"
    )
    if eur_usd_prev is not None and eur_usd_prev > 0:
        prev = _display_rate(eur_usd_prev, display_ccy)
        if prev != 0:
            pct = (rate - prev) / prev * Decimal(100)
            sign = "+" if pct >= 0 else "\u2212"  # proper minus sign
            text += f" ({sign}{abs(pct):.2f}%)"
    return text


def _local_hhmm(moment: datetime, tz: tzinfo | None) -> str:
    """Format ``moment`` as ``HH:MM`` in ``tz``.

    Naive timestamps are treated as UTC (the storage convention for the saved
    last-refresh instant) before converting to the user's display timezone.
    """
    aware = moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)
    local = aware.astimezone(tz) if tz is not None else aware
    return f"{local:%H:%M}"


def build_daily_growth_caption(
    *,
    last_date: date | None,
    fx_eur_usd: Decimal | None,
    fx_eur_usd_prev: Decimal | None = None,
    display_ccy: str,
    today: date,
    tz: tzinfo | None,
    market_open: bool,
    price_observed_at: datetime | None = None,
    price_market_at: datetime | None = None,
) -> DailyGrowthCaption:
    """Build the caption for the Daily Growth card.

    ``last_date`` is the most recent trading day the growth lands on.
    ``fx_eur_usd`` is the EUR→USD mark (USD per 1 EUR, already live-overlaid for
    today by the metrics layer) and ``fx_eur_usd_prev`` the prior trading day's
    mark; ``display_ccy`` flips them to the display-relative quote and percentage
    move. ``tz`` is the user's display timezone for the time stamp.
    ``market_open`` is the NYSE session state (see :mod:`domain.market_hours`).

    ``price_market_at`` is *when the price is from* on the exchange — the
    provider's ``regularMarketTime`` (e.g. when a mutual fund's NAV published).
    In the settled-today state the caption dates the figure by this market time
    and trails our own ``price_observed_at`` (when we last pulled the price) as
    "· updated …", so the user sees the exchange's stamp, not our fetch. When the
    provider does not publish a market time the caption falls back to the pull
    instant, and then to the modelled regular-session close.
    """
    if last_date is None:
        return DailyGrowthCaption("awaiting two priced days", None, is_live=False)

    is_live = market_open and last_date == today
    updated_text: str | None = None
    if is_live:
        # Live: the figure tracks the open session, so a clock time is redundant
        # next to the "· live" flag — omit it (see combined()).
        as_of_text = "as of today"
    elif last_date == today:
        # Settled, but today's close is in: stamp *when the price is from*.
        # Prefer the exchange's market time (e.g. the NAV publish instant) and
        # trail our own pull time as "updated …"; fall back to the pull time,
        # then to the modelled regular-session close, when no market time exists.
        if price_market_at is not None:
            as_of_text = f"as of {_local_hhmm(price_market_at, tz)}"
            if price_observed_at is not None:
                updated_text = f"updated {_local_hhmm(price_observed_at, tz)}"
        elif price_observed_at is not None:
            as_of_text = f"as of {_local_hhmm(price_observed_at, tz)}"
        else:
            close_at = regular_session_close(last_date, tz=tz)
            as_of_text = f"as of {close_at:%H:%M}"
    else:
        as_of_text = f"as of {last_date:%a %d %b}"

    fx_text: str | None = None
    if fx_eur_usd is not None and fx_eur_usd > 0:
        fx_text = _format_fx_tight(fx_eur_usd, fx_eur_usd_prev, display_ccy)
    return DailyGrowthCaption(as_of_text, fx_text, is_live=is_live, updated_text=updated_text)
