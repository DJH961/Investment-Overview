# v7.0 — the plan

> Written 2026-11-05 against v6.6.0. This is the readable version: what v7
> builds, in what order, and why. The evidence behind it — file references,
> competitor sources, verified API facts and everything that turned out to be
> wrong — lives in [`v7_research.md`](v7_research.md).
>
> Nothing here is committed to code yet. Section 9 lists the handful of
> decisions that are yours to make before the first line is written.

---

## 1. The short version

v6 finished the job it set out to do: one server, one database, one website,
every number computed in one place. The app is correct and it is complete in
the sense that nothing is broken. What it is not yet is **articulate**. It
shows you eighteen pages of accurate figures and leaves the interpretation
entirely to you.

v7 is about closing that gap, in four themes:

| | Theme | What it means |
|---|---|---|
| **A** | **The app tells you what happened** | A briefing when you come back after the market has moved, written in sentences, not just numbers. |
| **B** | **The app answers questions** | An assistant you can ask, and a news tab that explains why something moved. |
| **C** | **The currency story gets its own home** | The one thing this app does that no US competitor does at all. |
| **D** | **The US-tax-resident-abroad story gets finished** | Tax lots, holding periods, wash sales — the things that actually matter when you are taxed in dollars and live in euros. |

Underneath all four: a cleanup pass on the things the UI audit found, and the
instrument metadata work that several features sit on top of.

---

## 2. What the research changed about the plan

Three findings reversed earlier assumptions. They are worth stating up front
because they change what is worth building.

**The currency metrics are already shipped.** An earlier draft of the plan
claimed the backend computed seven currency-effect figures and threw six of
them away, and ranked fixing that as the single highest-value item in v7. That
was wrong.
`components/CurrencyLifetime` already shows every one of them on the Overview
page: current rate, the average rate you bought dollars at, the euro's move
since then labelled tailwind or headwind, the FX share of your return in
percentage points with both legs beside it, FX gain or loss in euros, what
cashing out now would bring home, and the break-even rate. `CurrencyBox` goes
further and splits *today's* currency move into market-hours and overnight
legs. So the Currency page is not a rescue operation — it is genuine new depth
on top of a surface that is already better than the competition's.

**Nobody else separates FX from asset return — confirmed properly this time.**
Fidelity, Schwab, Robinhood and Empower are USD-only in how they compute;
currency never appears as a cause of return. The only products that split it
are Sharesight and Capitally, a small European tool that treats it as its core
pitch. This is the clearest competitive edge the app has, and it is already
half-built.

**"Since you were away" is not an empty niche.** Robinhood ships Cortex
Digests, Schwab ships Portfolio Insights, Delta ships Direct. All three do a
version of the catch-up briefing. It is still the right feature and still the
best-specified one — but the honest claim is "nobody does this for a
two-currency portfolio," not "nobody does this."

One more, in the other direction: **the instrument metadata problem is smaller
than it looked.** `services/instrument_enrichment_service.py` already fetches
per-symbol metadata from yfinance and fills gaps without overwriting anything
you have corrected by hand, and the adapter already reads the sector field — it
just collapses it into a single `category`. Adding sector, industry, country,
domicile, market cap and ISIN is extra fields on an existing dataclass plus
columns and a migration, not a new subsystem.

---

## 3. Theme A — the app tells you what happened

### 3.1 The Daily Brief (v7.0, the headline feature)

**What you see.** You open the app. If the market has opened or closed since
you last looked, a card sits above the hero with a sentence and a number: how
the portfolio moved over the window you were away, which positions drove it,
what the dollar did separately from what your stocks did, and anything that
landed in the ledger while you were gone — a dividend, an import, a split.
Dismiss it and it goes; come back five minutes later and it stays gone.

If nothing happened — you checked twice in one evening, or it is Sunday — you
see nothing at all. No "you're up to date" chrome. The card's value depends
entirely on it being rare.

**Why it works this way.** The trigger is a precise rule rather than a timer:
a briefing is due if and only if a NYSE session boundary — an open or a close —
falls between the last moment you acknowledged a briefing and now. The domain
module already has every primitive this needs, including holidays and Good
Friday. A dozen lines of pure logic answer every edge case: two visits in one
evening, a Friday-to-Monday gap, a holiday, your first ever login.

The weekend is the one exception worth carving out. Friday night to Monday
morning crosses no stock-market boundary, but the currency market reopens on
Sunday evening and your portfolio is denominated in dollars. So if FX reopened
while you were away, you get a single quiet line about the euro and nothing
else.

**The one thing that is genuinely hard.** There is no usable "last seen"
timestamp today. The session table has one, but it is throttled to sixty
seconds and updated by any API call, so a tab left open overnight records "the
tab was open," not "you looked." Worse, logging in deletes the previous
session row, destroying the very timestamp you wanted. The answer is a
dedicated marker in app config, advanced only by an explicit acknowledgement —
never by a page load. That makes it mean "the last time you were *shown* what
happened," which is the only definition that behaves correctly.

**Scope for the first release.** Gaps and single sessions only, where the
existing single-day FX comparison already works. Longer absences get an honest
"four sessions passed" strip with no numbers until the multi-session version is
built. Movers over a multi-day window need shares held *at the start* of the
window, not now, or a position you opened mid-window shows a fake move.

