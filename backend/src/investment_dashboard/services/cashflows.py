"""Canonical cash-leg / cashflow currency logic (one copy for the whole app).

Every place that needs "how much cash did this transaction move, in EUR or
USD" goes through :func:`txn_amount` (or its EUR / USD specialisations), and
every XIRR / TWR cashflow stream comes from :func:`build_portfolio_cashflows`
or :func:`build_portfolio_cashflows_dual`.

Currency rule (AGENTS.md): amounts are native; a reporting-currency figure is
derived per transaction at **its own date's** rate. Never a return converted
into another currency.

Missing-FX policy (the only one): when a leg cannot be derived honestly (no
frozen leg, native currency differs from the target and no rate is on file) the
amount function returns ``None``. Callers **omit** such rows from sums and
cashflow streams; ``0`` is never a stand-in for "unknown", a EUR figure is never
relabelled as USD and a rate is never defaulted to ``1``.

EUR overrides: ``eur_overrides`` maps a transaction id to the *effective* EUR
cost of that cash leg (the FX-conversion pool, see
:func:`fx_conversion_service.effective_eur_overrides`). It only affects the EUR
leg; USD figures are untouched. Functions here treat ``None`` as "no
overrides"; session-level call sites resolve the default with
:func:`eur_overrides_for`.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from investment_dashboard.domain import kinds
from investment_dashboard.domain.currency import lookup_rate_with_forward_fill
from investment_dashboard.domain.returns import Cashflow

if TYPE_CHECKING:
    from investment_dashboard.models import Transaction

ZERO = Decimal(0)

CONTRIBUTION_KINDS = kinds.CONTRIBUTION_KINDS
WITHDRAWAL_KINDS = kinds.WITHDRAWAL_KINDS
EXTERNAL_FLOW_KINDS = kinds.EXTERNAL_FLOW_KINDS
DISTRIBUTION_KINDS = kinds.DISTRIBUTION_KINDS

Rates = Mapping[date, Decimal]


def eur_overrides_for(session: Session) -> dict[int, Decimal]:
    """The FX-pool effective-EUR map for ``session`` (empty without conversions)."""
    from investment_dashboard.services import fx_conversion_service  # noqa: PLC0415

    return fx_conversion_service.effective_eur_overrides(session)


def native_currency(t: Transaction) -> str:
    """Upper-case native currency of the transaction's account (EUR if unknown)."""
    return (t.account.native_currency if t.account else "EUR").upper()


def _rate(eur_to_usd: Rates | None, on: date) -> Decimal | None:
    if not eur_to_usd:
        return None
    rate = lookup_rate_with_forward_fill(eur_to_usd, on)
    return None if rate is None or rate == 0 else rate


def derived_eur(t: Transaction, eur_to_usd: Rates | None) -> Decimal | None:
    """EUR leg derived from ``net_native`` + the FX table (never the frozen leg).

    ``None`` when the native amount, the rate or (for a non-EUR/USD currency) a
    cross rate is missing.
    """
    if t.net_native is None:
        return None
    ccy = native_currency(t)
    if ccy == "EUR":
        return t.net_native
    if ccy == "USD":
        rate = _rate(eur_to_usd, t.date)
        return t.net_native / rate if rate is not None else None
    return None


def derived_usd(t: Transaction, eur_to_usd: Rates | None) -> Decimal | None:
    """USD leg derived from ``net_native`` + the FX table (never the frozen leg)."""
    if t.net_native is None:
        return None
    ccy = native_currency(t)
    if ccy == "USD":
        return t.net_native
    if ccy == "EUR":
        rate = _rate(eur_to_usd, t.date)
        return t.net_native * rate if rate is not None else None
    return None


def _base_eur(t: Transaction, eur_to_usd: Rates | None) -> Decimal | None:
    """EUR cash leg *before* any FX-pool override.

    Derived from ``net_native`` at the transaction date's rate; the frozen
    ``net_eur`` is only a fallback when it cannot be derived (no rate on file,
    other native currency). It is otherwise a read-only cross-check.
    """
    derived = derived_eur(t, eur_to_usd)
    return derived if derived is not None else t.net_eur


def txn_eur_amount(
    t: Transaction,
    *,
    eur_to_usd: Rates | None = None,
    eur_overrides: Mapping[int, Decimal] | None = None,
) -> Decimal | None:
    """EUR cash leg of one transaction, or ``None`` when it cannot be derived."""
    if eur_overrides and t.id is not None and t.id in eur_overrides:
        return eur_overrides[t.id]
    return _base_eur(t, eur_to_usd)


