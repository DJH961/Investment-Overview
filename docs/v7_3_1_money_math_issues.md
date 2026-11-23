# 7.3.1: money-maths issues to fix (written 2026-11-23)

Owner, 2026-11-23: "the whole overview is a bit fucked. There are so many money math
inconsistencies that this needs to go to 7.3.1". 7.3.0 ships without touching these. 7.3.1
starts by collecting every inconsistency the owner sees (screenshots, ranges, views) into this
file, then fixes them together with golden tests.

## 1. Currency Impact: € total and pp gap can point opposite ways (found, not fixed)

Owner's report: Impact said **+€500, "Tailwind"** while the growth impact below read **−9 %**.

**Root cause:** `readmodels/fx_attribution_rows.py` builds the daily rows with EUR flows that
use the **FX-pool overrides**: a matched deposit's euro flow is what its conversion cost. The
book, though, is valued at that day's rate. With these definitions:

- the € currency total `ΣC_t` (book revalued day by day) only starts counting a dollar once it
  is deposited;
- the EUR return chain sees the deposit come in at its conversion cost but grow the book only by
  `usd / r_deposit`. The difference is real money: the rate move while the dollars waited in
  the USD checking account (conversion date → deposit date) plus the conversion spread. It
  lands in the residual **market** part `M_t = ΔE − C_t − F_t` and in the EUR TWR, so it lands
  in the pp gap, but never in `ΣC_t`.

**Example:** convert $1,000 in January at 1.03 (€971). Deposit it in July at 1.17. The book grows
€855 and the flow says €971, so the deposit day shows −€116. That is a currency loss, but it is
counted as market. Do this every month through a falling dollar (2025), and the pp gap drifts
to −9 % while `ΣC_t` stays near zero or positive. The EUR "market" figure is wrong by the same
amount.

**Proposed fix:** inside the attribution, value deposit flows at that day's rate. Then show
the difference as its own labelled lines:

- **"While your dollars waited":** `usd/r_deposit − usd/r_conv_ecb`.
- **"Conversion cost":** `domain/fx_spread.py`.

`book + waiting + cost` is then the € currency figure, and it agrees in direction with the pp
gap. Market goes back to market.

**Golden tests:**
- convert at 1.03, deposit at 1.17;
- a weekend conversion;
- part kept in USD (`kept_usd`);
- an ECB-only deposit (waiting = 0).

Property: the € lines sum to the same total in every range and for every split.

**Not shipped:** the "Mixed" tag (`fix/v7.3-impact-sign`, sha 6714abfe) was merged into
feat/v7.3.0 and **reverted** (d4ad2df2). It only hid the symptom. Its `headline_kind` and its
hypothesis test can be reused once the maths is right, for the genuine timing cases: deposits
after a rate move, which give a small gap of the opposite sign.

## 2. Already known, same family (from the plan, 7.4)

- The Transactions tab EUR column uses ECB rates; the metrics use your conversion rates.
- Per-holding EUR cost uses the ECB rate on each buy date, not the pool rate.
- The Overview currency card (average buy rate) and Impact (day by day) are different
  measures by design. They need one sentence in the UI that says how they relate.

## 3. To collect from the owner before 7.3.1 starts

For each one: the view (EUR/USD), the range, the two figures that contradict each other, and
a screenshot.