**Deliberately cut:** "moved on no volume versus real news" — no volume is
stored anywhere in the app, so this is a provider field, a column and a
migration, not a display decision. And milestones or new highs, which need a
full-history scan the read path is explicitly built to avoid.

### 3.2 The written summary (v7.1)

The Daily Brief computes everything itself. The model's only job is to turn
those figures into two or three sentences of English. **Numbers from the
server, prose from the model, never the reverse** — the same division the whole
app already runs on.

This is also how Schwab and Robinhood do it, and it is the only arrangement
where a hallucinated number is structurally impossible: the model never
supplies a figure that appears on screen, because the figures are rendered
beside its text from server data.

Generated once after the close by the scheduler, stored by date, served from
cache on every page load. A refresh never costs money. If the model is
unavailable you see yesterday's text clearly marked stale, or nothing at all if
there is none.

---

## 4. Theme B — the app answers questions

### 4.1 How your data is handled (read this before the next two sections)

The old plan carried an elaborate field-by-field allow-list. It is replaced by
one rule that is easier to reason about, easier to test, and matches what you
actually asked for:

> **No currency amount ever leaves the server.**

| Goes to the model | Never goes to the model |
|---|---|
| Which instruments you hold, by name and symbol | Any amount in euros or dollars |
| Returns as percentages — XIRR, total, YTD, MTD, today | Share counts, prices, cost basis |
| Rank order (largest to smallest) | Your total portfolio value, ever |
| Size bucket per holding: core / mid / small | Account names and numbers |
| Risk ratios — Sharpe, beta, volatility, drawdown | Dividend and contribution amounts |
| Dates, counts, period labels | Anything that is a quantity of money |

Rank order and core/mid/small are in because you said they could be — and they
are what makes the difference between a summary that is honest and one that is
mute. A model told only that one holding is up 40% and the portfolio is up 9%
cannot tell whether that is a triumph or a rounding error. Told the holding is
a small position, it can.

A `detail_level` setting controls whether exact weight percentages go too.
Default is off.

Three implementation details carry the rule:

- The payload is **built field by field from scratch** into a frozen structure
  whose fields *are* the entire permitted surface. Never a copy of a read-model
  with fields removed — that is how a new upstream field silently widens the
  payload six months later.
- A test feeds in a holding whose every money field is a recognisable sentinel
  value and asserts that no sentinel appears in the serialised payload **or in
  the rendered prompt string**.
- An outbound check rejects any model output containing a currency symbol
  adjacent to digits, before it reaches the screen.

Two subtler leaks the research found and this design closes: percentages
derived from exact decimal amounts carry low-order digits that help solve for
weights, so everything is rounded to one decimal place at the boundary; and
publishing a full monthly grid for every holding *and* for the portfolio gives
enough simultaneous equations to recover the weights, so per-holding figures
get several horizons but the portfolio figure gets exactly one.

Finally, instrument names and categories are editable by you, which makes them
a prompt-injection surface as well as a privacy one. They are length-capped,
stripped of control characters, and rendered inside a delimited JSON block
rather than interpolated into prose.

**On the OpenRouter side**, three things to set and one to ask about:

1. The account-level training opt-out has **two separate switches, one for paid
   models and one for free models**. Both off.
2. "OpenRouter Use of Inputs/Outputs" offers a 1% discount in exchange for
   using your data for product improvement. Leave it unchecked; the discount on
   a few dollars a month is meaningless.
3. Every request sends `provider: {data_collection: "deny"}`, which restricts
   routing to providers that do not log or train. This is a per-request lever,
   separate from the account setting, and belt-and-braces is the right posture
   here.
4. **Worth asking support in writing:** whether a true zero-data-retention
   agreement is available on a personal pay-as-you-go account, or whether it is
   enterprise-only. The research could not find a ZDR toggle in the dashboard,
   only ZDR as something individual providers offer. The v6 plan's Phase 5 note
   assumed defaulting to ZDR providers was a setting; it appears to be a
   routing consequence instead.

Worth knowing: OpenRouter does not store prompts or responses by default. Its
own retention is opt-in, and the provider-training setting is governed
separately from it — the docs are explicit that opting out of provider training
"has no bearing on OpenRouter's own policies."

### 4.2 The assistant (v7.2)

The v6 plan specified a tool-calling chat assistant. I previously said that
design could not satisfy your privacy constraint and should be downgraded to a
one-shot summariser. With the constraint as you have now described it, **that
was over-cautious and the original design is back on**, with one change: the
tools return the redacted projection, not the raw read-models.

Six or so read-only tools, each a percentage-and-ordering view of something the
app already computes — holdings and their returns, period returns, risk
metrics, allocation drift, currency effect, what happened in a date window. The
model decides which to call. It never sees an amount because no tool can return
one.

Streaming, so you see it think. Rate-limited, because it costs money — and the
app currently has no rate limiting anywhere except login, so that mechanism has
to be built rather than configured. Every call logged with model, token counts,
latency and cost; never the prompt or the completion. A kill switch defaulting
to off, which gates the adapter, the scheduler job, the routes and the card, so
that with it off no key is ever read.

**What it is not allowed to do:** give buy, sell or hold advice. Every product
in the market carries this disclaimer and every one of them means it. The
system prompt forbids recommendation language, and the UI says so once, plainly,
rather than nagging.

### 4.3 The news tab (v7.3)

**Source the articles from a news API; use the model for synthesis, not
search.** The research is clear on this and it saves both money and
embarrassment.

