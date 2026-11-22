# 7.3 session 1: matching contract

> Written 2026-11-21. Scope from `docs/v7_plan.md` §5.1 "7.3 as settled". This file
> fixes the API shapes so the backend and frontend lanes can run in parallel. It goes
> away (folded into `v7_implementation_notes.md`) when 7.3 ships.

## Schema: migration 0024 (down `f6b2d8a4c913`, re-parented at merge if 7.1/7.2 add one)

All of it is additive. 7.2 reads the existing `FxConversion` columns, so none of them is
renamed.

- `fx_conversions` gains:
  - `from_ccy` String(3) NOT NULL, server default `'EUR'`
  - `to_ccy` String(3) NOT NULL, server default `'USD'`
  - `provider` String(16) NULL, one of `wise`, `revolut`, `other` (CHECK)
- The ORM gets generic synonyms for new code: `amount_sent` for `eur_sent`,
  `amount_received` for `usd_received` and `fees` for `fees_eur`.
- New table `fx_conversion_pins`:
  - `id`
  - `deposit_txn_id` FK `transactions.id` ON DELETE CASCADE
  - `conversion_id` FK `fx_conversions.id` ON DELETE CASCADE
  - `usd` Numeric(18,6), CHECK > 0
  - `created_at`
  - UNIQUE(`deposit_txn_id`, `conversion_id`)
- The downgrade drops both cleanly, and `tests/test_migration_roundtrip.py` stays green.
- 7.3 only allows the pair EUR→USD (matching knows nothing else yet). Any other pair is a
  422.

## Domain: `domain/fx_pool.py`

- `Pin(deposit_id: int, conversion_id: int, usd: Decimal)`.
- `match_deposits(conversions, deposits, ecb_rate, pins: Sequence[Pin] = ())`.
  - **Pins are applied first.** Each valid pin takes its `usd` from its conversion, at that
    conversion's all-in EUR per USD (fees included, pro rata as today).
  - **FIFO then fills each deposit's rest** from the dollars nobody pinned. The rules are as
    today: only conversions dated on or before the deposit, oldest first by (date, id).
  - **A pin is valid** when all of these hold. An invalid pin is ignored and reported in
    `PoolResult.rejected_pins` as `(pin, reason)`:
    - `conversion.date <= deposit.date + 7 days`;
    - the deposit's pins add up to no more than its USD;
    - a conversion's pins add up to no more than its USD.
  - Exact-EUR exhaustion carries over: the last slice of a used-up conversion takes its exact
    remaining EUR.
- `MatchedSlice` gains `pinned: bool`.
- `PoolResult` gains `by_conversion: tuple[ConversionUse, ...]`, where
  `ConversionUse(conversion_id, slices: tuple[ConversionSlice(deposit_id, usd, eur, pinned)], remaining_usd)`.
- `remaining` stays as it is.
- **Property tests (hypothesis):**
  - dollars are conserved: conversions = used + remaining, and deposit = matched + fallback;
  - the result does not depend on input order;
  - `pins=()` gives exactly today's result;
  - a valid pin always appears as a pinned slice of the stated USD;
  - EUR is conserved per conversion.
- **Golden values worked by hand** (see "Golden ledger" below).

## Service fix

`fx_conversion_service._ecb_lookup` uses the settled fixing
(`fx_service.get_settled_rate`), not `get_rates`. A deposit dated today is not priced at the
live spot (B-011 class).

## API (router `api/fx_conversions.py`)

### `GET /api/fx-conversions`

Sorted by date descending, then id descending. Each `FxConversionOut` keeps its existing
fields and adds:

```
from_ccy: str, to_ccy: str, provider: "wise"|"revolut"|"other"|null,
rate: Decimal            # usd_received / eur_sent (== effective_rate, kept for compat)
all_in_rate: Decimal     # usd_received / (eur_sent + fees)
ecb_rate: Decimal|null   # settled fixing ON that date (get_settled_rate_on); null = not published
used_by: [{deposit_id, date, usd, eur, pinned}]   # newest deposit first
remaining_usd: Decimal
```

### `POST` and `PUT /api/fx-conversions[/{id}]`

`FxConversionIn` adds `provider` (optional), plus `from_ccy` and `to_ccy`. Both are optional,
default to EUR and USD, and any other pair is a 422.

### `GET /api/fx-conversions/pool`

The deposits are sorted newest first. Each `DepositMatchOut` keeps its fields and adds:

