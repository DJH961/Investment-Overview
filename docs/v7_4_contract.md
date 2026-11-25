# 7.4 contract: "Follow your dollars"

> The plan is [`v7_4_plan.md`](v7_4_plan.md) (approved 2026-11-25). This file is the binding
> interface between the lanes. When a lane needs something that differs from this file, it
> tells the orchestrator. It never edits another lane's files.

## 0. Rules every lane follows

- **Real data.** Never search for, open, copy or run code against the owner's real ledger,
  config or cache databases, their backups or exports. Never search the home folder,
  OneDrive, Dropbox or AppData. Use synthetic test ledgers only.
- **Server.** No agent connects to the server (ssh, scp, Tailscale, the server's endpoints
  with credentials).
- **Currency rule** (AGENTS.md).
  - Native amounts are stored; EUR is derived at report time.
  - Never compute a return in one currency and convert it.
  - USD figures never come from EUR (guard tests `test_usd_is_native`, rate independence).
  - `Decimal` all the way through.
- **Shared files belong to the orchestrator:** `CHANGELOG.md`, the version files and
  lockfiles, `backend/openapi.json`, `frontend/src/lib/api-types.ts`, `tokens.scss`, the
  activity labels (`subject_for` / `_LABELS`), and `docs/v7_plan.md`. Lanes list what they
  need in their final report.
- **Tests.** Run targeted tests only (`uv run python ../scripts/test_changed.py` or named
  test files). Full suites run once, at the release.
- **Scratch files** go to the lane's own folder under the session scratchpad, never a shared one.

## 1. Lane ownership

| Lane | Owns (only these) |
|---|---|
| **A. P19 frozen legs** | `readmodels/queries/ledger_query.py`, `readmodels/transactions.py`, `services/cashflows.py` (the `_base_eur` / `txn_usd_amount` fallbacks only), the frozen-leg writers (`importer_service`, `import_update_service`, `recurring_service`, `transaction_edit_service`, `tools/make_fixtures*` leg writes), `services/transaction_fx_service.py`, the `diagnostics_service` `fx_legs` check, `repositories/transactions_repo.py` missing-legs query, migration `0029_v7_frozen_legs_nullable.py`, and their tests |
| **B1. Cash pool domain** | `domain/cash_pool.py`, `domain/cash_out.py`, `tests/domain/test_cash_pool*.py`, `tests/domain/test_cash_out*.py` |
| **B2. Wiring** (later) | `services/ledger_walk.py`, `readmodels/queries/overview_query.py` (`_legs`, instrument metrics), `services/metrics_service.py` (`build_instrument_cashflows`), `readmodels/tranches.py` + `api/schemas/tranches.py`, `services/settings_registry.py` (Currency section), `services/fx_conversion_service.py` (direction), P18 `ledger_cash_balances` |
| **C. Journey read models** (later) | `readmodels/currency_journey.py`, `api/currency_journey.py`, the trail endpoint, the rebuilt `CurrencyLifetime` read model, the new Data Health checks |
| **D. Journey UI** (later) | `components/MoneyTrail/`, `pages/Currency/sections/Dollars/`, the cash-out flow, and the edits listed in the plan's UI table |
| **E. Recap + real return** | `adapters/hicp_client.py` (or `adapters/ecb_hicp.py`), `services/hicp_service.py`, its cache-tier model and repository, the migration **only if** the cache tier needs a table (number it **0030**, re-pointed after 0029), `readmodels/recap.py`, `api/recap.py`, the real-return fields on Periods (`readmodels/periods.py`, `api/schemas/periods.py`), the backup-age check and the end-of-day honesty fix (`services/scheduler.py` eod step results, a `diagnostics_service` check function), the duplicate FX job, the frontend recap card (`components/RecapCard/`) and its Periods slot, and their tests |

`diagnostics_service.py` is touched by A (the `fx_legs` check), C (new checks) and E
(backup age). Each lane adds **its own function** and touches nothing else. The
orchestrator registers the new checks in `check_health` at merge.

## 2. Lane A: P19

- Every EUR/USD figure on a transaction comes from `net_native` plus that date's settled
  rate. That is `cashflows.txn_eur_amount` / `txn_usd_amount` without the frozen-leg
  fallback. For a USD account, USD = `net_native` (native).