Letting the model search the web for each holding costs a search fee plus full
token cost for it to read and re-summarise results, takes seconds per ticker,
gives no guaranteed per-symbol coverage, and returns citations as spans of
model-authored text rather than a clean list of articles with dates and
sources. A ticker-keyed news API returns structured JSON in milliseconds, with
real attribution you can link to.

So: poll a news API per holding, cache the articles, then make **one model call
per cluster per refresh** to group duplicate coverage across outlets and write
the "what happened and why it matters to this position" line. Web search stays
available as a fallback for a thinly-covered symbol that the API returns
nothing for.

**Do not build this on yfinance's news field.** It has been broken since early
October 2026 — Yahoo retired the endpoint it depends on, and it now returns an
empty list silently rather than erroring. The project already depends on
yfinance for prices; adding a dependency on a dead endpoint is not worth it.

Candidate sources, in order: **Finnhub** (60 requests/minute free, ticker-native,
personal-use licence), **Marketaux** as a sentiment-bearing secondary (100
requests/day free, per-entity sentiment scores), **GDELT** as a free
no-key backstop with broad coverage but keyword rather than ticker matching.
Avoid NewsAPI — commercial use is forbidden on the free tier and article text
is truncated to 200 characters anyway.

**The disclosure you are accepting:** querying news by ticker tells the news
provider which instruments you hold, repeatedly and on a schedule. There is no
technical fix that preserves usefulness — decoy tickers still leak the real set
by intersection over time. What is mitigable: fetch server-side only, so there
is no browser IP or cookie to correlate, and batch every ticker into one query
per run so the timing reveals nothing about when you check. Honest framing: if
you accept the summary at all, you have accepted disclosing the list; news adds
frequency, not a new category.

### 4.4 A fourth use for the model, which pays for itself immediately

Nobody asked for this one, but it is the best value in the AI theme.

Have the model fill in the instrument metadata. A search-capable model is
genuinely good at reference data — sector, industry, country of listing, fund
domicile, accumulating or distributing, ISIN. One pass over your instrument
list writes *suggestions* into the Instruments editor with their provenance
shown, and you confirm or correct them. The accuracy risk disappears because
nothing is applied without you looking at it.

That unblocks sector, country and currency allocation views without you typing
a spreadsheet, which is the only reason that data was ever missing.

### 4.5 Where the model is explicitly not used

Explaining risk metrics. The app has Sharpe, Sortino, Calmar, Ulcer, VaR, CVaR,
skew and kurtosis — deeper than any consumer tracker, and the benchmark
confirms the gap is interpretation, not maths. But the explanations are the
same every time for everyone. Write them once by hand into the existing
glossary and tooltip system. A model call to produce identical text daily is
waste dressed as innovation.

---

## 5. Theme C — the currency page (v7.5)

The Overview already carries the headline FX numbers. The **Currency tab**
(`/currency`, its own sidebar entry) is the one place that shows off
everything the app knows about currency: live, today, lifetime and what your
own conversions did. Every panel below is either already computed or a
read-time join. The only new money maths is realised versus unrealised, plus
the §5.1 modules it reuses.

**Header:** live EUR/USD with its provenance stamp ("Live · 14:32",
"Fri 23:00 close" or "EOD FX"), and a primary link **"Conversions →"**
(`/conversions`) to add or edit. The conversions page links back with
"Currency tab →", so editing stays where it is and analysis stays here.

The page reads top to bottom from *now* to *lifetime* to *your conversions*:

| Panel | State |
|---|---|
| **Now** | |
| Rate now: live spot, as-of stamp, live vs end-of-day, the live-rate health status (6.13 check) | Already computed |
| Today's currency effect on your money: the 6.13 `day_split` currency part, plus the market-hours / overnight legs `CurrencyBox` already has | Already computed |
| 1D / 1W EUR/USD line from the stored per-minute rates, with the session boundaries | Already stored; needs a small read endpoint |
| **Lifetime** | |
| FX versus instruments split of lifetime return, both legs shown | Already computed |
| Where today's rate sits in your own holding period, as a percentile | New pure-domain module |
| FX impact per holding (EUR growth vs USD growth per holding, from the §5.1 pool rate) | Computed per card today; becomes exact with 7.5c |
| FX on cash balances, and idle pool dollars (§5.1) | Computable, needs a definition decision |
| Realised versus unrealised FX effect | **The only genuinely new maths** |
| **Your conversions** (§5.1) | |
| Your real rate vs the ECB average, total fees, spread, total cost, average distance from the ECB rate (EUR-weighted), best and worst | 7.5b `domain/fx_spread.py` |
| EUR/USD history with **your own conversions marked on it** (marker size = amount, shape plus blue/orange = above or below the ECB rate) | Needs a history endpoint, no new storage |
| Cost over time (cumulative) and per year | 7.5b |
| Timing: your rate vs that month's average rate | 7.5b, read-time |
| Cost by provider (if the optional field is used) | 7.5b |
| Conversion pool state, deposits still on the ECB fallback (with "Add the conversion") | Already computed, reuse `GET /fx-conversions/pool` |

Release order inside the tab: Now and Lifetime first (mostly already
computed, so 7.5 can ship them on day one), then the conversions panels as
7.5a–c land. The tab never shows a panel whose data isn't there yet: no
empty "coming soon" boxes.

