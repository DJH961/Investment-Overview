"""The broker cash pool: which euros paid for every dollar (7.4 contract section 3).

Pure: no I/O, no ORM rows. One pass over plain events (date, rank, id order) keeps a
first-in-first-out queue of :class:`PoolLot` per account. Every lot is native money of
its account currency (generic: ``ccy`` is whatever the account holds) and carries the
euros behind it:

* ``orig_eur``: the original euros that bought those units (a conversion's all-in
  cost, or the ECB fallback);
* ``market_eur``: market or income EUR realised into those units (a dividend, a sale's
  gain or loss); the lot's book cost is ``orig_eur + market_eur``;
* ``origins``: where the original euros came from, pro-rated with the amount, so a
  trail (lot -> deposit -> conversion slices) is derived, never stored.

Rates: ``ecb_rate(ccy, day)`` returns units of ``ccy`` per 1 EUR on ``day`` (the
``fx_history`` convention, USD per EUR for dollars), or ``None`` when there is none.

Owner rule 2026-11-25: on a sale the original units keep their EUR cost; only the
gain (or loss) enters at the sale date's rate, as ``market_eur``. Realised currency
exists only on a conversion back to EUR (see :mod:`domain.cash_out`).

Decimal only. Whole-lot draws move the lot's EUR exactly (no rounding residue).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Literal

ZERO = Decimal(0)

#: The pool outside the broker (the owner's own currency account).
OUTSIDE_ACCOUNT = "usd_account"

SourceKind = Literal["deposit", "sale", "income", "fallback", "withdrawal"]

EventKind = Literal[
    "deposit",
    "withdrawal",
    "buy",
    "sell",
    "dividend_cash",
    "dividend_reinvest",
    "interest",
    "fee",
    "transfer_in",
    "transfer_out",
    "split",
]

EcbRate = Callable[[str, date], Decimal | None]


# --------------------------------------------------------------------------- types


@dataclass(frozen=True)
class Origin:
    """Where a unit's euros came from."""

    #: ``None`` = ECB fallback, income or gain.
    conversion_id: int | None
    #: The day the euros left: the conversion date, or the fallback event's date;
    #: ``None`` for income and gain (no euros left).
    conv_date: date | None
    #: Original euros (0 for income and gain units).
    eur: Decimal


@dataclass(frozen=True)
class PoolLot:
    #: Stable: ``f"{source_kind}:{txn_or_conv_id}:{n}"`` (a piece moved by a paired
    #: transfer keeps its id and appends ``":t{transfer_out_id}"``).
    lot_id: str
    #: Broker account id as ``str``, or :data:`OUTSIDE_ACCOUNT`.
    account_key: str
    ccy: str
    opened: date
    #: Native units left.
    amount: Decimal
    orig_eur: Decimal
    market_eur: Decimal
    origins: tuple[Origin, ...]
    source_kind: SourceKind
    source_txn_id: int | None
    #: True when some of it is an ECB fallback.
    flagged: bool

    @property
    def book_eur(self) -> Decimal:
        return self.orig_eur + self.market_eur


@dataclass(frozen=True)
class Draw:
    """One consumption of one lot by one event."""

    #: Buy / fee / withdrawal / transfer txn id, or the conversion id of a conversion
    #: back (those draws are also listed in :attr:`PoolState.conversions_back`).
    event_txn_id: int | None
    #: A lot id, or a virtual source: ``uncovered:{event}:0`` (ECB fallback for units
    #: no lot covered) or ``kept:{conversion_id}:0`` (units a conversion left in the
    #: outside account, taken by a conversion back).
    lot_id: str
    amount: Decimal
    orig_eur: Decimal
    market_eur: Decimal
    origins: tuple[Origin, ...]
    flagged: bool = False

    @property
    def book_eur(self) -> Decimal:
        return self.orig_eur + self.market_eur


@dataclass(frozen=True)
class HoldingCost:
    """Per (account, instrument), average cost like ``ledger_walk``."""

    shares: Decimal
    cost_native: Decimal
    book_eur: Decimal
    orig_eur: Decimal
    origins: tuple[Origin, ...]


@dataclass(frozen=True)
class PoolState:
    #: What is left, both pools (broker accounts and the outside account).
    lots: tuple[PoolLot, ...]
    #: Every consumption, for trails.
    draws: tuple[Draw, ...]
    holdings: Mapping[tuple[int, int], HoldingCost]
    #: Buy txn id -> book EUR (feeds ``_legs``).
    buy_cost_eur: Mapping[int, Decimal]
    #: Sell txn id -> market EUR realised (the gain or loss at the sale date's rate).
    sale_market_eur: Mapping[int, Decimal]
    #: Book EUR of units spent on fees.
    fees_eur: Decimal
    #: Txn ids that fell back to ECB (conversions back flag their draws instead).
    uncovered: tuple[int, ...]
    #: Conversion-back id -> its draws (input to :func:`domain.cash_out.cash_out`).
    conversions_back: Mapping[int, tuple[Draw, ...]] = field(default_factory=dict)


# -------------------------------------------------------------------------- events


@dataclass(frozen=True)
class TxnEvent:
    """One ledger transaction, as plain data (the service layer builds these).

    ``amount`` is the cash moved, positive (``abs(net_native)``); for a reinvested
    dividend it is ``quantity x price``. ``quantity`` is positive shares bought, sold or
    reinvested (a split's added shares may be negative). Pass only the
    ``dividend_reinvest`` leg of a reinvested dividend, never its paired cash leg
    (``domain.dividends.reinvest_keys``), exactly as ``ledger_walk`` leaves it out.
    """

    id: int
    date: date
    kind: EventKind
    account_id: int
    ccy: str
    amount: Decimal
    instrument_id: int | None = None
    quantity: Decimal = ZERO
    #: A deposit received in ``ccy`` directly (no conversion).
    no_conversion: bool = False
    #: The other leg of a paired transfer.
    pair_id: int | None = None


@dataclass(frozen=True)
class ConversionBack:
    """A conversion from ``from_ccy`` back to EUR, out of the outside account."""

    id: int
    date: date
    from_ccy: str
    sent: Decimal
    eur_received: Decimal
    fees_eur: Decimal = ZERO


Event = TxnEvent | ConversionBack