- `ledger_query` takes a resolver hook:
  `eur_amount: Callable[[Transaction], Decimal | None] | None = None`. `None` means the
  derived ECB path. Lane B2 passes the pool resolver; A passes the existing
  `eur_overrides` (deposits) now. This fixes the Transactions EUR column for matched
  deposits already in A.
- Writers stop setting `net_eur`, `net_usd` and `fx_rate_to_eur` (they write `NULL`).
- Snapshot EUR columns: `PositionSnapshot.total_value_eur` and
  `IntradayValue.market_value_eur` become nullable. Readers use native USD × the stored
  per-instant `fx_eur_usd` when the EUR column is `NULL`.
- Migration 0029: `down_revision = "c4e8a2f6b0d7"`. It makes the two columns nullable, and
  its downgrade backfills `NULL`s from USD × fx before restoring `NOT NULL`. The
  round-trip test passes.
- **Golden "nothing moves" test.** A seeded ledger produces the same Overview, Deposits,
  Periods and Transactions figures before and after (the diff is empty, except the
  Transactions EUR for matched deposits, which now shows your rate; list those in the test).

## 3. Lane B1: `domain/cash_pool.py` (pure, `mypy --strict`)

### Types

```python
@dataclass(frozen=True)
class Origin:            # where a dollar's euros came from
    conversion_id: int | None   # None = ECB fallback / income / gain
    conv_date: date | None
    eur: Decimal                # original euros (0 for income and gain dollars)

@dataclass(frozen=True)
class PoolLot:
    lot_id: str                 # stable: f"{source_kind}:{txn_or_conv_id}:{n}"
    account_key: str            # broker account id as str, or "usd_account" (outside the broker)
    ccy: str                    # account currency, e.g. "USD" (generic, C1)
    opened: date
    amount: Decimal             # native dollars left
    orig_eur: Decimal           # original euros behind these dollars
    market_eur: Decimal         # market/income EUR realised into these dollars (± )
    origins: tuple[Origin, ...] # pro-rated with amount
    source_kind: Literal["deposit","sale","income","fallback","withdrawal"]
    source_txn_id: int | None
    flagged: bool               # True when some of it is an ECB fallback
    # book cost = orig_eur + market_eur

@dataclass(frozen=True)
class Draw:              # one consumption of one lot by one event
    event_txn_id: int | None    # buy / fee / withdrawal / conversion back
    lot_id: str
    amount: Decimal
    orig_eur: Decimal
    market_eur: Decimal
    origins: tuple[Origin, ...]

@dataclass(frozen=True)
class HoldingCost:       # per (account, instrument), average-cost like ledger_walk
    shares: Decimal
    cost_native: Decimal
    book_eur: Decimal
    orig_eur: Decimal
    origins: tuple[Origin, ...]

@dataclass(frozen=True)
class PoolState:
    lots: tuple[PoolLot, ...]               # what is left, both pools
    draws: tuple[Draw, ...]                 # every consumption, for trails
    holdings: Mapping[tuple[int,int], HoldingCost]
    buy_cost_eur: Mapping[int, Decimal]     # buy txn id -> book EUR (feeds _legs)
    sale_market_eur: Mapping[int, Decimal]  # sell txn id -> market EUR realised
    fees_eur: Decimal                       # book EUR of dollars spent on fees
    uncovered: tuple[int, ...]              # txn ids that fell back to ECB
```

### Inputs

`run(events, deposit_matches, ecb_rate, money_market_ids) -> PoolState`:
- `events` is a sequence of plain event dataclasses (date, id order), never ORM rows. The
  service layer builds them.
- `deposit_matches` is `fx_pool.PoolResult`.

### Rules

