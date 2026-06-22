"""Presentation helper for the Overview *Daily Growth* card caption.

The percentage itself is computed in :mod:`metrics_service`; this module turns
the surrounding context — which two trading days the move spans, the EUR/USD
marks on each, the user's display currency and timezone, and whether the market
is open right now — into the small caption under the card.

Two shapes, mirroring the user's mental model:

* **Market open** (we have today's prints *and* the NYSE session is live): the
  caption is time-stamped ("as of 15:42") and quotes the *live* FX rate plus how
  far it has moved since the prior trading day.
* **Market closed**: the caption pins to the last open-market date ("as of
  today" when that is today, otherwise e.g. "as of Fri 20 Jun") and quotes that
  day's settled FX rate and its change. When Frankfurter has not published the
  day's ECB rate yet, ``metrics_service`` has already forward-filled the live
  spot into the mark, so the figure is still current rather than blank.

The FX rate is flipped to the display currency so it always reads as "one unit
of the *other* currency in your currency": EUR users see ``1 USD = 0.92 EUR``,
USD users see ``1 EUR = 1.08 USD``.

Pure and timezone-aware so it can be unit-tested without a NiceGUI context.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, tzinfo
from decimal import Decimal


@dataclass(frozen=True)
class DailyGrowthCaption:
    """Rendered pieces of the Daily Growth caption.

    ``as_of_text`` is always present; ``fx_text`` is ``None`` only when no FX
    marks are available (e.g. a brand-new portfolio with no EUR/USD history).
    ``is_live`` drives the small "live" affordance in the UI.
    """

    as_of_text: str
    fx_text: str | None
    is_live: bool

    def combined(self) -> str:
        """Single caption line: ``as of … · 1 USD = … (…)``."""
        parts = [self.as_of_text]
        if self.fx_text is not None:
            parts.append(self.fx_text)
        return " \u00b7 ".join(parts)


def _flip_rate(eur_usd: Decimal, display_ccy: str) -> tuple[Decimal, str, str]:
    """Return ``(rate, base_ccy, quote_ccy)`` for the display-relative quote.

    ``eur_usd`` is USD per 1 EUR (the storage convention). EUR users want USD
    priced in EUR (``1 USD = x EUR``); USD users want EUR priced in USD
    (``1 EUR = x USD``).
    """
    if display_ccy.upper() == "USD":
        return eur_usd, "EUR", "USD"
    # Default / EUR: invert so we quote the foreign (USD) unit in EUR.
    return (Decimal(1) / eur_usd), "USD", "EUR"


def _format_fx(
    eur_usd_last: Decimal,
    eur_usd_prev: Decimal | None,
    display_ccy: str,
    *,
    is_live: bool,
) -> str:
    rate, base_ccy, quote_ccy = _flip_rate(eur_usd_last, display_ccy)
    text = f"1 {base_ccy} = {rate:.4f} {quote_ccy}"
    if eur_usd_prev is not None and eur_usd_prev > 0:
        prev_rate, _, _ = _flip_rate(eur_usd_prev, display_ccy)
        delta = rate - prev_rate
        sign = "+" if delta >= 0 else "\u2212"  # proper minus sign
        pct = (delta / prev_rate * Decimal(100)) if prev_rate != 0 else Decimal(0)
        text += f" ({sign}{abs(delta):.4f}, {sign}{abs(pct):.2f}%)"
    text += " \u00b7 live FX" if is_live else " \u00b7 end-of-day FX"
    return text


def build_daily_growth_caption(
    *,
    last_date: date | None,
    prev_date: date | None,
    eur_usd_last: Decimal | None,
    eur_usd_prev: Decimal | None,
    display_ccy: str,
    today: date,
    now: datetime,
    tz: tzinfo | None,
    market_open: bool,
) -> DailyGrowthCaption:
    """Build the caption for the Daily Growth card.

    ``last_date`` / ``prev_date`` are the two trading days the growth spans;
    ``eur_usd_last`` / ``eur_usd_prev`` the EUR→USD marks on each (already
    live-overlaid for today by the metrics layer). ``now`` is timezone-aware
    "now"; ``tz`` the user's display timezone for the time stamp. ``market_open``
    is the NYSE session state (see :mod:`domain.market_hours`).
    """
    if last_date is None:
        return DailyGrowthCaption("awaiting two priced days", None, is_live=False)

    is_live = market_open and last_date == today
    if is_live:
        stamped = now.astimezone(tz) if tz is not None else now
        as_of_text = f"as of {stamped:%H:%M}"
    elif last_date == today:
        as_of_text = "as of today"
    else:
        as_of_text = f"as of {last_date:%a %d %b}"

    fx_text: str | None = None
    if eur_usd_last is not None and eur_usd_last > 0:
        fx_text = _format_fx(eur_usd_last, eur_usd_prev, display_ccy, is_live=is_live)
    return DailyGrowthCaption(as_of_text, fx_text, is_live=is_live)
