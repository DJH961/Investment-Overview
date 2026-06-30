"""Positions service — derive current holdings from the transaction ledger.

Maintains no state of its own; every call rolls up :class:`Transaction`
rows on the fly. v1.1 will introduce a ``snapshots`` cache (spec §4.1).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain import market_hours
from investment_dashboard.domain.money_market import MONEY_MARKET_NAV, is_money_market
from investment_dashboard.models import (
    Account,
    Instrument,
    Transaction,
    TransactionKind,
)
from investment_dashboard.repositories import (
    accounts_repo,
    instrument_overrides_repo,
    instruments_repo,
    transactions_repo,
)
from investment_dashboard.services import fx_service, prices_service
from investment_dashboard.services.instrument_enrichment_service import (
    EffectiveInstrument,
    effective_instrument,
)

ZERO = Decimal(0)
#: Below this residual share count a holding is treated as fully closed, so a
#: dust position left after a sale never raises the zero-value warning.
_MIN_HELD_SHARES = Decimal("0.0000001")


#: Share-count kinds that move the running holding total (a cash dividend does
#: not). Used when projecting share counts forward to a later split date.
_SHARE_MOVING_KINDS = frozenset(
    {
        TransactionKind.BUY.value,
        TransactionKind.SELL.value,
        TransactionKind.DIVIDEND_REINVEST.value,
        TransactionKind.SPLIT.value,
    }
)


def _split_factor_after(shares_at_as_of: Decimal, future_txns: Iterable[Transaction]) -> Decimal:
    """Cumulative split-adjustment factor for splits *after* the as-of date.

    yfinance returns split-adjusted (back-adjusted) closes: after a split it
    rewrites all prior history downward by the split ratio. The ledger, by
    contrast, applies a split as a share-count change only on the split date,
    so a pre-split date would otherwise multiply the *pre-split* share count by
    the *post-split-adjusted* (smaller) price and understate the holding by the
    split ratio (v2.10.1 plan §3).

    To value a past date on the same adjustment basis as the price, scale the
    as-of share count by the product of each later split's ratio
    (``shares_after / shares_before``). ``future_txns`` must be the holding's
    transactions strictly after the as-of date, ordered by date then id.
    """
    running = shares_at_as_of
    factor = Decimal(1)
    for t in future_txns:
        if t.kind not in _SHARE_MOVING_KINDS:
            continue
        qty = t.quantity or ZERO
        if t.kind == TransactionKind.SPLIT.value and running > ZERO:
            factor *= (running + qty) / running
        running += qty
    return factor


@dataclass(frozen=True)
class Position:
    """Snapshot of one (account, instrument) holding as of a date."""

    account: Account
    instrument: Instrument
    shares: Decimal
    cost_basis_native: Decimal
    current_price_native: Decimal | None
    current_value_native: Decimal
    current_value_eur: Decimal
    cumulative_dividends_cash_native: Decimal
    #: User-tier annotations composed from the config-tier
    #: ``instrument_overrides`` table. Default to "no category" / "active".
    category: str | None = None
    instrument_active: bool = True
    #: True when the holding has a non-trivial share count but its EUR value is
    #: unavailable — either because no *price* could be sourced (e.g. a ticker
    #: that stopped pricing) or because no EUR↔native *FX rate* was available to
    #: convert a non-EUR holding. A zero/blank value on a held position is not
    #: normal — every figure derived from it (totals, growth, allocation) is
    #: understated — so the UI raises a visible warning. We never paper over a
    #: missing rate by relabelling the native amount as EUR at par (1:1).
    #: Money-market funds price at par and never trip this.
    value_warning: bool = False
    #: Override-merged view of the instrument. Read paths should prefer
    #: ``effective.name`` / ``effective.asset_class`` /
    #: ``effective.expense_ratio`` over the ledger row, so phase-(b)
    #: user corrections show up consistently in tables, treemaps, and
    #: analytics. ``None`` only on the pre-v2.2 in-memory paths that
    #: build a ``Position`` directly without an effective view.
    effective: EffectiveInstrument | None = None


def compute_positions(  # noqa: PLR0912, PLR0915
    session: Session,
    *,
    as_of: date | None = None,
    transactions: Sequence[Transaction] | None = None,
) -> list[Position]:
    """Return one :class:`Position` per non-zero (account, instrument) pair.

    Cash-account holdings (Savings) appear with ``shares = 1`` and
    ``current_value = current_price`` (the price column stores the daily
    balance, per spec §4.1 ``price_history``).

    When ``transactions`` is supplied (already ordered date-asc, id-asc) the
    ledger roll-up reuses it instead of re-querying the database — callers that
    have already loaded the ledger (e.g. the overview's year-start valuation)
    can avoid a second full walk. The list is filtered to ``date <= as_of`` so
    a superset (loaded for a later ``as_of``) yields exactly the same rows the
    scoped query would.
    """
    as_of = as_of or date.today()
    is_historical = as_of < market_hours.exchange_today()
    if transactions is None:
        txns: Sequence[Transaction] = transactions_repo.list_transactions(session, end=as_of)
    else:
        txns = [t for t in transactions if t.date <= as_of]

    # Cash dividends that were immediately reinvested arrive as a pair of
    # ledger rows (DIVIDEND_CASH + DIVIDEND_REINVEST, same instrument & date).
    # The reinvested shares already raise both the share count and the cost
    # basis, so counting the cash leg as income too would double-count it in
    # the capital gain (spec §6.1, returns.capital_gain). Track which
    # (account, instrument, date) keys carry a reinvestment so the matching
    # cash leg can be skipped.
    reinvest_keys: set[tuple[int, int | None, date]] = {
        (t.account_id, t.instrument_id, t.date)
        for t in txns
        if t.kind == TransactionKind.DIVIDEND_REINVEST.value
    }

    accounts_by_id = {a.id: a for a in accounts_repo.list_accounts(session)}
    instruments_by_id = {i.id: i for i in instruments_repo.list_instruments(session)}
    overrides = instrument_overrides_repo.get_override_map(session, instruments_by_id.keys())

    # Money-market / settlement funds (VMFXX, SPAXX …) price at a constant $1.00
    # NAV, so every buy and reinvested dividend is at par. Their *only* return is
    # the dividend itself, which the importer books as a ``dividend_reinvest``
    # (see adapters/vanguard/settlement.py). Folding that into the cost basis like
    # a normal fund makes cost == value and the gain/growth collapse to zero
    # (user report). Excluding it from these funds' cost basis surfaces the
    # accumulated dividends as the holding's gain instead.
    mm_instrument_ids = {
        iid
        for iid, instr in instruments_by_id.items()
        if is_money_market(
            instr.symbol,
            asset_class=(eff := effective_instrument(instr, overrides.get(iid))).asset_class,
            name=eff.name,
        )
    }

    # Aggregate by (account_id, instrument_id).
    holdings: dict[tuple[int, int | None], dict[str, Decimal]] = {}
    for t in txns:
        key = (t.account_id, t.instrument_id)
        agg = holdings.setdefault(
            key,
            {"shares": ZERO, "cost_basis": ZERO, "dividends_cash": ZERO},
        )
        kind = t.kind
        qty = t.quantity or ZERO
        net = t.net_native or ZERO
        if kind == TransactionKind.BUY.value:
            agg["shares"] += qty
            agg["cost_basis"] += -net  # buy net is negative ⇒ cost positive
        elif kind == TransactionKind.SELL.value:
            # Average-cost method: a partial sale releases a proportional
            # slice of the cost basis, otherwise the remaining shares keep
            # the *full* original basis and growth is massively deflated
            # (spec §6.5). ``qty`` is already negative for sells.
            shares_before = agg["shares"]
            if shares_before > ZERO:
                avg_cost = agg["cost_basis"] / shares_before
                # qty negative ⇒ this subtracts the sold shares' basis.
                agg["cost_basis"] += avg_cost * qty
                agg["cost_basis"] = max(agg["cost_basis"], ZERO)
            agg["shares"] += qty
        elif kind == TransactionKind.DIVIDEND_REINVEST.value:
            agg["shares"] += qty
            # Reinvested dividends raise the cost basis by the reinvestment
            # value (spec §6.1) — except for money-market funds, whose NAV is
            # pinned at par so the reinvested dividend *is* the return. Folding
            # it into their cost basis would cancel cost against value and zero
            # out the gain/growth; leaving it out surfaces the earned dividends.
            if t.price_native is not None and t.instrument_id not in mm_instrument_ids:
                agg["cost_basis"] += qty * t.price_native
        elif kind == TransactionKind.DIVIDEND_CASH.value:
            # Skip the cash leg of a reinvested dividend (already captured by
            # the paired DIVIDEND_REINVEST as new shares + cost basis).
            if (t.account_id, t.instrument_id, t.date) not in reinvest_keys:
                agg["dividends_cash"] += net
        elif kind == TransactionKind.SPLIT.value:
            agg["shares"] += qty

    accounts_by_id = {a.id: a for a in accounts_repo.list_accounts(session)}

    # Split back-adjustment: yfinance closes are adjusted for every split, so a
    # historical date must value the *adjusted* share count. The feed's split
    # history is authoritative (it covers splits that happened after a holding
    # was sold, which never appear as ledger ``split`` rows); when no feed data
    # is cached yet, fall back to the ledger split rows (offline-safe). No
    # splits after ``as_of`` ⇒ factor 1, valuation unchanged.
    split_factors: dict[tuple[int, int | None], Decimal] = {}
    if is_historical:
        future_by_key: dict[tuple[int, int | None], list[Transaction]] = {}
        for t in transactions_repo.list_transactions(session, start=as_of + timedelta(days=1)):
            future_by_key.setdefault((t.account_id, t.instrument_id), []).append(t)
        # One batched feed lookup for every held instrument instead of an N+1
        # per-instrument query. A missing key means "no split data cached"
        # (fall back to ledger rows), matching the singular helper's ``None``.
        split_ids = [iid for (_acct, iid) in holdings if iid is not None]
        feed_factors = prices_service.cumulative_split_factors_after(session, split_ids, as_of)
        for key, agg in holdings.items():
            account_id, instrument_id = key
            if instrument_id is None:
                continue
            factor = feed_factors.get(instrument_id)
            if factor is None:
                future = future_by_key.get(key)
                factor = _split_factor_after(agg["shares"], future) if future else Decimal(1)
            if factor != 1:
                split_factors[key] = factor

    # Batch every held instrument's valuation close in a single query rather
    # than calling ``close_as_of`` / ``latest_close`` once per instrument (B2).
    valued_ids = [
        iid
        for (_acct, iid), agg in holdings.items()
        if iid is not None and not (agg["shares"] == ZERO and agg["cost_basis"] == ZERO)
    ]
    if is_historical:
        closes_by_id = prices_service.closes_as_of(session, valued_ids, as_of)
    else:
        closes_by_id = prices_service.latest_closes(session, valued_ids)

    # Each non-EUR account converts with the EUR→*its own* native currency
    # rate, not a single shared USD rate — a GBP/CHF account must not be
    # divided by the USD rate. Rates are memoised per quote so we
    # hit the FX cache at most once per distinct currency. A missing rate
    # yields ``None`` (value unavailable), never a par 1:1 figure (A2).
    rate_cache: dict[str, Decimal | None] = {}

    def _eur_rate_for(currency: str) -> Decimal | None:
        ccy = currency.upper()
        if ccy == "EUR":
            return Decimal(1)
        if ccy not in rate_cache:
            rate_cache[ccy] = fx_service.get_rate_eur_to_quote(session, as_of, quote=ccy)
        return rate_cache[ccy]

    results: list[Position] = []
    for (account_id, instrument_id), agg in holdings.items():
        if instrument_id is None:
            continue  # cash-only transaction; rolled up by cash service later
        if agg["shares"] == ZERO and agg["cost_basis"] == ZERO:
            continue
        account = accounts_by_id[account_id]
        instr = instruments_by_id[instrument_id]
        eff = effective_instrument(instr, overrides.get(instr.id))
        # Money-market / settlement funds (VMFXX, SPAXX …) hold uninvested
        # cash at a constant $1.00 NAV and have no tradeable price feed. Price
        # them at par so their value reflects the cash balance instead of
        # collapsing to zero (which understated closing values and inflated
        # their growth %).
        if is_money_market(instr.symbol, asset_class=eff.asset_class, name=eff.name):
            current_price: Decimal | None = MONEY_MARKET_NAV
        # Historical valuations must use the close that was in effect on
        # ``as_of`` (forward-filled), not today's price — otherwise YTD/MTD
        # start values and the equity curve are all priced at today's close.
        # For "today" we keep the latest close so intraday refreshes show.
        # Both come from the single batched lookup above.
        else:
            current_price = closes_by_id.get(instr.id)
        current_value_native = agg["shares"] * current_price if current_price is not None else ZERO
        # Scale by the cumulative post-as-of split factor so a pre-split date
        # values the adjusted share count against the adjusted close. ``shares``
        # itself stays the real as-of count; only the valuation is adjusted.
        if current_price is not None:
            factor = split_factors.get((account_id, instrument_id))
            if factor is not None:
                current_value_native = agg["shares"] * factor * current_price
        # Currency conversion to EUR using this account's own native rate.
        native_rate = _eur_rate_for(account.native_currency)
        fx_unavailable = False
        if account.native_currency.upper() == "EUR":
            current_value_eur = current_value_native
        elif native_rate is not None and native_rate != 0:
            current_value_eur = current_value_native / native_rate
        else:
            # FX rate missing ⇒ the holding's EUR value is unavailable. Leave it
            # blank (ZERO) and flag it, rather than relabel the native amount as
            # EUR at par — a par figure silently corrupts totals/growth (A2).
            current_value_eur = ZERO
            fx_unavailable = True
        # A held position (non-trivial shares) that can't be valued in EUR —
        # because no price *or* no FX rate could be sourced — flags a warning so
        # the UI can surface that downstream totals/growth are understated.
        # Money-market funds price at par and never reach a zero value here.
        value_warning = agg["shares"] > _MIN_HELD_SHARES and (
            current_price is None or current_value_native == ZERO or fx_unavailable
        )
        results.append(
            Position(
                account=account,
                instrument=instr,
                shares=agg["shares"],
                cost_basis_native=agg["cost_basis"],
                current_price_native=current_price,
                current_value_native=current_value_native,
                current_value_eur=current_value_eur,
                cumulative_dividends_cash_native=agg["dividends_cash"],
                category=(overrides[instr.id].category if instr.id in overrides else None),
                instrument_active=(overrides[instr.id].active if instr.id in overrides else True),
                value_warning=value_warning,
                effective=eff,
            )
        )
    results.sort(key=lambda p: (p.account.broker, p.instrument.symbol))
    return results


def compute_cash_balance(
    session: Session,
    account_id: int,
    *,
    as_of: date | None = None,
) -> Decimal:
    """Sum every cash-leg transaction in ``account_id`` up to ``as_of``.

    Buys reduce cash (``net_native < 0``), deposits/dividends/interest/
    sells increase it. This is the "cash core" balance — used for the
    Direct savings account, and for showing uninvested cash on the
    brokerage accounts.
    """
    as_of = as_of or date.today()
    txns = transactions_repo.list_transactions(session, account_id=account_id, end=as_of)
    total = ZERO
    for t in txns:
        net = t.net_native or ZERO
        total += net
    return total


def total_portfolio_value(
    session: Session,
    *,
    as_of: date | None = None,
    positions: list[Position] | None = None,
) -> Decimal:
    """Sum of all positions' EUR value + Savings cash balance in EUR.

    ``positions`` may be passed to reuse an already-computed roll-up for the
    same ``as_of`` date (avoids a redundant :func:`compute_positions` pass when
    a caller has already built it).
    """
    as_of = as_of or date.today()
    if positions is None:
        positions = compute_positions(session, as_of=as_of)
    total_eur = sum((p.current_value_eur for p in positions), start=ZERO)

    fx_rate = fx_service.get_rate_eur_to_quote(session, as_of)
    rate_cache: dict[str, Decimal | None] = {"USD": fx_rate}
    for account in accounts_repo.list_accounts(session):
        if account.account_type not in {"savings", "cash"}:
            continue
        balance_native = compute_cash_balance(session, account.id, as_of=as_of)
        ccy = account.native_currency.upper()
        if ccy == "EUR":
            total_eur += balance_native
            continue
        # Convert with this account's own EUR→native rate, not a shared USD one.
        # A missing rate means this balance can't be expressed in EUR, so omit
        # it rather than add a par (1:1) figure that silently overstates the
        # total (A2: FX missing ⇒ value unavailable, never par).
        if ccy not in rate_cache:
            rate_cache[ccy] = fx_service.get_rate_eur_to_quote(session, as_of, quote=ccy)
        rate = rate_cache[ccy]
        if rate is not None and rate != 0:
            total_eur += balance_native / rate
    return total_eur


def _ignored_account_for_typing(_: Transaction) -> None:  # pragma: no cover
    """Touch :class:`Transaction` so the import isn't pruned by linters."""