| Event | Effect |
|---|---|
| Deposit (USD, broker) | Adds a lot from its `fx_pool` slices (orig = slice EUR, origins = slices). The fallback rest becomes a `flagged` lot at ECB. "Received in USD" deposits enter at ECB with `conversion_id=None`. |
| Buy (non-MMF) | Takes dollars FIFO, oldest `opened` first, in its account. Book EUR goes to `buy_cost_eur[txn]` and the holding. If no lot is left, the rest is ECB on the buy date, `flagged`, and the txn goes to `uncovered`. |
| Sell (non-MMF) | Average cost releases `frac` of the holding's book and orig EUR. The proceeds lot gets `amount` = proceeds, `orig_eur` = released orig, `market_eur = released_book − released_orig + (proceeds − released_cost_native)/ecb(sell date)`. **Owner rule 2026-11-25:** the original dollars keep their cost; only the gain (or loss) is valued at the sell date's rate. |
| Cash dividend, interest (MMF dividends too) | An `income` lot at its own date's ECB rate: orig 0, market = amount/ecb. |
| Reinvested dividend | An income lot, spent the same day on the holding. Net zero dollars, and the holding gets a real EUR cost. |
| MMF buy/sell | Neutral. Lots do not move. |
| Fee | Takes dollars FIFO; their book EUR is added to `fees_eur`. |
| Withdrawal (broker) | Takes dollars FIFO, then re-adds the same draws as `withdrawal` lots in `account_key="usd_account"`, cost unchanged. |
| Conversion back (`from_ccy=USD`, `to_ccy=EUR`) | Takes from `usd_account` lots: pinned withdrawals first (reuse `fx_conversion_pins`, where `deposit_txn_id` holds the withdrawal txn id), then FIFO. Any dollars still missing come from the `fx_pool` remaining batches (kept dollars). If even those are not enough, the rest is uncovered and flagged. |
| Transfer out / in (paired) | Lots move with their cost. If unpaired: out works like a withdrawal, in works like a "Received in USD" deposit. |

### Tests

- **Properties (hypothesis):**
  - dollars are conserved per account;
  - EUR is conserved: `Σ deposits orig + Σ income market + Σ sale market = Σ holdings book + Σ lots book + fees_eur + Σ conversion-back book`;
  - the result does not depend on the order of events on the same date;
  - zero rate moves give a zero currency part.
- **Rollback switch.** `buy_date` mode is not a pool concern; B2 keeps the old `_legs`.

### Golden ledger G1 (worked by hand; the owner checks it)

Rates are chosen for round numbers. "ECB" is the fixing on that date.

| # | Date | Event | Pool after | Holdings after |
|---|---|---|---|---|
| 1 | 1 Jan | C1: €1,000 → $1,250 (rate 1.25) | (USD account) | |
| 2 | 1 Feb | C2: €1,000 → $1,000 (rate 1.00) | | |
| 3 | 5 Jan | D1: deposit $1,250, matched to C1 → €1,000 | L1 $1,250, €1,000 | |
| 4 | 10 Jan | B1: buy 10 X at $50 = $500 | L1 $750, €600 | X 10 sh, $500, book €400 |
| 5 | 5 Feb | D2: deposit $1,000, matched to C2 → €1,000 | L1 $750 €600 · L2 $1,000 €1,000 | |
| 6 | 10 Feb | B2: buy Y $1,000 = $750 from L1 (€600) + $250 from L2 (€250) | L2 $750, €750 | Y $1,000, book €850 |
| 7 | 15 Feb | B3: buy 15 Z at $50 = $750 from L2 | (empty) | Z 15 sh, $750, book €750 |
| 8 | 1 Mar | S1: sell 4 X at $70 = $280. Frac 0.4 releases $200, book €160, orig €160. Gain $80 at ECB 1.25 = €64 | L3 $280, orig €160, market €64, book €224 | X 6 sh, $300, book €240 |
| 9 | 15 Mar | Cash dividend Z $10 at ECB 1.25 | L3 · L4 $10, market €8 | |
| 10 | 1 Apr | W1: withdraw $280, FIFO → all of L3 | broker: L4 $10 €8 · USD account: W-lot $280, book €224 | |
| 11 | 10 Apr | CB1: convert $280 → €198 (ECB 1.40, so $280 = €200 at ECB; fees €0) | broker: L4 $10 €8 | |

**Expected:**
- **`buy_cost_eur`:** B1 €400 · B2 €850 · B3 €750. Under the old ECB-buy-date basis these
  would differ; the fixture's ECB rates set that.
- **Holdings book:** X €240, Y €850, Z €750 = €1,840.
- **Conservation:** €2,000 deposits + €8 income + €64 sale market = €2,072. That equals
  €1,840 holdings + €8 pool + €224 converted back.
