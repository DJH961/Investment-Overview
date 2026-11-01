"""Currency-box maths for the Overview: market regime and "today" FX effect.

Extracted from ``ui/pages/overview.py`` so the NiceGUI page and the v6 API share
one implementation (numbers identical; only the HTML stays in the page).

💱 CURRENCY (rule in ``AGENTS.md``): the EUR effect is a *valuation at two
instants* (``usd / live_fx - usd / prev_fx``), the investing power is the regular
EUR amount times the rate move. Neither converts a return between currencies.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain import market_hours
from investment_dashboard.domain.market_hours import is_us_market_open
from investment_dashboard.domain.session_fx import fx_buying_power_split, fx_effect_split
from investment_dashboard.services import intraday_snapshots_service
from investment_dashboard.services.metrics_service import PortfolioMetrics


@dataclass(frozen=True)
class FxBoxRegime:
    """The currency box's market-state regime, derived purely from ``now``.

    * ``forex_frozen`` - spot-FX weekend close (rate frozen at Friday's close).
    * ``market_open`` - the live US session.
    * ``weekend_overnight`` - forex reopened (Sun evening) but no US session yet.
    * ``holiday`` - US-only market holiday (forex trades, US shut).
    * ``single_overnight`` - holiday regime: one overnight number, no split.
    * ``session_view`` - complement of ``single_overnight``.
    """

    market_open: bool
    forex_open: bool
    holiday: bool
    forex_frozen: bool
    weekend_overnight: bool
    single_overnight: bool
    session_view: bool


def fx_box_regime(now: datetime) -> FxBoxRegime:
    """Compute the :class:`FxBoxRegime` for ``now``."""
    market_open = is_us_market_open(now)
    forex_open = market_hours.is_forex_market_open(now)
    holiday = market_hours.is_us_market_holiday_at(now)
    forex_frozen = not forex_open
    last_session = intraday_snapshots_service.last_session_date(now)
    weekend_overnight = (
        forex_open
        and not market_open
        and not holiday
        and market_hours.regular_session_open(last_session) < market_hours.last_forex_reopen(now)
    )
    single_overnight = forex_open and not market_open and holiday
    session_view = not single_overnight
    return FxBoxRegime(
        market_open=market_open,
        forex_open=forex_open,
        holiday=holiday,
        forex_frozen=forex_frozen,
        weekend_overnight=weekend_overnight,
        single_overnight=single_overnight,
        session_view=session_view,
    )


def prior_fx(session: Session, metrics: PortfolioMetrics, now: datetime) -> Decimal | None:
    """The prior-session EUR/USD anchor: settled previous close, else session close."""
    prev = metrics.daily_growth_fx_eur_usd_prev
    if prev is not None and prev > 0:
        return prev
    close = intraday_snapshots_service.session_close_fx(session, now=now)
    if close is not None and close > 0:
        return close
    return None


def eur_effect_from_anchor(
    usd: Decimal | None, live_fx: Decimal | None, anchor_fx: Decimal | None
) -> Decimal | None:
    """``usd * (1/live_fx - 1/anchor_fx)``; ``None`` when any input is missing."""
    if anchor_fx is None or anchor_fx <= 0 or live_fx is None or live_fx <= 0 or usd is None:
        return None
    return usd / live_fx - usd / anchor_fx


@dataclass(frozen=True)
class EurFxEffect:
    """Today's EUR P/L from the EUR/USD move on the USD-booked book."""

    net_eur: Decimal
    regime: FxBoxRegime
    market_hours_eur: Decimal | None
    overnight_eur: Decimal | None


def compute_eur_fx_effect(
    session: Session,
    metrics: PortfolioMetrics,
    *,
    live_fx: Decimal,
    prev_fx: Decimal | None,
    now: datetime,
) -> EurFxEffect | None:
    """The EUR currency-effect numbers, or ``None`` when there is no swing to show."""
    regime = fx_box_regime(now)
    market_open = regime.market_open
    usd = metrics.total_value_usd

    net_eur = Decimal(0)
    if prev_fx is not None and prev_fx > 0 and usd is not None and live_fx > 0:
        net_eur = usd / live_fx - usd / prev_fx
    if regime.session_view and not market_open:
        open_fx = intraday_snapshots_service.session_open_fx(session, now=now)
        reanchored = eur_effect_from_anchor(usd, live_fx, open_fx)
        if reanchored is not None:
            net_eur = reanchored
    if net_eur == 0 and (prev_fx is None or prev_fx <= 0):
        reanchored = eur_effect_from_anchor(usd, live_fx, prior_fx(session, metrics, now))
        if reanchored is not None:
            net_eur = reanchored
    if net_eur == 0:
        return None

    if regime.single_overnight:
        return EurFxEffect(net_eur, regime, None, None)

    if market_open:
        open_fx = intraday_snapshots_service.session_open_fx(session, now=now)
        split = fx_effect_split(
            market_open=True,
            total_value_usd=usd,
            live_fx=live_fx,
            session_close_fx=None,
            session_open_fx=open_fx,
            today_fx_move_eur=net_eur,
        )
    else:
        close_fx = intraday_snapshots_service.session_close_fx(session, now=now)
        split = fx_effect_split(
            market_open=False,
            total_value_usd=usd,
            live_fx=live_fx,
            session_close_fx=close_fx,
            today_fx_move_eur=net_eur,
        )
    return EurFxEffect(net_eur, regime, split.market_hours_eur, split.overnight_eur)


@dataclass(frozen=True)
class InvestingPower:
    """USD-display twin: dollars the regular EUR amount gains/loses on the rate move."""

    net_usd: Decimal
    regime: FxBoxRegime
    market_hours_usd: Decimal | None
    overnight_usd: Decimal | None


def compute_investing_power(
    session: Session,
    metrics: PortfolioMetrics,
    *,
    amount_eur: Decimal,
    live_fx: Decimal,
    now: datetime,
) -> InvestingPower | None:
    """``amount_eur * (live_fx - prev_fx)``, or ``None`` with no anchor / no swing."""
    regime = fx_box_regime(now)
    market_open = regime.market_open

    prev_fx = prior_fx(session, metrics, now)
    if regime.session_view and not market_open:
        open_fx = intraday_snapshots_service.session_open_fx(session, now=now)
        if open_fx is not None and open_fx > 0:
            prev_fx = open_fx
    if prev_fx is None or live_fx <= 0 or prev_fx <= 0:
        return None
    net_usd = amount_eur * (live_fx - prev_fx)
    if net_usd == 0:
        return None

    if regime.single_overnight:
        return InvestingPower(net_usd, regime, None, None)

    if market_open:
        open_fx = intraday_snapshots_service.session_open_fx(session, now=now)
        split = fx_buying_power_split(
            market_open=True,
            amount_eur=amount_eur,
            live_fx=live_fx,
            prev_fx=prev_fx,
            session_close_fx=None,
            session_open_fx=open_fx,
        )
    else:
        close_fx = intraday_snapshots_service.session_close_fx(session, now=now)
        split = fx_buying_power_split(
            market_open=False,
            amount_eur=amount_eur,
            live_fx=live_fx,
            prev_fx=prev_fx,
            session_close_fx=close_fx,
        )
    return InvestingPower(net_usd, regime, split.market_hours_usd, split.overnight_usd)
