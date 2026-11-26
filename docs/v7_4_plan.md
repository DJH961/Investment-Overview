# 7.4 — "Follow your dollars": the currency journey, finished

## Context

7.3.1 is out. The owner is taking a few weeks off after 7.4 and skipping 7.5 (tax) for now, so 7.4 has to finish the whole currency story and be safe to leave running unattended.

The pieces exist but are spread across four pages and nothing joins them:
- Conversions page: matching chips, the pool track (`KeptSplit`), pins, duplicate, recurring plans.
- Transactions: `RateChip` → `RateSheet` ("How this deposit was converted").
- Currency page: Impact (with 7.3.1's `carry` = waiting + conversion cost), Exposure, Scenarios, Conversions.
- Overview: the `CurrencyLifetime` card.

The money maths stops at the deposit. `fx_pool.match_deposits` gives each USD deposit its real EUR cost, but:
- buys, per-holding EUR cost, EUR XIRR and tranches still use the ECB rate of the buy date (`ledger_walk` via `overview_query._legs`, `build_instrument_cashflows`);
- the Transactions EUR column still reads the frozen `net_eur` legs (`ledger_query._to_record`);
- nothing values the dollars that wait (the pool `remaining`, broker cash), and nothing handles USD→EUR.

The plan's §5.1 / push 8 is the starting point. It improves on that in three ways:
1. **One journey model.** The journey is traced on the server once, and every page reads it.
2. **One identity that ties the lifetime figures together.**
3. **One UI pattern, the "money trail".** It shows the journey where the owner meets it: on a transaction, a conversion, a tranche, and as a summary on the Currency page.

## The journey (the owner's real flow, memory `owner-money-journey`)

Each step adds something the app can now measure:
- **€ in Revolut → conversion.** Your rate, plus the cost against the ECB rate (`fx_spread`).
- **$ waiting in the USD account.** `kept_usd` and idle dollars. The rate move while they wait is 7.3.1's waiting carry.
- **Deposit to the broker.** It lands in the MMF. Matched slices come from `fx_pool`.
- **Weekly buys.** These are new: the dollars come out of the broker's cash pool, oldest first, at their EUR cost.
- **Holding.** Value now in EUR against the pool EUR cost. The currency part is unrealised.
- **Sell (owner decision 2026-11-25, replaces plan §5.1).** Proceeds keep their original cost. The sold shares' dollars go back into the pool with the **pool EUR cost they were bought with**. Only the gain dollars, which never cost euros, enter at the sell date's rate. So the currency move on your original dollars is realised only when you convert back to euros. The holding's realised EUR gain is its market part. Golden values cover a sale at a gain and a sale at a loss: a loss means fewer dollars come back, each still carrying its share of the EUR cost.
- **Dividends, interest.** They go into the pool at their own date's rate.
- **Cashing out, the final step (owner, 2026-11-25).** Sell, withdraw from the broker to the USD account, then convert USD → EUR back into Revolut. Each step carries the EUR cost forward:
  - the **withdrawal** moves its lots from the broker pool back to the USD-account pool, cost unchanged;
  - the **conversion back** takes those lots (FIFO, or pinned to a withdrawal, reusing the 7.3 pins);
  - the euros received are measured against the EUR that originally bought those dollars.

  That gives the **real, realised euro return**: euros back, EUR cost of those dollars, realised EUR gain, split into market + currency + conversion cost (both directions, from `fx_spread`), plus a money-weighted EUR return for the cash-out. The server computes the return from the original EUR flows and the EUR received, never from a USD return times a rate.
- **USD → EUR conversion.** It takes dollars out of the pool at their EUR cost. EUR received minus that cost is the realised FX.

## Money maths (backend), one change at a time, golden values checked by the owner

1. **P19 first: frozen legs off.** Move the remaining readers to `net_native` plus that date's FX:
   - `ledger_query._to_record`, `readmodels/transactions.py`;
   - the fallbacks in `cashflows._base_eur` and `txn_usd_amount`;
   - `diagnostics_service` and `transactions_repo`.

   Then stop the writers (importer, import_update, recurring, transaction_edit, make_fixtures). Snapshot EUR columns become nullable in migration **0029** (down to `c4e8a2f6b0d7`, with a working downgrade). Golden test: no figure moves.

2. **`domain/cash_pool.py`** (pure, generic by account currency, C1). A FIFO queue of lots `(amount, cost_eur, source)` per account, driven by `ledger_walk`, using the §5.1 rules:
   - deposits add their `fx_pool` slices;
   - buys and fees consume lots;
   - sells give back the sold shares' EUR cost, and only the gain dollars come in at the sell date's rate (owner rule, above);
   - dividends and interest add lots at their own date's rate;
   - MMF sweeps are neutral;
   - a reinvested dividend adds a lot and spends it the same day;
   - an uncovered buy falls back to the ECB rate and is flagged.

   Each consumption records its **source chain** (lot → deposit → conversion slices), so a trail is derived, never stored.

   Tests:
   - Property: dollars are conserved, EUR is conserved, and the result does not depend on input order.
   - Golden: two deposits, three buys, one sell, one USD→EUR conversion, worked by hand. **The owner checks these before step 3.**

3. **Wire it.** The buy EUR leg comes from the pool. That covers `_legs`, `build_instrument_cashflows`, tranche `cost_eur` and the Transactions EUR column for deposits and buys.
   - Setting `fx.holding_cost_basis = pool | buy_date` (default `pool`) in a new **Currency** settings section. `fx.tracked_quotes` and `fx.stale_after_seconds` move there too, as visible settings (memory `settings-visible`).
   - Invariant tests:
     - Overview = Deposits = Σ Transactions deposits in EUR invested;
     - holdings' EUR cost + pool EUR = EUR invested − realised EUR cost.

4. **USD→EUR direction and the cash-out.** Use the existing `from_ccy`/`to_ccy` columns, so no migration is needed for direction. `fx_pool` skips these rows. `cash_pool` handles both steps:
   - broker withdrawals move lots to the USD-account pool;
   - conversions back take lots out and give the realised euro result.

   A pin from a conversion back to a withdrawal reuses `fx_conversion_pins` (check that the table allows this direction; if it doesn't, the change goes into migration 0029). `domain/cash_out.py` (pure) works out, per conversion back: euros received, EUR cost, realised gain split (market / currency / conversion cost), and the EUR money-weighted return over the original EUR flows of those dollars.

   Golden values: buy, sell at a gain, withdraw, convert back at a different rate. The same again at a loss.

5. **P18 broker cash: moved out of 7.4 (owner, 2026-11-26).** Not part of the currency journey. The shared `ledger_cash_balances` rule and the negative-cash check are built, but the Overview total does not use them. The switch (commit 09d26368) ships in a later release.

6. **Journey read model.** `readmodels/currency_journey.py` works in buckets. Each bucket (USD account pool, broker cash, each holding, gone back to euros) has: USD now, EUR cost, EUR now.

   The **stage bridge** for lifetime currency is: conversion cost + waiting + broker cash (sale proceeds included, at their carried cost) + holdings (unrealised) + conversions back to euros (realised, the only realised currency figure).

   **Identity:**
   - The stage bridge equals the Overview card's FX gain. The card is rebuilt on these buckets, and "Your rate" becomes the pool blend.
   - Impact, day by day, still differs only by the gap identity decided on 2026-11-21. One sentence plus an info tip say why (a 7.3.1 loose end).

   Endpoints, each added to `subject_for`/`_LABELS`:
   - `GET /api/currency/journey`, using the `/both` + ETag pattern;
   - `GET /api/transactions/{id}/trail`, for a deposit, buy or conversion;
   - tranche EUR fields in `api/schemas/tranches.py`.

## UI: take the owner along the journey (design approved before build)

One new shared component, **`components/MoneyTrail/`**. It is a chain of steps, each with an icon, a label and a figure: € sent → $ received → deposited → bought → worth now (→ back to €).
- Horizontal at 1280 px, vertical at 360/390 px.
- **Aligned rows (owner, 2026-11-25).** Every step has the same four rows: icon, label,
  **bold figure**, detail. Across the steps they line up, so the bold figures sit on one line
  (CSS subgrid, or fixed row tracks).
  - The mockup is good enough as a direction, but its alignment and white space are not
    perfect yet. When building, align the text **and** keep empty lines to a minimum. Empty
    lines often appear only because one box wraps or has an extra line. Fix that at the
    source: shorter wording, a tighter detail line, or moving the extra fact into the sheet
    below the trail. Never pad the other boxes to match.

**Approved mockup decisions (owner, 2026-11-25):**
- The cash-out result card puts **euros beside dollars**: put in, market, currency (euros
  only), conversion cost (euros only), realized, and a year. Under it, one sentence on how far
  the euro result trails or beats the dollar one.
- "Your dollars" has **four stats: USD account · broker cash · invested · your rate**. On
  desktop they run across the full width in one row of four; on phones they sit 2×2. There is
  never an empty tile. "Back in euros" lives in the bridge, not as a fifth tile.
- A compact one-line chip variant.
- Every step has its own icon and label, never colour alone. Pairs go into `tokens.cvd.test.ts`.

It appears where the owner already looks:

| Where | What is added |
|---|---|
| **Transactions** | `RateSheet` gets a trail: a deposit shows downstream ("then bought VTI 6 Oct…"). **Buy rows** get the `RateChip` "Your rate" and an upstream trail ("paid with dollars from 3 Oct deposit ← 12 Sep conversion at 1.0830"). The EUR amount reads from the pool. |
| **Conversions page** | Row expansion "Where these dollars went": deposits → buys → holdings → worth now, plus waiting or idle dollars. The dialog gets a direction switch (EUR→USD / USD→EUR). |
| **Holding page** | Performance `KeyFacts`: "Your rate 1.0812 · ECB on buy days 1.0841", and "FX effect" in pp. **Tranches:** an EUR cost column and a "your rate" sub-line, which taps open the trail. HoldingPeek: one "Your rate" line. |
| **Currency page** | New section **"Your dollars"** in `sections.ts`. It is a stage strip showing where your dollars are now (USD account · broker cash · invested · back in euros), each with EUR cost against EUR now. Then the **stage bridge** "where your currency effect came from", and an idle-dollars `Callout` (> 30 days). The Conversions section links each conversion to its trail. |
| **Cash out (new, guided)** | A "Cash out to euros" flow, like the 3-step Recurring `SetupFlow`: sold (pick the sale or enter it) → withdrawn to the USD account (prefilled) → converted back (USD sent, € received, fees, provider, with the ECB check). It ends on a **result card**: "€X back in euros · cost €Y · realised +€Z (market +€a, currency −€b, conversion −€c) · +n % a year in euros". The trail continues to "back in euros". Entry points: the Conversions page and a sell row's sheet. The Currency page's "Your dollars" gets a **"Back in euros"** bucket with a lifetime realised total once there is a first cash-out; until then it is hidden. |
| **Cash-out everywhere it matters** | It is not only a pool rule. Sale proceeds usually sit in the MMF, so a withdrawal straight out of the MMF must work too; the sweep stays neutral and the lots follow the dollars. The cash-out shows on every summary that counts money in or out:<br>• **Conversions page:** a direction filter (To dollars · Back to euros · All); rows going back to euros with their own icon and label "Back to euros"; a second matching card, "How each conversion back was funded" (withdrawal slices, pins, "rest from the USD account at its cost"); KPI tiles "Back in euros" (€ received) and "Realised in euros"; Duplicate and statement import (Wise/Revolut presets) work in both directions.<br>• **Currency page, Conversions section:** cost and timing split by direction, and per provider in both directions; markers going back to euros on the rate chart, with their own shape.<br>• **Currency page, Impact:** the bridge gains a "Cashed out" line, so start + deposits − cash-outs + market + currency = end still adds up.<br>• **Transactions:** withdrawal and sell rows get the trail chip, showing downstream to "back in euros" once converted.<br>• **Holding page:** a sold tranche shows its realised euro result once its dollars have gone back to euros, and "still in dollars" before that.<br>• **Overview card:** a "Realised in euros" row, only once there has been a cash-out.<br>• **Deposits page and Periods/recap:** a "Cashed out" column or line (€ received at your conversion-back rate), and net invested counts it.<br>• **Data Health:** "N withdrawals not yet converted back" (info, not a warning) and conversions back with no dollars to cover them. |
| **Overview** | The `CurrencyLifetime` card gets a "Your rate" row ("1.0812 · ECB 1.0841", sub-line "conversions cost €X so far"). Break-even switches to your rate and says so. The card-vs-Impact sentence, and a "More on the Currency page →" link. |
| **Holdings** | The FX tile hint "your rate 1.0812". No new tile. |
| **Data Health** | Idle dollars, uncovered buys (ECB fallback), negative broker cash. Each has a fix link. |
| **Tour + glossary** | One tour step, "Follow your dollars". FX terms go into `lib/glossary.ts`: your rate, conversion cost, waiting, realised and unrealised. |

The USD view must look good for a ledger with no EUR holdings (memory `no-eur-holdings`). Any stage with nothing in it is hidden.

## Pulled forward from 7.6 (owner, 2026-11-25)

- **P8 month and year recap.** A card on the first visit of a new month or year, using the Brief's ack. It is always on Periods. It shows contributed, market, currency, dividends and conversion cost, from the existing attribution and `fx_spread`. Its figures equal the Periods page.
- **P10 real euro return.** A new adapter, cache tier and service for euro-area HICP (monthly, ECB or Eurostat), modelled on `services/risk_free_service.py`.
  - Before building, check the series key and the licence with a real call.
  - The server computes the real return from the nominal EUR return and the change in the index over the same months.
  - It shows on Periods and in the recap, labelled "to <month>", because the index is published late.
- **No alert channel** (owner: Data Health only). Two small fixes still go in, so problems are visible when the owner comes back:
  - a backup-age check in Data Health;
  - the end-of-day job no longer shows green when one of its steps failed.
- **Not pulled in:** the Daily Brief conversion line (the Brief only shows up when you have been away), instrument sector/country metadata, the long risk explanations.
- **Loose ends included:**
  - the duplicate FX job;
  - the card-vs-Impact sentence.
- **Loose ends skipped:**
  - `clock.now` routing;
  - holidays in `?at=`.

## Lanes and agents (one orchestrator, one subagent layer, a worktree each, disjoint files)

The orchestrator is the main session, on Opus. It writes `docs/v7_4_contract.md` first. The contract covers:
- the domain types;
- the endpoint shapes;
- the bucket identity;
- the golden ledger;
- the fixture JSON;
- the file ownership table.

The orchestrator alone writes the shared files: CHANGELOG, versions, lockfiles, `openapi.json`, `api-types.ts`, `tokens.scss`, activity labels. Every brief repeats the rules on real data and server access, names the agent's own scratch folder, and limits it to targeted tests (`scripts/test_changed.py`).

| Lane | Agent | Owns | Depends on |
|---|---|---|---|
| **A. P19 frozen legs** | implementer (Opus) | `ledger_query`, `readmodels/transactions.py`, `cashflows` fallbacks, writers, migration 0029. Adds an `eur_amount` resolver hook in `ledger_query` for lane B. | contract |
| **B. Cash pool maths** | implementer (Opus) | `domain/cash_pool.py` and its tests (B1). Then wiring (B2): `ledger_walk`, `overview_query._legs`, `metrics_service.build_instrument_cashflows`, the tranches read model, the settings section, USD→EUR, P18. | B1: contract. B2: owner's golden OK, and lane A merged |
| **C. Journey read models + API** | implementer (Opus) | `readmodels/currency_journey.py`, the trail endpoint, the card rebuild, the Data Health checks | B1 types (stubbed from the contract until B2 lands) |
| **D. Journey UI** | general-purpose (Opus), which can load skills: it uses the **impeccable** skill for design direction, an audit and a critique of its shots before it reports. The orchestrator then runs `impeccable:impeccable-finish-reviewer` on the finished build. | `MoneyTrail`, the Currency "Your dollars" section, the Transactions/Conversions/Holding/Overview/Holdings edits, the tour, the glossary | approved mockups; fixtures from the contract |
| **E. Recap + real return** | implementer (Opus: recap and HICP money maths; golden values checked by the owner) | the HICP adapter/service/cache tier, real return on Periods, `GET /api/recap` and the recap card (Periods + first visit), the backup-age check, the eod honesty fix, the duplicate FX job | contract only (independent of the pool). Recap conversion-cost line: `fx_spread` already exists |
| **Fixtures / types** | implementer-light (Haiku) | fixture regeneration, `export_openapi`, `api-types` | orchestrator calls it at each merge |

## Sessions

1. **Contract and approvals.** The orchestrator writes the contract and the hand-worked golden ledger. It shows `show_widget` mockups of MoneyTrail (phone and desktop), the "Your dollars" section, a buy row's sheet and the tranche EUR column. Lanes A, B1 and E start in parallel. **The owner approves:** the mockups, and the B1 golden values.
2. **Build.** B2 runs after A merges. C and D run in parallel (D against the fixtures). E finishes.
3. **Integrate and release.**
   - Merge order: A → B → C → D → E.
   - Shots at 360/390/1280, EUR and USD, nice data set, with a design critique before the owner sees anything.
   - The owner gives feedback; the same agents fix it.
   - Full vitest, `test:overflow`, CI.
   - A real-ledger invariant script **for the owner to run** (agents never touch real data). It prints only pass/fail and the size of any differences.
   - A before/after table of the per-holding EUR figures.
   - **Release 7.4.0.** Use `DEPLOY_MODE=scheduled` during the sprint (ask at the start), and update the v7_plan status line.

## Verification

- **Backend:**
  - property and golden tests for `cash_pool`;
  - invariant tests (EUR invested is the same across all three pages; holdings + pool = invested − realised; stage bridge = card FX gain);
  - the P19 "nothing moves" golden;
  - a migration round-trip;
  - the guard tests `test_usd_is_native` and rate independence, which must stay green (USD never comes from EUR);
  - `test_currency_page_consistency` extended to the journey section.
- **Recap and real return:** the recap's figures equal the Periods page for the same month. Real return has golden values worked by hand from two index points. The HICP adapter is tested with `respx` and has one `@pytest.mark.network` live test.
- **Cash-out on every summary page:** a fixture ledger with one cash-out (sell → withdrawal from the MMF → conversion back). The Impact bridge, the Deposits page, Periods/recap and the Overview card all agree on € cashed out (an extension of the invariant tests). Shots of each page that shows the cash-out.
- **Cash-out maths:** EUR received − EUR cost = market + currency + conversion cost, exactly. Lifetime realised equals the sum over all cash-outs. Dollars are conserved from the broker through the USD account to the conversion back.
- **Frontend:** typecheck, the CVD pair test, vitest for MoneyTrail and the sheets, and `npm run shots` for every changed view.
- **Rollback:** switching `fx.holding_cost_basis = buy_date` brings back the 7.3.1 per-holding figures (tested).
