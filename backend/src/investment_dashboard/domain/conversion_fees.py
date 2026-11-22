"""Split a statement's EUR total into the euros converted and the fee (7.3, Wise import).

Pure: no I/O. A broker statement states the money in three ways; all of them end
in the same three native amounts of a conversion (``eur_sent``, ``fees_eur``,
``usd_received``), where the all-in euro cost is ``eur_sent + fees_eur``.

* **Fee stated** (the EUR-balance statement): the debit is the all-in total, so
  ``eur_sent = total - fee``.
* **Fee hidden** (the USD-balance statement): only the total EUR (from the
  description), the dollars received and the quoted rate are known. The rate applies
  to the euros actually converted, so ``eur_sent = usd / rate`` and the fee is what
  is left of the total, ``fee = total - usd / rate``. It is rounded to the cent (the
  inputs are cent-rounded, so the fee cannot be more exact) and never negative.

Worked example (invented numbers): total 200.00 EUR, 215.73 USD received, rate
1.08465. ``215.73 / 1.08465 = 198.8937``, so the fee is 1.1063 -> 1.11 and
``eur_sent = 198.89``; ``198.89 + 1.11 = 200.00``.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

_ZERO = Decimal(0)
_CENT = Decimal("0.01")


@dataclass(frozen=True)
class ConversionAmounts:
    eur_sent: Decimal
    fees_eur: Decimal
    usd_received: Decimal

    @property
    def eur_total(self) -> Decimal:
        return self.eur_sent + self.fees_eur


def with_stated_fee(*, eur_total: Decimal, fee_eur: Decimal, usd: Decimal) -> ConversionAmounts:
    """The fee is on the statement: the total includes it."""
    fee = max(fee_eur, _ZERO)
    return ConversionAmounts(eur_sent=eur_total - fee, fees_eur=fee, usd_received=usd)


def with_hidden_fee(*, eur_total: Decimal, usd: Decimal, rate: Decimal) -> ConversionAmounts:
    """Only the total, the dollars and the quoted rate are known: the fee is the rest."""
    if rate <= 0:
        raise ValueError("the exchange rate must be positive")
    fee = (eur_total - usd / rate).quantize(_CENT, rounding=ROUND_HALF_UP)
    fee = min(max(fee, _ZERO), eur_total)
    return ConversionAmounts(eur_sent=eur_total - fee, fees_eur=fee, usd_received=usd)