Ship the cheap panels first and leave realised-versus-unrealised for last. It
is the easiest place in the whole app to break the currency rule: it must be
built from the euro cashflow stream with each leg at its own date's rate, never
from a dollar realised gain multiplied by a rate delta.

Four more hazards worth writing down before anyone starts, because each one
produces a plausible-looking wrong number:

- The FX-versus-instruments split is **not** `eur_return = usd_return × fx_change`.
  The euro leg stays independently computed; the currency effect is a residual.
- FX profit and loss is valid only as a single-instant comparison. Never
  annualise it, never feed it to an XIRR.
- Conversion cost compares each conversion against **its own date's** fixing,
  never one back-dated rate across a batch. Label it "versus ECB daily
  reference", not "versus mid-market" — the ECB publishes a daily fixing, not
  an intraday mid.
- Do not add derived-currency columns to store any of this. It is a read-time
  join, by rule.

**A cheap companion, not gated on anything:** add currency as an allocation
dimension. The field already exists on every instrument, so this is one of the
few allocation breakdowns that needs no metadata work at all — and for a euro
investor holding dollar assets it is the most relevant dimension there is.

Worth borrowing from Portseido while building this: it shows time-weighted and
money-weighted return side by side, framed as "the return your decisions
produced" versus "includes the effect of your contribution timing." That
wording is better than anything currently in the app and the numbers are
already computed.

### 5.1 Conversions, finished (v7.5a–c, before the page)

> Added 2026-11-09 against v6.13.0. Scoped from the code, not from memory:
> `domain/fx_pool.py`, `services/fx_conversion_service.py`,
> `services/cashflows.py`, `readmodels/queries/ledger_query.py`,
> `pages/CurrencyConversions/`.

Matching EUR→USD conversions to USD deposits is one of the app's best ideas:
your real rate replaces the ECB guess. Today it is half-visible. It shows on
the conversions page and quietly feeds the portfolio figures, but nowhere else
can you see *which* conversion paid for *which* deposit, or what converting
has cost you.

**What exists today (checked):**

| | State |
|---|---|
| FIFO matching: each USD deposit uses the oldest conversions dated on or before it; any rest at that day's ECB rate | Works (`fx_pool.match_deposits`) |
| Portfolio figures use the matched EUR cost (XIRR, Invested, YTD/MTD, Periods, Deposits page, graphs, mobile export, benchmark) | Works (`cashflows.eur_overrides_for`) |
| Transactions tab EUR column and month totals | **Not wired** — ECB rate of the deposit date (`ledger_query` uses `derived_eur`) |
| Per-holding EUR cost basis, gain and XIRR | **Not wired** — ECB rate of each *buy* date (`ledger_walk`, `overview_query`) |
| Matching card names conversions as "Conversion #12" (database id) | Unclear |
| Batch "Effective rate" excludes fees; matching includes them | Inconsistent |
| Fees stored per conversion, never summed | No analytics |
| Spread against the ECB fixing | Not computed |
| Duplicate / copy a conversion | Missing |

#### 7.5a — Clear matching (UI + read-model, no new maths)

- **Name conversions by what they are.** A conversion is "12 Mar 2025 ·
  €2,770 → $3,000 · 1.0830", never "#12". The id stays internal.
- **In order, everywhere.** The conversion list and the matching list both run
  newest first, by date, then by entry order for the same day. Same order on
  phone and desktop, and the order stays put after an edit.
- **Every deposit declares how it was paid for**, with a label and an icon
  (never colour alone):
  - *Matched* — fully covered by conversions, listing each slice:
    "$3,000 from 12 Mar (1.0830) + $1,000 from 2 Apr (1.0791)".
  - *Partly matched* — the slices, then "rest $500 at ECB 1.0802 (4 Mar)".
  - *ECB only* — no conversion dated on or before it, with an **"Add the
    conversion"** button that opens the form prefilled (date = deposit date,
    USD = the unmatched amount).
- **Every conversion shows where its dollars went**: "used by 3 deposits ·
  $420 left in the pool", each deposit linked.
