"""Presentation helper for the Overview *Daily Growth* card caption.

The percentage itself is computed in :mod:`metrics_service`; this module turns
the surrounding context — which trading day the move lands on, the user's
display currency and timezone, and whether the market is open right now — into
the small, tight caption under the card.

Three shapes, mirroring the user's mental model — and the caption leads with
**exactly one** state word, never a combination:

* **Market open / live**: the figure tracks the moving session, so the caption is
  just ``live`` (no redundant "today" or clock next to it).
* **Closed, but today's close is in** (``today``): the price is settled; the
  caption leads with ``today`` and trails *when it is from* on the exchange — the
  provider's market time (``price_market_at``, e.g. when a mutual fund's NAV
  published) — plus our own pull instant as "· updated …", as a secondary detail.
  When the provider publishes no market time it falls back to the pull instant
  (``price_observed_at``) and then to the modelled regular-session close.
* **Older close**: the caption pins to that date ("as of Fri 20 Jun"). On a
  weekend, holiday or early morning this is the prior trading day.

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
        """Single tight caption line: ``<live|today|as of …> · … · €1≈$…``.

        The leading token is exactly one of the three states — ``live`` (the
        session is open now), ``today`` (settled, today's close is in) or ``as of
        <date>`` (an older settled close) — never a combination. All parts after
        it are optional details (not state descriptors): the settled-today
        precise stamp (``as of <market time> · updated <pull time>``) and the FX
        mark.
        """
        parts = [self.as_of_text]
        if self.updated_text is not None:
            parts.append(self.updated_text)
        if self.fx_text is not None:
            parts.append(self.fx_text)
        return " \u00b7 ".join(parts)


def _display_rate(eur_usd: Decimal, display_ccy: str) -> Decimal:
    """The spot quoted relative to the display currency.

    ``eur_usd`` is USD per 1 EUR (the storage convention). USD users price EUR in
    USD (the rate as-is, EUR/USD); EUR users price the foreign USD unit in EUR
    (its inverse, USD/EUR).
    """
    if display_ccy.upper() == "USD":
        return eur_usd
    return Decimal(1) / eur_usd


def _format_fx_tight(eur_usd: Decimal, eur_usd_prev: Decimal | None, display_ccy: str) -> str:
    """Compact display-relative spot plus its percentage move.

    USD users read ``€1≈$1.0830 (+0.10%)``; EUR users read ``$1≈€0.9234
    (−0.10%)``. The percentage still tracks the strength of the *foreign* currency
    you convert into — the euro in USD display, the dollar in EUR display — so a
    positive figure means "that currency went up". The move is a percentage only
    (no absolute) versus the prior trading day's mark, and is omitted when no
    comparison mark is available.
    """
    rate = _display_rate(eur_usd, display_ccy)
    text = (
        f"\u20ac1\u2248${rate:.4f}" if display_ccy.upper() == "USD" else f"$1\u2248\u20ac{rate:.4f}"
    )
    if eur_usd_prev is not None and eur_usd_prev > 0:
        # The euro's own move (USD per 1 EUR). USD display reports it as-is (the
        # euro's strength); EUR display negates it to read the dollar's strength.
        euro_move = (eur_usd - eur_usd_prev) / eur_usd_prev * Decimal(100)
        pct = euro_move if display_ccy.upper() == "USD" else -euro_move
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
        # Live: the figure tracks the open session. The state is fully conveyed
        # by the single word "live" — a clock time or a redundant "today" next to
        # it would be the "both/multiple" the caption deliberately avoids.
        as_of_text = "live"
    elif last_date == today:
        # Settled, but today's close is in: the state is "today". The precise
        # stamp(s) trail as a secondary detail (not a competing state token):
        # prefer the exchange's market time (e.g. the NAV publish instant) and
        # trail our own pull time as "updated …"; fall back to the pull time,
        # then to the modelled regular-session close, when no market time exists.
        as_of_text = "today"
        if price_market_at is not None:
            detail = f"as of {_local_hhmm(price_market_at, tz)}"
            if price_observed_at is not None:
                detail += f" \u00b7 updated {_local_hhmm(price_observed_at, tz)}"
        elif price_observed_at is not None:
            detail = f"as of {_local_hhmm(price_observed_at, tz)}"
        else:
            close_at = regular_session_close(last_date, tz=tz)
            detail = f"as of {close_at:%H:%M}"
        updated_text = detail
    else:
        as_of_text = f"as of {last_date:%a %d %b}"

    fx_text: str | None = None
    if fx_eur_usd is not None and fx_eur_usd > 0:
        fx_text = _format_fx_tight(fx_eur_usd, fx_eur_usd_prev, display_ccy)
    return DailyGrowthCaption(as_of_text, fx_text, is_live=is_live, updated_text=updated_text)