- **CB1, the cash-out (`domain/cash_out.py`):**
  - euros received **€198** · original euros **€160** · market **+€64** ·
    currency **−€24** (= $280 at ECB €200 − book €224) · conversion cost **−€2**
    (= €200 at ECB − €198 received, + fees);
  - identity: received − original = market + currency + cost: 198 − 160 = 64 − 24 − 2 = **+€38**;
  - money-weighted EUR return: flows −€160 on 1 Jan (C1's origin date) and +€198 on 10 Apr.
    The test computes it with the app's XIRR and checks it against
    (198/160)^(365/99) − 1 (≈ +119 % a year, only because the window is short).
- **G2 (B1 writes it):** the same, but the sale is at $40 (a loss of $40, at ECB 1.25 = −€32).
  - L3: $160, orig €160, market −€32, book €128.
  - Converted back at ECB 1.40 for €112 received: market −€32, currency $160 at ECB
    (€114.29) − €128 = −€13.71, cost −€2.29.
  - Identity: 112 − 160 = −48.00 = −32 − 13.71 − 2.29.

## 4. `domain/cash_out.py` (B1)

```python
@dataclass(frozen=True)
class CashOut:
    conversion_id: int
    date: date
    usd_sent: Decimal
    eur_received: Decimal
    orig_eur: Decimal
    market_eur: Decimal
    currency_eur: Decimal        # usd_sent / ecb(date) − (orig + market)
    conversion_cost_eur: Decimal # eur_received − usd_sent / ecb(date) − fees_eur  (≤ 0 is a cost)
    realised_eur: Decimal        # eur_received − orig_eur
    xirr_eur: Decimal | None     # origins' (−eur, conv_date) + (+eur_received, date)
    draws: tuple[Draw, ...]
    flagged: bool
```

Identity, tested exactly: `realised_eur == market_eur + currency_eur + conversion_cost_eur`.

## 5. Lane E: recap and real return

- **HICP.** Euro-area HICP, all items, index 2015=100, monthly. First verify the series key
  and the licence with one real call (`@pytest.mark.network`); likely ECB SDW
  `ICP.M.U2.N.000000.4.INX`. Record it in the adapter docstring.
  - Cache-tier storage through its own service, like `risk_free_service`.
  - It is fetched by the end-of-day job at most once a day. Add an activity line (subject
    `prices` or `fx`, whichever fits; tell the orchestrator which).
- **Real return**, for a period from month m0 to m1:
  `real = (1 + nominal_eur_return) / (HICP[m1] / HICP[m0]) − 1`, computed on the server.
  When the index is missing for m1, use the latest month available and set
  `real_to: "2026-10"`.
  - Golden values by hand: nominal +10 %, index 100 → 102: real = 1.10/1.02 − 1 = +7.843 %.
  - Never annualise a monthly figure. The year is chained over months on the server.
- **Recap.** `GET /api/recap?period=YYYY-MM|YYYY` returns: contributed (EUR, with your
  conversion rates), cashed out (EUR received, 0 until lane B2 is in, field present),
  market, currency (from the attribution), dividends, conversion cost (`fx_spread` for
  conversions dated in the period), nominal EUR return, real return and `real_to`.
  - Its figures equal the Periods row for the same period (a test).
  - "First visit of a new month" uses `recap.last_ack` (config row, same as `brief.last_ack_at`), via `POST /api/recap/ack`.
- **Backup age.** A Data Health check `backup_age`: warn after 2 days, error after 7.
- **End-of-day honesty.** The job's status is failed when any step failed, and Data Health
  shows which steps.
- **Duplicate FX job.** Drop the separate per-minute FX fetch when the tick already
  fetched it. Prove it in a test with call counts.
- **Frontend.** `components/RecapCard/` (BEM, tokens only, no colour alone) on Periods
  (always) and on the Overview on the first visit of a new month (dismiss = ack). Shots at
  360/390/1280, nice fixtures, EUR and USD.

## 6. Later lanes (filled in at session 2)

C and D build on B1's types. Their endpoint shapes are written here after the owner
approves the B1 golden values and the mockups:
- `/api/currency/journey`;
- `/api/transactions/{id}/trail`;
- the tranche EUR fields;
- the card rebuild;
- the cash-out flow.