```
status: "matched" | "partial" | "ecb_only"
slices: [{conversion_id, conversion_date, usd, eur, rate /*all-in*/, pinned}]
fallback_usd, fallback_eur, fallback_rate, fallback_rate_date   # null when status == matched
pinned: bool              # any pin on this deposit
```

It also adds `rejected_pins: [{deposit_id, conversion_id, usd, reason}]`.

### `GET /api/fx-conversions/reference?date=YYYY-MM-DD`

Returns `{date, ecb_rate: Decimal|null, published: bool}`, the settled fixing on exactly that
date, for the form's live "you are 0.23 % under ECB" line. It does no network call.

### `PUT /api/fx-conversions/pins/{deposit_txn_id}`

The body is `{pins: [{conversion_id, usd}]}` and replaces that deposit's pins. Errors:
- 422 when the deposit is not a positive USD contribution;
- 422 when a conversion is dated more than 7 days after the deposit;
- 422 when the deposit is over-pinned.

It returns the deposit's new `DepositMatchOut`.

### `DELETE /api/fx-conversions/pins/{deposit_txn_id}`

Unpins the deposit and returns 204.

The new routes go into `api/activity.py` `_LABELS` (subject `changes`), and the service logs
a `changes.log` line for each pin change. `openapi.json` and
`frontend/src/lib/api-types.ts` are regenerated.

## Frontend

- **Conversions page** (`pages/CurrencyConversions/`), as in plan §5.1 part A:
  - Naming: "12 Mar 2025 · €2,770 → $3,000 · 1.0830", in the app's locale formatters.
  - The table runs newest first. Columns: Date · Sent · Received · Rate · All-in · ECB that
    day · Off % · Fees · Left · Provider · Note. Cost and off % arrive with session 2. Until
    then off % is computed **on the server only**: if it is needed now, add `off_pct` to
    `FxConversionOut`.
  - The row menu has Edit, **Duplicate** (prefilled, date empty) and Delete.
  - Expanding a row shows "Used by N deposits · $X left".
- **Deposit matching** runs newest first. Each status has an icon and a label: ✓ Matched,
  ◐ Partly matched, ⓔ ECB only, 📌 Pinned. Slices name their conversion by date and rate.
  "Add the conversion" stays, and *Use this conversion…* opens a pin dialog. The dialog lists
  candidate conversions up to 7 days after the deposit, with a USD amount per pin. *Unpin* is
  there too.
- **The form** shows the live ECB line from `/reference`, warns on edit "changes how N
  deposits are matched" (N = `used_by.length`), and has a Provider select (Wise · Revolut ·
  Other).
- **The Transactions tab:**
  - USD deposit rows get a chip, "Your rate" (matched or partial) or "ECB" (ecb_only). Its
    data is joined client-side from `useFxPool` by deposit id.
  - Tapping the chip opens a Sheet listing the slices ("Paid for by: 12 Mar conversion,
    €2,770 → $3,000 at 1.0830, fees €4.10 · ECB that day 1.0855"), each linked to the
    Conversions page.
- New status colours or badges go into the CVD pair list (`tokens.cvd.test.ts`). Use BEM and
  tokens only. Check every phone width at 360, 390 and 768, in both themes.

## Golden ledger (pins), checked by hand by the owner

- **Conversions:**
  - **C1:** 2026-01-05, €1,000 → $1,100, fees €2 (all-in €1,002)
  - **C2:** 2026-02-02, €900 → $1,000, fees €0
  - **C3:** 2026-03-09, €1,850 → $2,000, fees €3 (all-in €1,853), dated **after** D2
- **Deposits:**
  - **D1:** 2026-01-10, $800
  - **D2:** 2026-03-06, $1,500
  - **D3:** 2026-03-12, $1,000
- **A pin:** D2 ← C3 for $500. C3 is 3 days after D2, so the pin is valid.
- **Expected matching:**
  - **D1:** FIFO takes C1 $800 → €728.73 (800 × 1002/1100 = 728.727…).
  - **D2:** the pin takes C3 $500 → €463.25 (500 × 1853/2000). FIFO then fills $1,000:
    - C1's rest $300 → €273.27 (C1 is used up: 1002 − 728.73);
    - C2 $700 → €630.00.
    Total €1,366.52, blended 1.0977.
  - **D3:** FIFO takes C2's rest $300 → €270.00 (C2 is used up), then C3's unpinned $700 →
    €648.55 (700 × 1853/2000). Total €918.55.
  - **Left over:** C3 keeps $800 in the pool, worth €741.20.