- **Transactions tab, deposit details.** Expanding a USD deposit shows its
  matching ("Paid for by: 12 Mar conversion, €2,770 → $3,000 at 1.0830, fees
  €4.10 · ECB that day 1.0855"), linked to the conversion. The conversions
  page links back.
- **Copy and backdate.**
  - A *Duplicate* action opens the form prefilled from a conversion with the
    date left empty, which covers regular monthly transfers.
  - While you type, the form shows that date's ECB rate and your spread
    against it, so a backdated entry can be sanity-checked before you save.
  - Editing warns what moves: "changes how 3 deposits are matched".
- **One rate definition.** Show two rates per conversion: the *rate* (USD
  received / EUR sent) and the *all-in rate* (including fees). Matching keeps
  the all-in rate, as now. Both are labelled.

#### 7.5b — What converting costs you (new pure-domain maths)

New `domain/fx_spread.py`: pure, property-tested, with golden values worked
by hand. Per conversion, against **its own date's** ECB fixing:

- `ecb_eur = usd_received / ecb_rate(date)`: what the dollars would have cost
  at the reference rate.
- `spread_eur = eur_sent − ecb_eur`, then `cost_eur = spread_eur + fees_eur`.
  Positive means you paid more than the reference rate.
- `off_pct = all_in_rate / ecb_rate − 1`, shown as a percentage.

What the page shows:

- **KPI strip:** total fees paid · total spread · total cost (fees + spread) ·
  average distance from the ECB rate, weighted by EUR converted (not a plain
  average of percentages) · best and worst conversion.
- **Cost over time:** cumulative cost in EUR per conversion date, plus a
  per-year table (converted, fees, spread, cost, cost as % of converted).
- **Per row in the table:** ECB that day, off %, fees, cost.
- **Wording:** "versus the ECB daily reference", never "mid-market". The
  fixing is struck at about 14:15 CET, so a conversion done at another hour is
  measured against a rate it never saw. Say so in the info tip, and treat a
  small *negative* cost as normal intraday noise rather than a win.

Currency rule: every figure is a EUR amount at a single instant (one
conversion, one date). Sums of EUR across dates are fine; never annualise
the cost, never feed it to an XIRR. No new columns: it is a read-time join
of `fx_conversions` and `fx_history`.

#### 7.5c — One rate everywhere (money maths, needs a decision)

- **Transactions tab: wire it.** `ledger_query` takes the same
  `eur_overrides` as the metrics, so a matched deposit's EUR column, the
  month totals and the CSV export show what you actually paid. A small
  "your rate" marker distinguishes it from an ECB-valued row. Cheap and
  unambiguous.
- **Invariant tests:** for every ledger, EUR invested on the Overview, the
  Deposits page and the sum of the Transactions tab's deposits must be equal.
  They can drift today.
- **Holding level: the pool rate (decided 2026-11-09, §9 item 8).** Every
  dollar holding's EUR cost is what *its* dollars cost you to convert, not
  the ECB rate of the day it was bought. Holding EUR figures then add up to
  the portfolio's conversion-aware total.

  **How it works: a second FIFO layer**, new pure module `domain/usd_cash_pool.py`
  driven by `ledger_walk`. Each USD account keeps a queue of dollar lots, each
  with its EUR cost:
  - a **deposit** adds a lot at its matched EUR cost (the existing
    `fx_pool` result: conversion slices, plus any ECB-fallback rest);
  - a **buy** takes dollars from the oldest lots, and that EUR becomes the
    buy's `cost_eur` (replacing `usd / ecb(buy date)`);
  - a **sell, a cash dividend or interest** adds a lot valued at *its own
    date's* rate. Proceeds are EUR at that instant (currency rule), not the
    holding's old cost;
  - **fees and withdrawals** take dollars like a buy does; withdrawals end
    the EUR cost they carried;
  - **money-market funds** (`is_money_market`, the cash sweep) are cash, not
    an investment. Buying or selling one moves dollars between the account's
    cash and the fund without consuming or creating lots. Otherwise every
    sweep would re-price the pool;
  - **reinvested dividends** add a lot at their date's rate and spend it on
    the same day (net zero dollars, a real EUR cost basis). This matches the
    6.12.6 cost-basis fix;
  - **no lot left** (a buy before any recorded deposit, or imported history
    that starts mid-way): the uncovered part uses the buy date's ECB rate and
    is flagged, exactly like today's deposit fallback.

  **What it changes.** Per-holding EUR cost basis, unrealised and realised EUR
  gain, EUR XIRR flows and "Euro since buying". USD figures don't move, and
  portfolio-level figures don't move (they already use the deposit-level
  rate).

  **Required with it:**
  - property tests: dollars are conserved per account; EUR cost is conserved
    from deposits to holdings plus remaining cash; the result doesn't depend
    on input order;
  - golden values worked by hand on a two-deposit, three-buy, one-sell
    ledger;
  - an invariant test: the sum of holding EUR cost basis plus the remaining
    pool's EUR equals EUR invested minus realised EUR cost;
  - a parity note: per-holding EUR returns deliberately diverge from v5,
    and `tools/parity_check.py` learns to expect that.

  **Rollback:** a setting `fx.holding_cost_basis = pool | buy_date` (default
  `pool`), shown in Settings in a new "Currency" group. There is none today:
  `fx.tracked_quotes` and `fx.stale_after_seconds` sit in Data refresh and
  would move there with it. That keeps the old basis one switch away
  while the new one earns trust. This is a basis choice, not a hidden knob.

#### Where the central numbers show up (decided)

Each page gets only what serves its question, so neither is crowded. The
Currency tab gets the full story.

| Where | What it gets | What it does not get |
|---|---|---|
| **Overview › "Currency effect (lifetime)" card** (6 rows today) | **One new row, "Your rate":** your real average conversion rate next to the ECB average over the same dates, e.g. "1.0812 · ECB 1.0841", with "conversions cost €X so far" as its sub-line. Break-even and "Euro since buying" switch to your real rate, with a label saying so. The card title links "More on the Currency tab →". | No cost chart, no per-conversion list, no new card |
| **Holdings › KPI strip** (13 tiles today) | No new tile. The existing **"FX EUR/USD"** tile gets the hint "your rate 1.0812". | No cost or fee figures |
| **Holdings › a holding's details** (phone expansion, desktop drawer; where P/L already lives since 6.12.8) | **"Your rate"** (the blended rate of the dollars that bought it, from the pool rate) and **"FX effect"** (its EUR growth minus its USD growth, in pp, the currency effect as a residual) | Nothing new in the table columns or the row chips |
| **Transactions tab** | A deposit's details: which conversion(s) paid for it (7.5a) | — |
| **Currency tab** | Everything: live rate, day and lifetime effects, costs, timing, pool, idle dollars, per-holding FX table (§5) | — |
| **Conversions page** | Editing, matching, duplicate/backdate, statement import, and a link back to the Currency tab | Analytics (they live on the Currency tab) |

