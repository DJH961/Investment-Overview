"""How EUR/USD FX is wired into the value graphs across the market-hours boundary.

The book is **USD-booked** (spot prices arrive in USD) but the owner lives in the
euro zone, so the EUR view of the portfolio re-marks at the live EUR/USD spot. FX
trades ~24h while the US equity session is only 09:30–16:00 ET, so the EUR value
keeps drifting **after the market has closed** even though every security price is
frozen at its settled close.

That after-hours drift must be handled differently per graph:

* The **1D** and **1W** curves draw a *market-day trajectory*. Once the session
  has shut they should sit still — re-marking them at every after-hours FX tick
  would shift the whole euro line up and down overnight, which is not something
  that happened *during* the trading day. So while the market is closed these
  curves are anchored to the **session-close FX** (:func:`graph_anchor_fx`),
  frozen for the night.
* The longer **history** graphs (Month / YTD / Year / All) and the headline total
  always value at the **live** after-hours spot, so the euro figure the user sees
  is genuinely current.

The gap between those two — the headline EUR total (live FX) minus the
session-close EUR total (frozen FX) — is exactly the *overnight* FX P/L, which
:func:`fx_effect_split` isolates from the in-session FX move so the user can see
what shifted during the trading day versus what changed overnight.

All maths is pure :class:`~decimal.Decimal` so it can be unit-tested without a
NiceGUI context or a live feed. Every rate is quoted **USD per 1 EUR** (the
conventional EUR/USD quote).

This is the Python desktop twin of ``web/src/session-fx.ts`` in the live web
companion, kept deliberately in lock-step so both surfaces freeze the 1D/1W
trajectory and split today's FX revaluation the same way.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

ZERO = Decimal(0)


def graph_anchor_fx(
    *,
    market_open: bool,
    live_fx: Decimal | None,
    session_close_fx: Decimal | None,
    settled_prev_fx: Decimal | None = None,
) -> Decimal | None:
    """The EUR→USD rate the **live 1D/1W graphs** should anchor their EUR view to.

    While the regular session is open the live spot *is* the session's rate, so it
    is used directly. Once the market has closed the curves freeze so the
    market-day trajectory does not slide with overnight FX, resolving through a
    defined fallback chain:

    1. the ``session_close_fx`` (the rate as the session settled) when it is
       known — on the desktop this is read straight from the stored intraday FX
       samples (the bars the curve is drawn from), so it is continuous with the
       curve body and survives the app not being open at 16:00 ET;
    2. else the settled ``settled_prev_fx`` (the prior session's settled close) —
       a real, non-drifting rate that, on a weekend / cold start, *is* the session
       close, so the freeze still works when no intraday sample was captured;
    3. else, as a last resort, the live rate — the same behaviour as before this
       freezing existed.

    Anchoring to a settled rate (1 or 2) over the live one matters only for the
    curve's *stability*; the honest market-hours/overnight attribution in
    :func:`fx_effect_split` deliberately still requires the genuine
    ``session_close_fx``.
    """
    if market_open:
        return live_fx
    settled_prev = settled_prev_fx if settled_prev_fx is not None and settled_prev_fx > 0 else None
    if session_close_fx is not None:
        return session_close_fx
    if settled_prev is not None:
        return settled_prev
    return live_fx


@dataclass(frozen=True)
class FxEffectSplit:
    """Today's FX revaluation split into its in-session and after-hours slices.

    Every field is ``None`` when its inputs are missing (no USD exposure, no rate
    pair, or no FX move) so the UI shows "—" rather than a misleading zero.
    """

    #: The whole EUR P/L from today's EUR/USD move (prior close → now).
    total_eur: Decimal | None
    #: The slice that moved while the market was open (prior close → session close).
    market_hours_eur: Decimal | None
    #: The slice that moved after the close (session close → now). Zero while open.
    overnight_eur: Decimal | None


def fx_effect_split(
    *,
    market_open: bool,
    total_value_usd: Decimal | None,
    live_fx: Decimal | None,
    session_close_fx: Decimal | None,
    today_fx_move_eur: Decimal | None,
) -> FxEffectSplit:
    """Split today's FX revaluation into its **market-hours** and **overnight** parts.

    The after-hours slice is the EUR impact of the rate drifting from the
    session-close rate to the live rate on the current USD book:
    ``value_usd · (1/live_fx − 1/close_fx)`` — i.e. the EUR total at the live spot
    minus the EUR total at the frozen close spot. The in-session slice is then
    simply the remainder of ``today_fx_move_eur`` (which spans the prior close to
    now). While the market is open there is no overnight slice yet, so the whole
    move is in-session.

    Every field degrades to ``None`` when its inputs are missing so the UI shows
    "—" rather than a misleading zero.
    """
    total_eur = today_fx_move_eur

    overnight_eur: Decimal | None = ZERO if market_open else None
    if (
        not market_open
        and total_value_usd is not None
        and live_fx is not None
        and session_close_fx is not None
        and live_fx > 0
        and session_close_fx > 0
    ):
        eur_at_live = total_value_usd / live_fx
        eur_at_close = total_value_usd / session_close_fx
        overnight_eur = eur_at_live - eur_at_close

    market_hours_eur: Decimal | None = None
    if total_eur is not None:
        market_hours_eur = total_eur if overnight_eur is None else total_eur - overnight_eur

    return FxEffectSplit(
        total_eur=total_eur,
        market_hours_eur=market_hours_eur,
        overnight_eur=overnight_eur,
    )
