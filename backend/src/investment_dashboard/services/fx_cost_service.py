"""What converting costs (7.3): a read-time join of ``fx_conversions`` and the FX history.

No new columns. The ECB fixings come through :mod:`fx_service` (cache tier), the maths is
:mod:`domain.fx_spread`. A weekend or holiday conversion is measured against the last
settled fixing before its date.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

from investment_dashboard.domain import fx_spread
from investment_dashboard.services import fx_conversion_service, fx_service

if TYPE_CHECKING:
    from sqlalchemy.orm import Session


def conversions_with_fixings(session: Session) -> list[fx_spread.Conversion]:
    """Every real EUR to USD conversion with the settled fixing it is compared with.

    Estimated conversions (recurring plans, not settled yet) are left out: their rate is
    itself derived from these averages, so costs, markers and the provider offset only
    ever read what really happened.
    """
    rows = fx_conversion_service.list_conversions(session)
    rates = fx_service.get_settled_rates(session, base="EUR", quote="USD")
    today = date.today()
    out: list[fx_spread.Conversion] = []
    for r in rows:
        if r.is_estimate:
            continue
        fixing = fx_spread.fixing_for(rates, r.date)
        month = fx_spread.month_average(rates, r.date, today)
        out.append(
            fx_spread.Conversion(
                id=r.id,
                date=r.date,
                eur_sent=r.eur_sent,
                usd_received=r.usd_received,
                fees_eur=r.fees_eur if r.fees_eur is not None else Decimal(0),
                provider=r.provider,
                ecb_rate=None if fixing is None else fixing[0],
                ecb_rate_date=None if fixing is None else fixing[1],
                month_avg=None if month is None else month[0],
                month_so_far=month is not None and month[1],
            )
        )
    return out


def conversion_costs(session: Session) -> list[fx_spread.ConversionCost]:
    """Per-conversion costs, oldest first."""
    return [fx_spread.conversion_cost(c) for c in conversions_with_fixings(session)]


def cost_report(
    session: Session, *, start: date | None = None, end: date | None = None
) -> fx_spread.CostReport:
    return fx_spread.build_report(conversions_with_fixings(session), start=start, end=end)


def provider_avg_off_pct(session: Session, provider: str | None) -> Decimal | None:
    """The provider's EUR-weighted average distance from the ECB fixing, fees left out.

    ``rate / ecb - 1`` (negative = fewer dollars per euro than the reference); ``provider``
    is ``"wise"``, ``"revolut"``, ``"other"`` or ``None``. ``None`` when it has no priced
    conversion.
    """
    return fx_spread.provider_avg_off_pct(conversion_costs(session), provider)