#### Extras that make it work across the app

All approved by you (2026-11-09). Picked for value per line of code, cheapest
first:

- **Data Health:** "N deposits valued at the ECB rate (no conversion found)",
  with the prefilled *Add the conversion* action. The fallback badge already
  links to `/diagnostics`; give it a real check to land on.
- **Idle dollars:** pool dollars converted but not yet deposited for more than
  30 days ("$420 converted on 2 Apr, not yet invested"). They carry currency
  exposure you may have forgotten.
- **Overview's currency card uses your rate:** the one "Your rate" row from
  the placement table above, and the break-even rate built from it.
- **Currency tab (§5):** markers for your conversions on the EUR/USD chart.
  Size shows the amount; above/below the ECB line, cost or saving, is shown
  by marker shape plus blue/orange (CVD-safe). Plus a timing panel: your rate
  against that month's average rate, "converted 0.6% better than the month
  average". This replaces research panel #4 rather than duplicating it.
- **Provider (optional field):** Wise / bank / broker on each conversion, then
  cost per provider. Says plainly which one is cheaper.
- **Paste a statement:** import conversions from a Wise or bank CSV through
  the existing flexible importer (a new parser that emits conversions, not
  transactions).
- **Daily Brief line (once 7.5b ships, added to the 7.0 Brief):** "You converted €2,770 this month at 1.0830,
  0.2% under the ECB reference."
- **Exports:** conversions and their matching in the CSV export and the
  phone export.

**Activity log:** conversion edits already log to the `changes` subject
(`fx_conversion_service` is listed there). The new write paths (statement
import, the prefilled add) log there too. The cost report is read-only and
needs no line.

---

## 6. Theme D — finishing the US-taxed-abroad story

You are taxed in the United States and live in Germany. That is why the app
splits dollars and euros, and v7 keeps the split — but it should make the split
*mean* something. The cleanest way to say it:

> **Dollars are the tax truth. Euros are the spending truth.**

Your cost basis, your holding periods and your gains are US-tax facts measured
in dollars. What the portfolio is worth to you in the country you live in is a
euro fact. The app already stores native and converts at report time, which is
exactly the right architecture for this — it just has not been framed this way
in the UI.

**Everything German-tax is struck from the plan.** Vorabpauschale,
Teilfreistellung, Freistellungsauftrag, Sparer-Pauschbetrag and the
Abgeltungsteuer estimator are all out. The earlier draft had a whole section on
them; it is gone.

### 6.1 Tax lots (v7.4, with the deep-dive)

No lot table exists and lots are not needed to *display* a purchase history:
the ledger already has one row per buy, sell, reinvestment and split with date,
quantity, price and fees, indexed by instrument. Per-lot reconstruction is a
pure replay in the domain layer.

The honest catch, which has to be on screen rather than buried: **the app's
entire gain, growth and XIRR stack is average-cost**, applied per account and
never pooled across accounts. Per-lot gains will not sum to the position's
displayed capital gain after any partial sale. So ship it as a **purchase
tranche history** — cost, age, gain against today's price per tranche —
explicitly labelled as a FIFO view while the position's totals use average
cost, and never let a lot number feed an aggregate.

Snowball's answer is worth copying outright: a cost-basis selector that names,
explicitly, which metrics change when you switch method. Don't hide the method;
publish its consequences.

Real FIFO cost basis — the kind you would file with — touches every return
number in the app and needs a full parity run under the money-maths gate. That
is a separate project, and the tranche view is what tells you whether you
actually want it.

**The bug this feature will hit:** splits are recorded as quantity deltas and
the price feed is back-adjusted, which the positions service compensates for
with a cumulative split factor. Each lot's historical price needs the same
treatment or every per-lot gain across a split is wrong by the split ratio.

### 6.2 The US tax pack (v7.7)

Three features that follow once tranches exist:

**Realised gains with holding periods.** Short-term versus long-term is the
single most consequential distinction in US investment tax and the app does not
model it at all today. A sold-position view split by holding period, in dollars,
is both the most useful tax surface and the easiest to get right.

**Wash-sale detection, including the one everybody misses.** Every US broker
flags wash sales *after* the trade. Proactive prevention exists only inside
Schwab's managed robo at a $50k minimum and Empower's at $1M — nothing
self-directed and nothing free. Your ledger has `dividend_reinvest` as a
first-class transaction kind, which means it can see the wash sale that
automatic dividend reinvestment creates inside the thirty-day window. That is
exactly the one a self-directed investor creates without noticing. Catching it
*before* you sell would beat every retail platform checked.

**A sell planner.** "If I sell this many shares now": the gain, split
short-term and long-term, which tranches it comes from, and whether anything in
the window makes it a wash sale. This app is not a broker, so it cannot select
lots at trade time — but it can tell you what to select before you go and do it
elsewhere.

Supporting both: one new column for withholding tax per transaction, which also
unlocks net-of-withholding dividend income.

---

## 7. The cleanup, and what the UI audit found

