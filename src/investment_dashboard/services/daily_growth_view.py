"""Presentation helper for the Overview *Daily Growth* card caption.

The percentage itself is computed in :mod:`metrics_service`; this module turns
the surrounding context — which trading day the move lands on, the user's
display timezone, and whether the market is open right now — into the small,
tight caption under the card.

Two shapes, mirroring the user's mental model:

* **Market open** (we have today's prints *and* the NYSE session is live): the
  caption is time-stamped and flagged live ("as of 15:42 · live").
* **Market closed**: the caption pins to the last open-market date ("as of
  today" when that is today, otherwise e.g. "as of Fri 20 Jun").

Deliberately tight: the exchange-rate detail used to trail this caption, but it
duplicated the FX line below the KPI grid and made the card noisy, so the live
state is all that is kept here.

Pure and timezone-aware so it can be unit-tested without a NiceGUI context.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, tzinfo


@dataclass(frozen=True)
class DailyGrowthCaption:
    """Rendered pieces of the Daily Growth caption.

    ``as_of_text`` is always present; ``is_live`` drives the small "live"
    affordance appended to the combined line.
    """

    as_of_text: str
    is_live: bool

    def combined(self) -> str:
        """Single tight caption line: ``as of … · live`` (``· live`` only live)."""
        if self.is_live:
            return f"{self.as_of_text} \u00b7 live"
        return self.as_of_text


def build_daily_growth_caption(
    *,
    last_date: date | None,
    display_ccy: str,
    today: date,
    now: datetime,
    tz: tzinfo | None,
    market_open: bool,
) -> DailyGrowthCaption:
    """Build the caption for the Daily Growth card.

    ``last_date`` is the most recent trading day the growth lands on. ``now`` is
    a timezone-aware "now"; ``tz`` the user's display timezone for the time
    stamp. ``market_open`` is the NYSE session state (see
    :mod:`domain.market_hours`). ``display_ccy`` is accepted for call-site
    symmetry with the other Overview captions but no longer affects the text.
    """
    del display_ccy  # kept for caller symmetry; FX detail intentionally dropped
    if last_date is None:
        return DailyGrowthCaption("awaiting two priced days", is_live=False)

    is_live = market_open and last_date == today
    if is_live:
        stamped = now.astimezone(tz) if tz is not None else now
        as_of_text = f"as of {stamped:%H:%M}"
    elif last_date == today:
        as_of_text = "as of today"
    else:
        as_of_text = f"as of {last_date:%a %d %b}"

    return DailyGrowthCaption(as_of_text, is_live=is_live)
