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

    The two slices are tagged by *which* one is currently **live** so the render
    can put the live leg on top: while the market is open the live leg is
    ``market_hours_eur`` (the session that is moving right now) and the frozen
    ``overnight_eur`` is *last* night's drift; once the market shuts the live leg
    is ``overnight_eur`` (the after-hours drift since the close) and the frozen
    ``market_hours_eur`` is the *last* session's move.
    """

    #: The whole EUR P/L from today's EUR/USD move (prior close → now).
    total_eur: Decimal | None
    #: The slice that moved while the market was open. Live while open (session
    #: open → now); the frozen last-session move (prior close → session close)
    #: once shut.
    market_hours_eur: Decimal | None
    #: The slice that moved after-hours. Live once shut (session close → now);
    #: the frozen last overnight (prior close → session open) while open.
    overnight_eur: Decimal | None


def fx_effect_split(
    *,
    market_open: bool,
    total_value_usd: Decimal | None,
    live_fx: Decimal | None,
    session_close_fx: Decimal | None,
    today_fx_move_eur: Decimal | None,
    session_open_fx: Decimal | None = None,
) -> FxEffectSplit:
    """Split today's FX revaluation into its **market-hours** and **overnight** parts.

    Both legs are always derived from the day's whole move (``today_fx_move_eur``,
    prior close → now), carving out the *live* leg directly from the relevant
    session anchor and leaving the other as the remainder so the two always sum to
    the total:

    * **Market open** — the live leg is the **market-hours** drift since the
      session opened: ``value_usd · (1/live_fx − 1/open_fx)``. The remainder is
      *last* night's frozen overnight slice, which therefore **survives the market
      start** instead of folding to zero. Needs ``session_open_fx``.
    * **Market closed** — the live leg is the **overnight** drift since the close:
      ``value_usd · (1/live_fx − 1/close_fx)``. The remainder is the *last*
      session's frozen market-hours move. Needs ``session_close_fx``.

    Every field degrades to ``None`` when its inputs are missing so the UI shows
    "—" rather than a misleading zero. When the live anchor is missing the whole
    move falls back into the live leg (and the frozen leg is ``None``), so the UI
    hides the split rather than inventing a zero counterpart.
    """
    total_eur = today_fx_move_eur

    def _leg_from_anchor(anchor_fx: Decimal | None) -> Decimal | None:
        """EUR impact of the rate drifting from ``anchor_fx`` to the live spot."""
        if (
            total_value_usd is None
            or live_fx is None
            or live_fx <= 0
            or anchor_fx is None
            or anchor_fx <= 0
        ):
            return None
        return total_value_usd / live_fx - total_value_usd / anchor_fx

    market_hours_eur: Decimal | None
    overnight_eur: Decimal | None

    if market_open:
        # Live leg = market hours (session open → now); frozen leg = last overnight.
        live_leg = _leg_from_anchor(session_open_fx)
        if live_leg is None:
            market_hours_eur, overnight_eur = total_eur, None
        else:
            market_hours_eur = live_leg
            overnight_eur = None if total_eur is None else total_eur - live_leg
    else:
        # Live leg = overnight (session close → now); frozen leg = last market hours.
        live_leg = _leg_from_anchor(session_close_fx)
        if live_leg is None:
            market_hours_eur, overnight_eur = total_eur, None
        else:
            overnight_eur = live_leg
            market_hours_eur = None if total_eur is None else total_eur - live_leg

    return FxEffectSplit(
        total_eur=total_eur,
        market_hours_eur=market_hours_eur,
        overnight_eur=overnight_eur,
    )


@dataclass(frozen=True)
class FxBuyingPowerSplit:
    """The investing-power twin of :class:`FxEffectSplit`, expressed in **USD**.

    Where :class:`FxEffectSplit` measures the EUR revaluation of the whole book,
    this measures how many more (+) or fewer (−) dollars the owner's regular EUR
    investment amount — the euros they wire to the US to keep investing — buys now
    versus yesterday's close, split into the same market-hours and overnight legs.

    Every field is ``None`` when its inputs are missing so the UI hides the split
    rather than inventing a misleading zero.
    """

    #: The whole USD buying-power change on the notional (prior close → now).
    total_usd: Decimal | None
    #: The slice earned/lost while the market was open. Live while open.
    market_hours_usd: Decimal | None
    #: The slice earned/lost after-hours. Live once shut.
    overnight_usd: Decimal | None


def fx_buying_power_split(
    *,
    market_open: bool,
    amount_eur: Decimal | None,
    live_fx: Decimal | None,
    prev_fx: Decimal | None,
    session_close_fx: Decimal | None,
    session_open_fx: Decimal | None = None,
) -> FxBuyingPowerSplit:
    """Split the **buying-power** change on a fixed EUR notional into its legs.

    Because the notional is a fixed number of euros, the dollars it buys are
    simply ``amount_eur · fx``, so each leg is the *difference* in dollars bought
    across the relevant rate move:

    * whole move (prior close → now): ``amount_eur · (live_fx − prev_fx)``;
    * **market open** — the live leg is market hours since the session opened:
      ``amount_eur · (live_fx − open_fx)``; the remainder is last night's frozen
      overnight leg, so it survives the market start. Needs ``session_open_fx``.
    * **market closed** — the live leg is the overnight drift since the close:
      ``amount_eur · (live_fx − close_fx)``; the remainder is the last session's
      frozen market-hours leg. Needs ``session_close_fx``.

    A positive figure means the euro strengthened, so the same euros buy *more*
    dollars to invest. Every field degrades to ``None`` when its inputs are
    missing so the UI hides the split. This is the Python desktop twin of
    ``fxBuyingPowerSplit`` in ``web/src/session-fx.ts``, kept in lock-step.
    """
    usable_amount = amount_eur if amount_eur is not None and amount_eur > 0 else None
    live = live_fx if live_fx is not None and live_fx > 0 else None

    total_usd: Decimal | None
    if usable_amount is None or live is None or prev_fx is None or prev_fx <= 0:
        total_usd = None
    else:
        total_usd = usable_amount * (live - prev_fx)

    def _leg_from_anchor(anchor_fx: Decimal | None) -> Decimal | None:
        """USD bought now minus USD bought at ``anchor_fx`` on the fixed notional."""
        if usable_amount is None or live is None or anchor_fx is None or anchor_fx <= 0:
            return None
        return usable_amount * (live - anchor_fx)

    market_hours_usd: Decimal | None
    overnight_usd: Decimal | None

    if market_open:
        live_leg = _leg_from_anchor(session_open_fx)
        if live_leg is None:
            market_hours_usd, overnight_usd = total_usd, None
        else:
            market_hours_usd = live_leg
            overnight_usd = None if total_usd is None else total_usd - live_leg
    else:
        live_leg = _leg_from_anchor(session_close_fx)
        if live_leg is None:
            overnight_usd, market_hours_usd = total_usd, None
        else:
            overnight_usd = live_leg
            market_hours_usd = None if total_usd is None else total_usd - live_leg

    return FxBuyingPowerSplit(
        total_usd=total_usd,
        market_hours_usd=market_hours_usd,
        overnight_usd=overnight_usd,
    )