Audited page by page. The verdict on the design system is better than the page
count suggests: card, empty-state, KPI-tile and table components are used with
identical conventions everywhere, numbers all flow through shared formatters
with no ad-hoc rounding anywhere, and the protan colour rule is respected on
every page sampled, with status always carrying an icon or label rather than
relying on colour.

The problems are specific rather than systemic.

### Ship as patches, before v7 starts

| | What | Why |
|---|---|---|
| 1 | **The 404 page says "Coming soon"** | The catch-all route still renders a v6 build placeholder. Any typo'd URL shows it. Minutes to fix. |
| 2 | **Onboarding is unreachable** | A complete six-step first-run checklist exists and fetches its own endpoint, and nothing routes to it. Wire it behind an empty-portfolio check, or delete it. |
| 3 | **The nav lies about the calculator** | The sidebar labels one page "Projection & calculator", but the actual calculator — amount, currency, fractional shares, allow-sell — is on another page entirely. |
| 4 | **Empty states with no way out** | Two main pages show text-only empty states telling you to go somewhere else, with no button. A third page already does this correctly with a button. |
| 5 | **Hand-rolled tabs** | One admin page builds its own tab bar instead of using the shared segmented control that four other pages use for the identical job. |

### Fold into v7 work as it touches each area

- **Three separate implementations of a holdings row.** Overview, the holdings
  table and the phone list each hand-build the same symbol/weight/value/
  day-move row, and the status pills are copy-pasted between two of them even
  though one already exports a shared component for exactly that. Consolidate
  when the deep-dive work lands.
- **The hero chart is the one chart with no tooltip**, because it hand-builds
  its own SVG instead of using the shared chart component that every other
  chart on the site uses.
- **Two different "actual versus target" bar widgets** on the same page, in two
  visual grammars.
- **Shared components living in page folders** — an account editor imported
  from the settings page into the import page, a passkeys card imported into
  two other pages. Promote them.
- **Phone and desktop information density differ sharply on Holdings** — 18
  columns on desktop, a six-chip summary on the phone, with the detail panel
  rendering twice when you expand a row. The deep-dive rework fixes this.

### The deep-dive rework (v7.4)

Today the "deep dive" is a bottom sheet containing a price chart and an
eleven-row definition list. No route, no tabs, no transactions, no dividends,
no lots, no intraday.

Make it a route. The audit confirmed this is low-friction: the title and tab-bar
logic already prefix-match, per-id data already exists, and reusing the existing
page chunk avoids a new load waterfall. Then add tabs using the segmented
control the rest of the app uses: performance, transactions, dividends, lots.

**1D and 1W per holding need a decision.** Portfolio-level intraday already
exists, but the stored intraday data is a single portfolio-wide aggregate per
instant, not a per-instrument series — so there is nothing on disk to serve a
per-holding intraday chart from. Either fetch on demand per symbol through the
existing adapter, cached per request, or add a per-instrument intraday cache
table. Fetch-on-demand is right for v7. Before building either, check whether
the snapshot reconstruction service already fetches per-instrument bars and
aggregates them away — if it does, this is a small refactor rather than new
plumbing, and that materially changes the estimate.

**Connect the dividend data that already exists.** Per-holding dividend detail
lives on the Activity page, is not filterable to one instrument, and is not
linked from the holding detail. That is a cheap connection nobody has made.

---

## 8. The order of work

Each line ships as its own release, per the release-fast rule. Reorderable —
this is the sequence I would pick, not a dependency graph.

| Release | What | Depends on |
|---|---|---|
| patches | The five cleanup items in §7 | — |
| **7.0** | **Daily Brief**, deterministic: trigger rule, last-seen marker, window return, the card | — |
| **7.1** | **AI foundation**: adapter, settings, kill switch, redaction layer, cost ledger, activity logging — plus the Brief's written summary as its first consumer | 7.0 |
| **7.2** | **Assistant**: redacted tool surface, streaming, rate limiting | 7.1 |
| **7.3** | **News tab**: news API ingestion, clustering, per-holding digests | 7.1 |
| **7.4** | **Holding deep-dive**: route, tabs, 1D/1W, tranche history, per-holding dividends | — |
| 7.5a | **Conversions, clear matching**: names, order, deposit declarations, Transactions details, duplicate/backdate (§5.1) | — |
| 7.5b | **Conversion costs**: `domain/fx_spread.py`, fees / spread / off-rate KPIs, cost over time (§5.1) | 7.5a |
| 7.5c | **One rate everywhere**: Transactions tab on conversion rates; holding EUR cost from the pool rate (`domain/usd_cash_pool.py`); invariant tests; the Overview "Your rate" row and the holding-details rows (§5.1) | 7.5a |
| **7.5** | **Currency tab** (§5): Now + Lifetime panels, header link to Conversions; the conversion panels join as 7.5a–c land | — (conversion panels: 7.5b) |
| **7.6** | **Instrument metadata** + sector/country/currency allocation, with AI-assisted fill | 7.1 for the fill |
| **7.7** | **US tax pack**: realised gains by holding period, wash sales, sell planner | 7.4 |

Running alongside, not blocking: backfill tests for the repositories layer (the
thinnest non-trivial package, and the layer where bugs go silent), smoke tests
for the nine untested UI primitives and the transaction form, and a coverage
tool, which is currently not installed at all.

**Still gated on your approval, unchanged from v6:** the cutover deletion of
roughly 90,000 lines of v5 code, which needs a parallel-run week first.

