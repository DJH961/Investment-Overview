# 7.3 handover (written 2026-11-21, session 1 paused)

Read first: `docs/v7_plan.md` §5.1 "7.3 as settled", then `docs/v7_3_contract.md` (the API
shapes). 7.2's contract with us is on its branch:
`git show origin/claude/currency-page-redesign-v7-060d46:docs/v7_contracts.md`.
Merge order: 7.1 → 7.2 → 7.3. Branch: `claude/v7-plan-7-3-scope-aa7f61`; no PR yet.

## Done (commit cc4b9e94)

- **Migration 0024** `a7c3e9d1b5f2` (down `f6b2d8a4c913`; re-parent onto 7.1/7.2 migrations
  at merge). It adds `fx_conversions.from_ccy`, `to_ccy` and `provider`, plus the
  `fx_conversion_pins` table. Nothing is renamed, because 7.2 reads `eur_sent` and
  `usd_received`.
- **`domain/fx_pool.py`** applies pins first, then FIFO. It has property tests, and the
  golden test matches the contract's hand-worked ledger exactly.
- **Service:** the ECB fallback now uses the settled fixing.
- **API:** pins CRUD, `/reference`, and the pool, list and `off_pct` fields. Activity labels
  are in. `openapi.json` and `api-types.ts` are regenerated.
  - The `off_pct` field was added after the backend lane's test run. It has **no test
    yet**: add one to `tests/api/test_fx_conversions.py`.
- **Frontend:**
  - Conversions page: statuses, the pin dialog, Duplicate, provider, the ECB line and the
    edit warning.
  - Transactions: the "Your rate" / "ECB" chip and its sheet.
  - Typecheck is clean and 823 tests pass.
- **Fixtures:** `make_fixtures.py` seeds 6 conversions, 3 recent deposits and one pin, so
  every status shows.

## Open: the UI review (owner is very critical; send screenshots only after this)

Shots script: `.claude/shots.cjs`.
- Start the dev server with `preview_start frontend-fixtures` (`.claude/launch.json`, port 5191).
- Then, from `frontend/`, set `NODE_PATH` to `frontend/node_modules` and run
  `node ../.claude/shots.cjs <outDir>`.

Findings from round 1, to fix:

1. **The desktop table overflows at 1280** (the actions column is off screen).
   - Replace the "Used by" expander with a compact **Paid for** cell: up to two deposit dates
     linked to `#deposit-<id>` on the same page, "+N more", "· $X left"; or "In the pool"
     when it is unused.
   - Move the Note column under the date, as a muted one-line ellipsis.
   - Add a **vs ECB** column from `off_pct`: "−0.56 %" in neutral text, no pos/neg colour.
2. **ECB that day = null:** show "No fixing" (weekend or holiday, with a tooltip), or
   "Not yet" for today. *Owner question for session 2:* should a weekend conversion's cost
   use the last fixing before its date? (Wise and Revolut convert on weekends.)
3. **The edit form shows "861.730000":** trim trailing zeros when prefilling
   `fromConversion`.
4. **KPIs:**
   - "Pool balance" becomes "In the pool", with the hint "€863 at cost · not yet
     deposited".
   - "Batches" becomes "Conversions", with the total EUR sent as its hint.
   - Add "Deposits on the ECB rate" (the count of `ecb_only` plus `partial` deposits).
   - Rename the card "Conversion batches" to "Conversions".
5. **Phone conversion rows:** today they repeat the "Used by" label and the menu sits on its
   own line. Use separate phone columns:
   - title: date · provider;
   - headline: US$;
   - sub: "€861.73 at 1.1605 · 0.56 % below ECB";
   - sub: the note;
   - inline: Paid for, then actions.
6. **Matching list layout:**
   - Head row: date, US$, status chip right-aligned. A muted line under it: "Your rate
     1.1769".
   - Slice rows: "16/10/2026 · Wise · 1.1762" linked to `#conversion-<id>` (scroll it into
     view; it currently links to `/conversions`, the same page), then "$2,000 for €1,700.37",
     with a pin icon instead of the "(pinned)" text.
   - Actions right-aligned on desktop. "Use this conversion…" becomes "Pin a conversion…".
   - Card title: "How each deposit was paid for". Subtitle: pins first, then oldest first
     (FIFO), then the ECB rate for the rest.
   - Page subtitle: drop the "FIFO" jargon.
7. **Pin dialog:**
   - Each candidate shows "$X free" or "pays the 20/10 deposit" under its name, nearest date
     first.
   - Shorten the description.
   - Check it at 360.
8. **Transactions sheet:**
   - One row per slice: the link "16/10/2026 · Wise" with US$ on the right, then a muted
     line "€1,700.37 at 1.1762 · fees €2.10 · ECB 1.1824".
   - Links go to `/conversions#conversion-<id>`.
9. **Fixture ECB line:** add `/api/fx-conversions/reference?date=2026-06-26` to
   `GET_ENDPOINTS` in `make_fixtures.py`. Fixture mode prefix-matches the query, so the form
   then shows the ECB line in the shots.

Then: re-run the shots at 360/390/768/1024/1280 in both themes, critique every shot, run
`npm run typecheck`, `npm run test` and `npm run test:overflow`, then send the shots to the
owner. After that, the owner checks the pin golden values (contract, "Golden ledger").

## Later sessions (see the plan)

- **Session 2:** `fx_spread.py` costs and the Conversions section on 7.2's Currency page.
- **Session 3:** P15, the P14 recurring plans with est. rows and the stepper settle sheet,
  then the P6 bonus.