def txn_usd_amount(t: Transaction, *, eur_to_usd: Rates | None = None) -> Decimal | None:
    """USD cash leg of one transaction at its own date's rate, or ``None``.

    A USD-native row reads ``net_native`` verbatim; a EUR-native row converts at
    the trade-date forward-filled rate. The frozen ``net_usd`` is a fallback only
    (cross-check otherwise); a last resort converts the un-overridden EUR leg.
    """
    derived = derived_usd(t, eur_to_usd)
    if derived is not None:
        return derived
    if t.net_usd is not None:
        return t.net_usd
    eur = _base_eur(t, eur_to_usd)
    if eur is None:
        return None
    rate = _rate(eur_to_usd, t.date)
    return eur * rate if rate is not None else None


def txn_amount(
    t: Transaction,
    currency: str,
    *,
    eur_to_usd: Rates | None = None,
    eur_overrides: Mapping[int, Decimal] | None = None,
) -> Decimal | None:
    """Cash leg of ``t`` in ``currency`` (``EUR`` / ``USD`` / the native one)."""
    target = currency.upper()
    if target == "EUR":
        return txn_eur_amount(t, eur_to_usd=eur_to_usd, eur_overrides=eur_overrides)
    if target == "USD":
        return txn_usd_amount(t, eur_to_usd=eur_to_usd)
    if target == native_currency(t):
        return t.net_native
    return None


def sum_amounts(
    txns: Iterable[Transaction],
    kinds: Iterable[str],
    currency: str,
    *,
    eur_to_usd: Rates | None = None,
    eur_overrides: Mapping[int, Decimal] | None = None,
) -> Decimal:
    """Signed sum of the legs of ``txns`` of the given ``kinds``; unknown legs skipped."""
    wanted = set(kinds)
    total = ZERO
    for t in txns:
        if t.kind not in wanted:
            continue
        amt = txn_amount(t, currency, eur_to_usd=eur_to_usd, eur_overrides=eur_overrides)
        if amt is not None:
            total += amt
    return total


def build_portfolio_cashflows(
    transactions: Sequence[Transaction],
    *,
    currency: str = "EUR",
    retained_cash_account_ids: set[int] | frozenset[int] = frozenset(),
    eur_to_usd: Rates | None = None,
    eur_overrides: Mapping[int, Decimal] | None = None,
) -> list[Cashflow]:
    """Signed cashflow stream XIRR needs, in one currency.

    Sign convention (matches :mod:`investment_dashboard.domain.returns`):
        * ``deposit`` / ``transfer_in`` => negative (money in from outside).
        * ``withdrawal`` / ``transfer_out`` => positive (money out).
        * ``dividend_cash`` / ``interest`` => positive when the cash is not
          retained in an account included in terminal portfolio value.
        * ``buy`` / ``sell`` / ``dividend_reinvest`` are *internal* and never
          enter the portfolio-level stream.

    Rows whose leg cannot be derived (see module docstring) are omitted.
    """
    eur, usd = _build(
        transactions,
        want_eur=currency.upper() == "EUR",
        want_usd=currency.upper() == "USD",
        retained_cash_account_ids=retained_cash_account_ids,
        eur_to_usd=eur_to_usd,
        eur_overrides=eur_overrides,
    )
    return eur if currency.upper() == "EUR" else usd


def build_portfolio_cashflows_dual(
    transactions: Sequence[Transaction],
    *,
    retained_cash_account_ids: set[int] | frozenset[int] = frozenset(),
    eur_to_usd: Rates | None = None,
    eur_overrides: Mapping[int, Decimal] | None = None,
) -> tuple[list[Cashflow], list[Cashflow]]:
    """EUR and USD portfolio cashflow streams in a single ledger pass."""
    return _build(
        transactions,
        want_eur=True,
        want_usd=True,
        retained_cash_account_ids=retained_cash_account_ids,
        eur_to_usd=eur_to_usd,
        eur_overrides=eur_overrides,
    )


def _build(
    transactions: Sequence[Transaction],
    *,
    want_eur: bool,
    want_usd: bool,
    retained_cash_account_ids: set[int] | frozenset[int],
    eur_to_usd: Rates | None,
    eur_overrides: Mapping[int, Decimal] | None,
) -> tuple[list[Cashflow], list[Cashflow]]:
    eur_flows: list[Cashflow] = []
    usd_flows: list[Cashflow] = []
    for t in transactions:
        kind = t.kind
        if kind in EXTERNAL_FLOW_KINDS:
            sign = Decimal(-1)  # deposit: amount>0 => outflow; withdrawal: amount<0 => inflow
        elif kind in DISTRIBUTION_KINDS and t.account_id not in retained_cash_account_ids:
            sign = Decimal(1)
        else:
            continue
        if want_eur:
            e = txn_eur_amount(t, eur_to_usd=eur_to_usd, eur_overrides=eur_overrides)
            if e is not None:
                eur_flows.append(Cashflow(date=t.date, amount=sign * e))
        if want_usd:
            u = txn_usd_amount(t, eur_to_usd=eur_to_usd)
            if u is not None:
                usd_flows.append(Cashflow(date=t.date, amount=sign * u))
    return eur_flows, usd_flows