---

## 9. What only you can decide

1. **Detail level for the model** — rank order and core/mid/small buckets by
   default, as described in §4.1. Exact weight percentages are a setting,
   default off. Confirm that split is where you want it.
2. **The tool-calling assistant is back on** (§4.2). I previously recommended
   against it on privacy grounds and have reversed that. It means
   `v6_one_app_plan.md` Phase 5 stands rather than being amended.
3. **News discloses your holdings list to a news provider on a schedule**
   (§4.3). Accept, or skip the news tab.
4. **Ask OpenRouter about zero-data-retention** (§4.1, item 4) before the first
   real call. This is the one open question I would not ship without.
5. **Tranche history or real FIFO cost basis** (§6.1). Tranche history is
   cheap and cosmetic; real FIFO touches every return number in the app.
   Recommended: tranche history, clearly labelled.
6. **Onboarding — wire it in or delete it** (§7). It is finished code either
   way; leaving it orphaned is the only bad option.
7. **Cutover timing** for the v5 deletion.
8. ~~**Holding-level EUR cost from your conversions**~~ — **decided
   2026-11-09: the pool rate** (§5.1, 7.5c), with `fx.holding_cost_basis` as
   the rollback switch.
9. **Manual pinning** (§5.1): FIFO only (today), or also let a deposit be pinned
   to a specific conversion. Pinning needs a small link table (a relation, not
   a derived-currency column, so the currency rule allows it).
10. **Matching window** (§5.1): today a conversion must be dated on or before
    the deposit. Allow it up to N days *after* (bank and broker booking dates
    can differ), or keep it strict?
11. **Dollars back to euros** (§5.1): conversions are EUR→USD only, and USD
    withdrawals are ignored by the pool. Add the reverse direction, so
    repatriation has a real rate too, or leave it out of v7?

---

## 10. What v7 deliberately does not build

- **Anything German-tax.** Out of scope, per the above.
- **Price alerts and daily-move notifications.** Engagement mechanics that
  exist to make you trade. Narrow alerts that report a fact — a dividend cut, a
  failed price pull, allocation drift past a threshold — are a different thing
  and are fine.
- **A large daily-change number at the top in a big typeface.** Daily noise is
  the most misleading thing a multi-year tracker can emphasise.
- **Gamification** — confetti, badges, streaks, swipe cards. Reviewers flag
  these on Robinhood as making it feel like a social network rather than a
  finance tool.
- **Anything social.** Sharing, leaderboards, copy-portfolio. Structurally
  pointless for a single-user self-hosted app.
- **An AI that trades or rebalances for you.** Robinhood shipped agentic
  trading in 2026 and drew criticism for decoupling what the investor intends
  from what the account does. The app has no brokerage attached, so it cannot
  anyway — worth naming so nobody proposes it later.
- **1099 generation or broker-grade cost-basis reporting.** That is a
  broker-dealer regulatory obligation. Your actual broker sends you a real one.
- **Brokerage-shaped UI** — order tickets, "buy more" buttons, bid/ask. There
  is no brokerage attached.
- **A model call to produce text that is the same every time** (§4.5).

---

## 11. Costs and things that are not yet verified

**Running cost of the AI features** should be a few dollars a month: a summary
once a day, an assistant used a handful of times, and one news run a day across
your holdings. Two facts make this controllable — OpenRouter passes through
provider list prices with no markup, and **every response now returns its own
cost**, automatically, with no opt-in field. Store that figure next to every
generated row and the monthly spend is a query, not an estimate. Enforce a
daily ceiling in the app's own code as well; the per-key credit limit is the
only cap you fully control otherwise.

**Model choice is deliberately not fixed here.** The catalogue moves fast
enough that any slug written in a planning document in November is wrong by
the time it is implemented. Pick at build time from `openrouter.ai/models`,
filtered on structured-output and tool-calling support. The current Claude
generation is the 5 family — Opus 5.5, Sonnet 5.5, Haiku 5.5 — and a
Sonnet-class model is the right default for the summary and the assistant, with
a cheap Haiku-class model for news clustering where volume is higher and the
task is easier. Use the fallback-model array so a provider outage degrades
instead of failing.

**Verified and safe to build on:** the current web-search mechanism is the
`openrouter:web_search` server tool — the `:online` suffix is deprecated and
the docs say so explicitly. Search is billed per request on top of tokens, from
about a tenth of a cent to about one and a half cents depending on engine.
Structured output via JSON schema is supported but **only strictly enforced
where the provider has a native strict mode** — elsewhere the schema is a
strong hint and you can still get non-conforming JSON, so validate server-side
regardless. Streaming is standard SSE with one trap: keepalive comment lines
that a hand-rolled parser will choke on, so use a real SSE parser. And a second
trap worth more than it looks — **a generation that fails mid-stream arrives as
an in-band event while the HTTP status stays 200**, so you cannot detect
failure from the status code alone.

**Not verified, and flagged rather than smoothed over:** the exact field names
for domain filtering on web search (the docs use two different forms across
pages); whether general web search supports a date-range filter; prompt-caching
behaviour through OpenRouter; the credit-purchase fee percentage; and the
licensing fine print of the news providers for a self-hosted app that displays
article text rather than linking out. None of these block starting; all of them
want a real call or a real read before the code depends on them.

---

*Detail, sources and the full audit: [`v7_research.md`](v7_research.md).*
