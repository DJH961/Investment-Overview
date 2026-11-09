# v7 — the plan

> Written 2026-11-05 against v6.6.0. This is the readable version: what v7
> builds, in what order, and why. The evidence behind it — file references,
> competitor sources, verified API facts and everything that turned out to be
> wrong — lives in [`v7_research.md`](v7_research.md).
>
> Reworked 2026-11-10 after the code audit: fix rounds first (§7a), the
> Currency tab redesigned (§5), the work grouped into ten pushes with a
> clear cut before the model features (§8), accepted additions in §9a.
> The technical companion, with build notes per push, is
> [`v7_implementation_notes.md`](v7_implementation_notes.md).
>
> Nothing here is committed to code yet. Every decision is settled (§9,
> §9a). Push 1 can start without asking.

---

## 1. The short version

**What v7 is for.** v6 made the app professional: one server, one database,
one website, every number computed in one place. v7 makes it **the complete
app for an investor who is taxed in dollars and lives in euros**. Scope
(owner, 2026-11-10): investing accounts only. Not a net-worth tracker, not a
tax app; but it should collect the tax-relevant facts it already knows, as
information without guarantees.

The test for every release: does it answer a question this investor actually
has, in the right currency for that question?

| The question | Truth | Answered by |
|---|---|---|
| What happened while I was away, and was it the market or the dollar? | EUR | Daily Brief (7.0), Currency tab (7.2) |
| What is this holding doing, and what did I pay for it? | both | Deep-dive (7.1) |
| What did converting cost me, and which euros paid for which dollars? | EUR | Conversions (7.3, 7.4) |
| What would I owe if I sold, and what has this year produced for the IRS? | USD | Tranches (7.1), US tax pack (7.5) |
| Can I trust the numbers? | — | Fix rounds (§7a) |
| Explain it to me. | — | Written summary, assistant, news (7.7 to 7.9) |

v7 is complete at release 7.6 (§8). The model features (written summary,
news, perhaps an assistant) are a separate push after that cut.

It is built in four themes:

| | Theme | What it means |
|---|---|---|
| **A** | **The app tells you what happened** | A briefing when you come back after the market has moved, written in sentences, not just numbers. |
| **B** | **The app answers questions** | An assistant you can ask, and a news tab that explains why something moved. |
| **C** | **The currency story gets its own home** | The one thing this app does that no US competitor does at all. |
| **D** | **The US-tax-resident-abroad story gets finished** | Tax lots, holding periods, wash sales — the things that actually matter when you are taxed in dollars and live in euros. |

Underneath all four: a cleanup pass on the things the UI audit found, and the
instrument metadata work that several features sit on top of.

**Before any of it: fix first (added 2026-11-09).** A code audit of the whole
app (backend and frontend, read-only) found that "nothing is broken" was too
kind: 111 findings, none critical, six high. v7 starts with five fix rounds,
§7a, because several v7 features would build on the faulty numbers.

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

**Needs the fix rounds first (§7a).** The Brief narrates the day move, so the
day move must exclude deposits and buys (B-007) and the MTD/YTD start value
must be right (B-006). The trigger rule needs early closes, which the domain
module does *not* have yet (B-018): on a half-day the close is 13:00 ET. And
the card must not ride inside an ETag-cached payload, or a dismissed Brief
can come back from a 304 (B-002).

**Deliberately cut:** "moved on no volume versus real news" — no volume is
stored anywhere in the app, so this is a provider field, a column and a
migration, not a display decision. And milestones or new highs, which need a
full-history scan the read path is explicitly built to avoid.

### 3.2 The written summary (v7.7)

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
4. **Nice to have, not a gate (decided 2026-11-09):** whether a true
   zero-data-retention agreement is available on a personal pay-as-you-go
   account. You will look into it; nothing waits on the answer. Items 1–3 plus
   the no-amounts rule are what the AI releases ship on. The research could not
   find a ZDR toggle in the dashboard, only ZDR as something individual
   providers offer, so it is a routing consequence rather than a setting.

Worth knowing: OpenRouter does not store prompts or responses by default. Its
own retention is opt-in, and the provider-training setting is governed
separately from it — the docs are explicit that opting out of provider training
"has no bearing on OpenRouter's own policies."

### 4.2 The assistant (v7.9, maybe later, not committed)

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

### 4.3 The news tab (v7.8)

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

## 5. Theme C — the Currency tab (v7.2)

> Redesigned 2026-11-10. The earlier version was a list of panels sorted by
> where the data came from. This one is built around the questions a euro
> earner with dollar investments actually asks, and it is meant to be
> explored, not scrolled past.

### What exists, and what others offer

**In the app today:** two Overview cards. `CurrencyBox` shows the live rate
and today's currency move, split into market hours and overnight.
`CurrencyLifetime` shows the lifetime story: average buy rate, the euro's
move since, the FX share of the return, FX gain in euros, the cash-out value
and the break-even rate. Between "today" and "lifetime" there is nothing.
The conversions page is editing plus matching, with no analysis.

**Elsewhere (see `v7_research.md` §5.5a):**

| Product | What it gives on currency |
|---|---|
| Fidelity, Schwab, Robinhood, Empower, IBKR | Nothing. Currency is never shown as a cause of return. |
| Sharesight | Return split three ways per holding and per period: capital gain, dividends, currency gain. |
| Capitally | A currency-return figure beside the asset return; base currency switchable. |
| Parqet, Getquin | Currency as an allocation breakdown. No effect figure. |
| Portseido | FX gain on cash balances. No effect figure or chart. |

So the bar to clear is Sharesight's three-way split per period. Nobody
offers the effect *over time*, the split by time of day, a what-if on the
rate, or the cost of your own conversions. Those are where this tab goes
further.

### The idea that carries the page: the constant-currency line

Companies report sales "at constant currency". The same picture works here
and needs no explanation: the portfolio's euro value as it was, and a second
line showing what it would have been **with every rate move since the start
of the chosen range taken out**. The gap between the two lines *is* the
currency effect, in euros, at every point. Above the line the dollar helped;
below it the dollar cost you. The second line is dashed and the gap is
hatched, so it reads without colour.

It works for a day, a week, a year or everything, with the range picker the
graphs already use.

### Five sub-tabs (the shared segmented control), one question each

**1. Today: "what is the dollar doing to me right now?"**

- Live rate with its provenance stamp and the live-rate health status.
- Today's currency effect in euros and pp, split into market hours and
  overnight (the existing `CurrencyBox` content, moved here in full; the
  Overview keeps its compact card and links here).
- The 1D and 1W constant-currency chart from the stored intraday samples
  (native USD value plus the per-instant rate, both already stored).
- "€1,000 converted now buys $X; yesterday $Y" (the buying-power split in
  `domain/session_fx.py` already exists).

**2. Effect: "over this period, how much was the market and how much the
currency?"** The heart of the tab. One range picker (1W, 1M, 3M, YTD, 1Y,
3Y, All, any calendar year, custom dates) drives everything below it:

- **Headline:** EUR return, USD return, the currency effect between them in
  pp, and the currency effect in euros.
- **The constant-currency chart** for the range.
- **The bridge:** start value, plus deposits, plus market, plus currency,
  equals end value, in euros, as a waterfall. It always adds up.
- **Inside versus outside market hours** for the range: two labelled bars.
- **Month and year bars** of the currency effect, and a month-by-year grid
  (the Periods layout), so good and bad currency years are visible at a
  glance. The Periods page gains the same "currency" column.
- **Per holding, three ways** (the Sharesight split, for the chosen range):
  price gain, dividends, currency effect, in euros, sortable.
- **Records, as plain facts:** best and worst currency day, month and year;
  the lifetime effect expressed in months of your average contribution
  ("the dollar has added the equivalent of 3.2 monthly deposits").

**3. Rate: "where does the rate stand, compared with my own history?"**

- EUR/USD history, long range (the ECB series back to 1999 is free; today
  only the dates the ledger needs are stored).
- Your lines on it: average buy rate, break-even rate, and today.
- Your conversions as markers (size = amount, shape and blue/orange = above
  or below that day's ECB rate), once 7.3 ships.
- Percentile of today's rate within your holding period, 5 years, 10 years
  and since 1999. "The euro is stronger than on 71 % of the days you have
  been invested."

**4. What if: "what would a different rate do to me?"**

- **Sensitivity:** "one cent of EUR/USD is worth €X to you today."
- **The rate slider:** drag the rate from 0.90 to 1.60 and watch the euro
  value, the euro gain and the distance to break-even move. Preset marks for
  your average rate, break-even, and the historic low and high. The server
  sends the scenario rows; the browser only picks one (no return is computed
  in the browser).
- **Does the dollar cushion or amplify your swings?** EUR volatility beside
  USD volatility, the deepest fall in each currency, and how often the
  dollar rose on days your holdings fell. Computed by the existing risk
  module on the two series. For a euro investor the dollar has often risen
  in a crisis, and this shows whether that held for you.
- **Projection:** the Projection page shows its euro result as a band over a
  range of rates, not only at today's rate, with a link from here.
- **Exposure:** share of the portfolio by trading currency (also added as an
  allocation dimension). The page says plainly that a world fund priced in
  dollars is not purely dollar exposure; the look-through version waits for
  fund country data (7.6).

**5. Conversions: "what did converting cost me, and was my timing any
good?"** Arrives with 7.3 and 7.4, specified in §5.1:

- Cost: fees, spread against the ECB reference, total, per year, per
  provider.
- Timing: your rate against that month's average, and two honest
  comparisons: "everything converted on day one" and "the same amount every
  month". They show what spreading conversions out did for you, not what you
  should have done.
- The pool: which conversion paid for which deposit, idle dollars, deposits
  still on the ECB fallback.
- After 7.4: realised versus unrealised currency effect, the currency effect
  on cash, and "your rate" per holding.
- A link to the Conversions page for editing. Analysis lives here, editing
  lives there.

The tab never shows a panel whose data is not there yet. The Conversions
sub-tab simply does not exist until 7.3.

### The stats (owner, 2026-11-10: good figures as well as panels)

Every sub-tab opens with a strip of KPI tiles (the shared tile component),
then its panels. Above the sub-tabs sits one strip that is always visible.

**Always visible, the six that sum it up:**

| Tile | Example |
|---|---|
| EUR/USD now, with today's change | 1.0832 · −0.3 % |
| Currency effect today | −€212 |
| Currency effect this year | +€1,480 · +1.9 pp |
| Currency effect lifetime | +€3,950 · +4.1 pp |
| Your average rate against now | 1.0812 · tailwind 0.2 % |
| One cent of EUR/USD | ±€640 |

**Per sub-tab:**

| Sub-tab | Stats |
|---|---|
| Today | Effect inside market hours · effect outside · the rate's range today (low to high) · what €1,000 buys now against yesterday |
| Effect (for the chosen range) | EUR return · USD return · currency effect in pp and in euros · currency's share of the change ("currency explains 38 % of this period") · best and worst month · share of months with a tailwind · longest tailwind and headwind run · a typical day's currency swing (median, ±€) · largest single-day effect, with its date · the effect in months of your average contribution |
| Rate | Percentile of today's rate (holding period, 5 y, 10 y, since 1999) · 52-week high and low, with distance from each · lowest and highest rate since you started, with dates · average rate over your holding period · share of days the rate was above your average rate · how much the rate itself moves in a year (volatility) |
| What if | One cent in euros · break-even rate and distance to it · euro value at the historic low and high rate · EUR volatility beside USD volatility · deepest fall in EUR beside USD · share of your down days on which the dollar rose |
| Conversions | Number of conversions and total converted · your average rate against the ECB average for the same dates · total cost in euros and as a share of what you converted · fees and spread separately · best and worst conversion · your rate against the month averages · months since the last conversion · idle dollars |

Rules for the tiles: each has an info tip saying in one sentence what it
measures; tailwind and headwind carry a word and an arrow, not only blue
and orange; every figure is computed on the server; a tile whose data is
missing is left out, not shown empty.

### How the numbers are built (one definition, used everywhere)

A new pure module, `domain/fx_attribution.py`, splits each day's change in
euro value into three parts: flows, market, currency. It must use the same
convention as the existing `day_split`, so the tab's "today" equals the
Overview's. Read that code first; do not invent a second convention.

- **Euro amounts** for a period are the daily parts added up. Sums of euro
  amounts at their own dates are allowed by the currency rule. Never
  annualised, never fed to an XIRR.
- **Percentage points** for a period are the EUR return minus the USD return
  of the same period, each computed on its own (the EUR one from the euro
  cashflow stream). Never `usd_return × fx_change`.
- **The constant-currency line** is the actual euro value minus the
  currency effect accumulated since the start of the range. It is *not*
  "today's dollars at the starting rate": that would credit a deposit made
  last week with a rate move from last year. Each rate move counts only for
  the dollars that were there when it happened.
- **Inside versus outside:** each day's currency part splits at the session
  open and close. Outside includes weekends and holidays.
- **Generic by construction:** the effect is defined for holdings whose
  native currency differs from the reporting currency. In the EUR view that
  is the dollar holdings; in the USD view it is the euro holdings. No
  currency is hard-coded.
- **Everything is computed on the server**, including the percentile, the
  scenario rows and the risk figures. The browser sums, sorts and picks.

**Tests (property plus golden):** the three parts sum to the day's change;
the daily parts sum to the period; inside plus outside equals the period's
currency effect; the currency part is zero when the rate did not move; the
lifetime figure equals the Overview card's; "today" equals `day_split`.

**Storage:**

- Daily history needs nothing new: the snapshots already hold native value
  and rate per day.
- The session-boundary rates do. Intraday rates are pruned after five
  sessions, so 7.2 keeps the EUR/USD rate at each session's open and close
  for good: one small row per session, raw market data, not a
  derived-currency column. It must live where a cache reset does not wipe
  it, because it cannot be refetched far back. How far hourly provider data
  reaches for a backfill is not verified (about two years is typical) and
  needs a real call. Older periods show the total effect and say "split not
  available before <date>".
- The long ECB series is a one-time backfill into the existing `fx_history`.

**API:** `/api/currency/both` for Today and the headline figures, plus
`/api/currency/effect`, `/rate-history` and `/scenarios`, all on the
existing `/both` + ETag pattern. New endpoints go into the activity labels.

### Hazards, each of which produces a plausible wrong number

- The FX-versus-instruments split is **not** `eur_return = usd_return × fx_change`.
  The euro leg stays independently computed; the currency effect is a residual.
- FX profit and loss is valid only as a single-instant comparison or a sum
  of them. Never annualise it, never feed it to an XIRR.
- Conversion cost compares each conversion against **its own date's** fixing,
  never one back-dated rate across a batch. Label it "versus ECB daily
  reference", not "versus mid-market".
- A rate labelled ECB must be the settled fixing, not today's live spot
  (audit B-011).
- Realised versus unrealised is the easiest place to break the rule: it is
  built from the euro cashflow stream with each leg at its own date's rate,
  never from a dollar gain multiplied by a rate change.
- Do not add derived-currency columns to store any of this.

**Wording worth borrowing from Portseido:** time-weighted and money-weighted
return side by side, as "the return your decisions produced" versus
"includes the effect of your contribution timing".

### 5.1 Conversions, finished (v7.3 and 7.4)

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

#### 7.3, first half — Clear matching (UI + read-model, no new maths)

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

#### 7.3, second half — What converting costs you (new pure-domain maths)

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

#### 7.4 — One rate everywhere (money maths)

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

  **How it works: a second FIFO layer**, new pure module `domain/cash_pool.py`
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
| **Transactions tab** | A deposit's details: which conversion(s) paid for it (7.3) | — |
| **Currency tab** | Everything: live rate, day and lifetime effects, costs, timing, pool, idle dollars, per-holding FX table (§5) | — |
| **Conversions page** | Editing, matching, duplicate/backdate, statement import, and a link back to the Currency tab | Analytics (they live on the Currency tab) |

#### Matching rules (decided 2026-11-09)

- **Pinning, on top of FIFO.** In a deposit's details, *Use this conversion*
  pins a specific conversion (or several, with dollar amounts) to it. Pins
  are applied first; FIFO then fills whatever is left, in date order, from
  the dollars nobody pinned. A pin shows as "Pinned" (icon and label) in
  both the deposit's declaration and the conversion's "used by" list, and
  *Unpin* returns the deposit to FIFO. Storage: a small ledger-tier link
  table `fx_conversion_pins(deposit_txn_id, conversion_id, usd)`. That is a
  relation, not a derived-currency column. It needs a migration with a
  working downgrade; its rows are v6-only data, so they go in the
  `inv-dashboard-export-v5` "dropped" note until the cutover removes that
  tool.
- **No global matching window.** FIFO stays strict: only conversions dated on
  or before a deposit. A *pin* may reach a conversion dated **up to 7 days
  after** the deposit, for bank-vs-broker booking dates. The exception lives
  exactly where you made it and cannot shift other deposits' matching.
- **Dollars back to euros: release 7.4,** after the pool. A conversion gets a
  direction (`eur_to_usd`, the default for every existing row, or
  `usd_to_eur`). A USD→EUR conversion takes dollars out of the 7.4 pool at
  their EUR cost; the euros received minus that cost is your **realised FX
  gain or loss**. That is the Currency tab's realised-versus-unrealised panel
  (§5), built from real cashflows at their own dates, never a USD gain times a
  rate change. Fees and the spread against the ECB rate (7.3) work the same
  in both directions.

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
- **Daily Brief line (once 7.3 ships, added to the 7.0 Brief):** "You converted €2,770 this month at 1.0830,
  0.2% under the ECB reference."
- **Exports:** conversions and their matching in the CSV export and the
  phone export.

**Activity log:** conversion edits reach the `changes` subject only as the
generic request line today: `fx_conversion_service` is routed there but logs
nothing itself (audit B-021, fixed in fix round 5). The new write paths
(statement import, the prefilled add) log a proper domain line there too. The cost report is read-only and
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

### 6.1 Tax lots (v7.1, with the deep-dive)

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

**Decided 2026-11-09: a tranche view inside the holding's details.** It is a
"Tranches" tab of the deep-dive (§7). On a phone it is reachable from the
row's expansion, so it is never more than one tap from where P/L already
lives. Per purchase: date, shares left, cost in USD, age with a short-term /
long-term marker at one year, and gain against today's price. The tab ships
in 7.1 with USD only; the EUR cost column arrives with 7.4, because it
needs the pool rate and must not ship on the buy-date rate first. The tab says plainly, once: "FIFO view per purchase;
the holding's totals use average cost." Real FIFO cost basis stays out of
v7.

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

### 6.2 The US tax pack (v7.5)

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
| 2 | **Onboarding is unreachable** | A complete six-step first-run checklist exists and fetches its own endpoint, and nothing routes to it. **Decided: keep it, non-intrusive.** It appears as a small dismissible card (never a full-page takeover) while setup steps are open. One click hides it for good (remembered on the server, so every device agrees). **"Restart setup guide"** in the account menu and in Settings brings it back. It never blocks a page. |
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

### The deep-dive rework (v7.1, split in §8)

Today the "deep dive" is a bottom sheet containing a price chart and an
eleven-row definition list. No route, no tabs, no transactions, no dividends,
no lots, no intraday.

Make it a route. The audit confirmed this is low-friction: the title and tab-bar
logic already prefix-match, per-id data already exists, and reusing the existing
page chunk avoids a new load waterfall. Then add tabs using the segmented
control the rest of the app uses: performance, transactions, dividends, lots.

**1D and 1W per holding: store what is already fetched (decided
2026-11-09).** Checked in the code: the portfolio 1D/1W line already fetches
every holding's minute bars (`bars_by_symbol` in
`intraday_snapshots_service`'s reconstruction and week backfill), and the
live capture prices every holding each tick. Only the *sum* is kept
(`intraday_value`), so the per-holding series is computed and thrown away.
And the ETF twins already have exactly the right table:
`intraday_twin_prices(symbol, captured_at, price_native)`, cache tier, pruned
to the 1W window.

So the plan is a small refactor, no new fetching:

- Generalise `intraday_twin_prices` into `intraday_symbol_prices` (same
  columns, plus a `kind` of `holding` / `twin`), with a migration and a
  working downgrade. Cache tier, so a reset simply rebuilds it.
- The reconstruction, week backfill and live capture write each symbol's
  price next to the portfolio sample they already write. Same bars, one more
  insert.
- **Size is a non-issue:** about 20 symbols × ~390 one-minute samples a
  session × the 5 sessions the 1W window keeps ≈ 40,000 rows, roughly
  2–3 MB with the index. The same pruning as `intraday_value` keeps it there.
- A holding's 1D/1W chart is then a read: shares × price per instant, in the
  holding's own currency. The EUR line uses the per-instant rate already
  stored on `intraday_value`, never a converted return.
- Gaps: a symbol with no stored bars falls back to the same gap-fill the
  portfolio line uses (Yahoo, then Tiingo), so there is one repair path, not
  two.

**ETF twins for NAV funds on the holding page.** A mutual fund has no
intraday price, only its daily NAV, which is why the twins exist. On a NAV
fund's deep-dive:

- **1D:** while the NAV is pending, the line is the twin's estimate
  (`prev_NAV × twin_now / twin_prev_close`, rebuilt at read time from
  `intraday_symbol_prices`, never stored as a price). It is dashed and
  labelled "≈ estimate from VOO"; when the NAV posts, the official point lands
  at the close and the estimate stays visible as a faint line for comparison
  that day.
- **1W:** past sessions show the official NAV points, with the twin's
  intraday shape behind them in a muted line, so you can see how each day
  moved.
- **Twin panel:** which ETF stands in and why (same index, close index,
  chosen by you), its live move, and the tracking record already computed
  for Diagnostics (typical daily gap, bias "runs high/low", sessions counted),
  plus the last few sessions' estimate-vs-NAV gaps as a small table.
- **Change the twin** right there (the existing manual choice), instead of
  only in Settings.

Holdings without a twin simply show their own intraday price; funds without a
twin show the NAV points with a short "no intraday price for this fund" note.

**Connect the dividend data that already exists.** Per-holding dividend detail
lives on the Activity page, is not filterable to one instrument, and is not
linked from the holding detail. That is a cheap connection nobody has made.

---

## 7a. Fix first: the pre-v7 audit (added 2026-11-09)

> Two read-only code audits against v6.13. Full findings, each with file and
> line, confidence and a fix direction:
> [`v7_audit_backend.md`](v7_audit_backend.md) (B-001 to B-022) and
> [`v7_audit_frontend.md`](v7_audit_frontend.md) (F-001 to F-089). Nothing
> was fixed. Nothing was run in a browser or reproduced at runtime, so
> "confirmed" means traced in the code.

**The verdict.** No critical finding. Lifetime XIRR and the portfolio
cashflow stream follow the currency rule. The faults sit at the edges: period
start values, the day move, the live tick patch, stale tabs, and text that
does not fit its box. 111 findings: 6 high, 23 medium, 58 low, 24 nits.

Each round is one or more patch releases. Every fix ships with a test that
fails before it. Rounds 1 and 2 are what you would notice; do them in order.

### Round 1: numbers you can trust (money maths, backend first)

| ID | What | Size |
|---|---|---|
| B-018 | Half-day sessions treated as open until 16:00. **Dated: before Fri 27 Nov 2026** (then 24 Dec). | S |
| B-006 | Overview MTD/YTD count a flow dated on the 1st twice; disagrees with Periods. Start value becomes the previous day's close. | S |
| B-007 | "Today's move" counts deposits and same-day buys as gain. Subtract the session's external flows. | M |
| F-081 | The tick patch writes a browser-computed, FX-free day % into the EUR side (breaks "the client never computes a return"). The server sends the figure in the tick, or the client leaves it alone. | M |
| F-029 | Treemap computes each category's day % in the browser. Same rule, same fix. | S |
| B-017 | Uninvested brokerage cash outside a money-market fund is missing from the total. **First step is a Data Health check** that reports whether any account is affected; the valuation change follows only if one is. Must be settled before 7.4, whose dollar pool models exactly this cash. | M |
| B-010 | Native and dual-currency average cost drift after a reinvest with no price. | S |

Gate: golden tests (deposit on the 1st, deposit day, half-day), plus a parity
note where a figure deliberately moves away from v5.

### Round 2: everything fits (visual)

The top bar on phones (F-002) and between 1024 and 1280 px (F-001), the
Overview holdings pills (F-027), the hero value at 360 px (F-028), the graph
range picker (F-019), the Holdings summary strip (F-038), the drift table on
tablets (F-051), then F-016, F-022, F-024, F-037, F-049, F-064, F-012. One
root cause covers most: `nowrap` or `flex-shrink: 0` with nothing allowed to
give way, and `text-overflow` set on flex containers where it does nothing.
Also here: the grey small-text contrast on dark (F-087) and the undefined
`--color-text` token (F-055).

**This round builds the tool that was missing.** The audit could not render
the app: there is no way to run the frontend without a sign-in and real data.
Add a fixture mode (seeded fake ledger, worst-case values: seven-figure
totals, long instrument names, every status pill) and a Playwright screenshot
run at 360, 390, 768, 1024, 1280 and 1440 px in both themes. It proves this
round, catches the clipping the code read missed, and every v7 page reuses
it. No real tickers or amounts in the fixtures (public repo).

### Round 3: saved means saved, fresh means fresh (front/back interplay)

| ID | What | Size |
|---|---|---|
| B-001 | Writes commit after the response is sent; cache bumps and live events fire before the commit. Commit first, publish after. | S–M |
| B-002 | `/both` ETags never expire, so a long-open tab shows Friday's "live" wording on Saturday. | S |
| B-012 | A returning tab only catches up on ticks; it misses end-of-day refreshes and other devices' edits, and loses 1D points after a restart. | S |
| F-082 | Account renames and imports that create an account are not refreshed on Holdings, Transactions, Activity. | S |
| F-004 | The live stream is not reopened after sign-in (up to 30 s without ticks). | S |
| B-003 | Calculator, allocation-plan and reconcile requests flush the whole read cache on every device. | S |
| B-016, B-015 | Stale default graph range; the idle timeout never fires for an open tab. | S |

### Round 4: input and lost work, plus the five §7 patches

- Decimal comma: "12,5" is rejected in the transaction form and silently
  becomes 0 % in allocation targets (F-043, F-053). One shared parser.
- Lost work: the hide-numbers toggle remounts the page; Settings drafts and
  an import preview vanish on navigation, and the import stays pending on the
  server (F-003, F-071, F-063).
- Advanced settings are hidden by default, against the owner's rule (F-070).
- The five "ship as patches" items in §7 (404 page, onboarding card, nav
  label, empty states, hand-rolled tabs).
- The remaining low and nit frontend items, grouped per page.

### Round 5: speed and housekeeping

- Overview and graphs build the whole read model twice, once per currency,
  on every FX tick (B-013).
- The browser writes the whole query cache to localStorage about once a
  second in market hours (F-083).
- Scheduler: full end-of-day re-run after every deploy (B-004), a failure
  flag that is always green (B-005), database work on the event loop (B-019),
  the backup "dirty" flag lost on restart (B-020).
- Ledger and conversion edits get a real line in `changes.log` (B-021).

### Moved elsewhere, on purpose

- **Into the cutover release:** unused single-currency routes (B-014) and v5
  settings in `config.py` / `.env.example` drift (B-022).
- **Before the cutover, not after:** the frozen `net_eur` / `net_usd` legs
  still feed holding-level EUR figures, holding XIRR flows and dividend
  income (B-008). The cutover stops writing those legs, so these reads must
  move to the derived path first or new transactions get no EUR figures.
- **Into 7.3/7.4:** today's live spot leaking into values labelled "ECB"
  (B-011) must be fixed before the spread maths compares against the ECB
  fixing; the instrument-vs-account currency mismatch (B-009) before the pool.

### Not audited yet (second pass, during rounds 2 to 5)

The importer parsers and staging, most of `intraday_snapshots_service`, auth
and passkeys, migrations and their downgrades, the Tiingo fallback, the
benchmark and diagnostics services, the read models for deposits,
allocations, projection, analytics and the phone export; on the frontend the
Diagnostics sub-tabs and several Import and Settings parts. Importers and
migrations matter most: the cutover and 7.4 both lean on them.

---

## 8. The order of work: ten pushes, then a clear cut

Reworked 2026-11-10 (owner): fewer versions, each one a **push**: a block of
work sized for one or two full Claude sessions that ends in one release.
v7 is everything up to the cut. The model features are a separate push
afterwards, planned in detail when v7 is done.

| Push | Release | What goes in | Sessions | Done when |
|---|---|---|---|---|
| 1 | 6.x "Trust" | Backend fixes: fix rounds 1 and 3 of §7a (half-days, MTD/YTD, day move, commit order, ETags, tab catch-up, cache flushes), and the server half of F-081 (the tick carries the day % so the browser stops computing it). **Before 27 Nov 2026.** | 1 | Golden tests for a deposit on the 1st, a deposit day and a half-day pass |
| 2 | 6.x "Fit" | Frontend fixes: fix rounds 2 and 4 (every clipping finding, decimal comma, lost work, visible advanced settings, the five §7 patches), the fixture mode and the screenshot run. | 1–2 | Screenshot run green at six widths in both themes |
| 3 | 6.x "Ready" | Fix round 5 (speed, scheduler, activity lines), the frozen-leg reads moved to the derived path (B-008), the second audit pass and its fixes, **ledger completeness checks (P7)**. | 1–2 | No high or medium finding open; Data Health reports a missing dividend in a test ledger |
| 4 | **7.0** | **The cutover** (v5 removed, B-014, B-022) and the **Daily Brief** (§3.1). | 2 | No v5 code on `main`; the Brief's trigger passes its table of cases; a dismissed card stays gone |
| 5 | **7.1** | **Holding deep-dive** (§7): route and tabs, one shared holding row, per-holding 1D/1W, ETF-twin view, tranches in USD with the long-term countdown (P3), per-holding dividends and transactions. | 2 | A holding has a URL; holdings' 1D lines sum to the portfolio line; tranche shares sum to the position |
| 6 | **7.2** | **Currency tab** (§5): Today, Effect, Rate, What if; currency as an allocation dimension; the Projection rate band (P5). | 2 | Daily parts sum to every period; "today" equals the Overview card; lifetime equals the lifetime card |
| 7 | **7.3** | **Conversions** (§5.1): clear matching, pinning, costs and timing, currency-generic naming (C1), the Conversions sub-tab, the "Invest this month" flow (P6). | 2 | Every USD deposit declares how it was paid for; cost golden values match the hand calculation |
| 8 | **7.4** | **One rate everywhere** (§5.1): the cash pool, holding EUR cost from the pool rate, the tranche EUR column, dollars back to euros, realised versus unrealised, currency effect on cash and idle dollars. | 2 | Holdings plus pool equal EUR invested on the real ledger; realised plus unrealised equals the lifetime effect |
| 9 | **7.5** | **Tax information** (§6.2, P1–P3): realised gains by holding period, wash sales, sell planner, the loss list, the tax year page, the 1099 check, the withholding column. | 2 | Short/long-term totals match a hand-worked ledger, including a reinvested-dividend wash sale |
| 10 | **7.6** | **The finish:** month and year recaps with the real euro return (P8, P10), one channel for facts (P9), instrument metadata from the price provider with sector and country allocation, the hand-written risk explanations (§4.5). | 1–2 | A recap's figures equal the Periods page; an alert fires in a test and is off by default |
| | | **— the cut: v7 is complete here —** | | |
| 11 | 7.7 | AI foundation and the Brief's written summary (§3.2, §4.1); AI-assisted metadata fill (§4.4). | later | planned when v7 is done |
| 12 | 7.8 | News, as its own page (§4.3). Licences read first. | later | |
| — | 7.9 | Assistant (§4.2). Maybe later; not committed. | — | |

**Count:** ten pushes to a complete v7, about 15 to 18 full sessions. The
first three are fixes on v6; 7.0 arrives with push 4.

### What can be combined, and what has to stay apart

**Runs side by side (two sessions at once, separate worktrees):**

- Push 1 and push 2. One touches only `backend/`, the other only
  `frontend/`. Push 2 rebases once at the end to pick up the regenerated
  API types.
- Inside push 4: the cutover (mostly deletions, good work for cheap
  subagents) and the Daily Brief (new files only).
- Inside any feature push: a backend lane and a frontend lane, **once the
  API contract is written down first**. The session starts by agreeing the
  endpoint shapes, then the lanes run in parallel and meet at the end.
- Push 5 and push 6 touch different areas and could overlap if you want to
  go faster, with one condition: only one of them may add a migration at a
  time.

**Must be one at a time:**

- **Money maths.** One change to a return, cost basis or currency figure
  per session, with its golden values checked by you before the next one
  starts. Pushes 7, 8 and 9 are strictly in order: 8 builds on 7's
  matching, 9's EUR figures on 8's pool.
- **Migrations.** One Alembic chain. Two branches that both add a migration
  collide; the second one is rebased and re-pointed.
- **The shared files:** `CHANGELOG.md`, the three version files and their
  lockfiles, `openapi.json`, `api-types.ts`, `tokens.scss`, the activity
  labels. Parallel lanes do not touch them. The session's orchestrator
  writes them once, at the end, in the release commit.
- **The cutover before push 8**, so the pool maths never needs a v5-parity
  exception.

**Yours, not Claude's (accounts and secrets):** the Cloudflare and GitHub
clean-up after the cutover (push 4), the mail or push account for alerts
(push 10), and later the OpenRouter and news keys.

### How to run a push

1. Start the session with "push N of the v7 plan". The orchestrator reads
   §8, the sections it points to, and the audit files.
2. It writes the API contract and the file ownership per lane, then hands
   lanes to subagents (Opus for money maths and design, cheaper models for
   mechanical work).
3. During a sprint set `DEPLOY_MODE=scheduled`, so half-finished pushes do
   not deploy one commit at a time. Critical fixes still go `Deploy: now`.
4. Changes collect under `[Unreleased]` during the push and are folded into
   one dated release at the end. Bug fixes from pushes 1 to 3 are the
   exception: they release as they land.
5. Every push ends with the screenshot run, the targeted tests, a green CI
   and a short "what to check by hand" list for you.

**Tests have an owner.** The fixture mode and screenshot run are built in
push 2 and extended by every push that adds a page. Repository-layer tests
come with pushes 1 and 4, smoke tests for the untested UI primitives and
the transaction form with push 2, and a coverage tool with push 3.

**The v5 cutover: approved 2026-11-09 ("v6 has delivered, v5 can die").** It
ships as one clean-up release before 7.4, so the pool-rate maths never needs
a v5-parity exception.

- **Kept:** the **demo website**. `web/` builds only the offline demo
  (`VITE_DEMO_ONLY=1`), and GitHub Pages keeps serving it through its
  workflow.
- **Removed from `main`:**
  - the NiceGUI desktop app and its `ui/` code;
  - the Windows installer / portable bundle and the `release.yml` jobs that
    build them (`tag-on-version-bump.yml`, `ci.yml`, `deploy.yml` and
    `pages.yml` stay);
  - the Cloudflare Worker (`web/proxy/`);
  - the `live-data` release publishing, the encrypted-blob publish service
    and its scheduled routines and GitHub Actions;
  - the v5 export tool (`tools/export_v5_ledger.py`) and the
    "downgrade to 0014" CI check;
  - the v5 parity check (`tools/parity_check.py`);
  - every v5-only test.
- **Rules that end:**
  - AGENTS.md's "until cutover" rules: the frozen `net_eur` / `net_usd` /
    `fx_rate_to_eur` legs stop being written, the old EUR snapshot columns
    stop being filled, and the export-v5 "dropped" notes go.
  - The columns themselves are dropped in a later migration, once a release
    has run without them.
  - New migrations still need a working downgrade, back to the previous v6
    revision.
- **Owner steps (accounts, so yours):** delete the Worker in Cloudflare,
  delete the `live-data` release and remove any secrets only v5 used. I
  prepare the exact list with clicks; Pages stays on for the demo.
- **The archive, for "do it like in v5":**
  - the code stays one command away rather than in the tree, where it would
    slow every search and invite agents to edit dead code;
  - the last `main` commit that still has v5 is tagged **`v5-archive`**;
    `legacy/v5` / `v5.3.1` stay as they are;
  - `docs/legacy_v5.md` gains a "Comparing with v5" section:
    `git grep <pattern> v5-archive`, `git show v5-archive:<path>`, and a
    read-only worktree (`git worktree add ../Investment-Overview-v5
    v5-archive`) for browsing in an editor;
  - AGENTS.md points agents there whenever you say "like in v5".
- **Rollback:** after the cutover there is no downgrade path back to a v5
  ledger. The sealed pre-cutover v5 backup stays as the last resort, and
  `legacy/v5` still runs it.

---

## 9. Decisions (settled 2026-11-09 and 2026-11-10)

Everything in this table is settled. Open proposals are in §9a. New
questions that come up while building go there, with a recommendation, and
get settled before the release that needs them.

| # | Question | Decided |
|---|---|---|
| 1 | What the model may see (§4.1) | Rank order + core/mid/small buckets; exact weights a setting, default off |
| 2 | Tool-calling assistant (§4.2) | Yes, with redacted tools; `v6_one_app_plan.md` Phase 5 stands |
| 3 | News tab discloses your symbol list (§4.3) | Accepted; server-side, batched, Finnhub first |
| 4 | OpenRouter zero data retention (§4.1) | Nice to have, not a gate; you look into it when convenient |
| 5 | Tranches (§6.1) | A tranche view inside the holding's details; totals stay average cost |
| 6 | Onboarding (§7) | Keep it, as a dismissible card; "Restart setup guide" brings it back |
| 7 | v5 cutover (§8) | Approved: v5 removed, demo website kept, code archived under the `v5-archive` tag |
| 8 | Holding EUR cost (§5.1) | The pool rate, `fx.holding_cost_basis` as the rollback switch |
| 9 | Manual pinning (§5.1) | Yes, pins first, FIFO fills the rest |
| 10 | Matching window (§5.1) | Strict FIFO; only a pin may reach up to 7 days after a deposit |
| 11 | Dollars back to euros (§5.1) | Yes, release 7.4, with realised FX gain from the pool |
| 12 | Per-holding 1D/1W (§7) | Store the per-symbol bars the 1D line already fetches; ETF-twin view for NAV funds |
| 13 | FX on cash (§5) | EUR value now minus the pool's EUR cost of those dollars |
| 14 | Fix first (§7a) | Yes: five fix rounds before any v7 feature |
| 15 | Release order (§8) | Renumbered in shipping order; 7.0 is the cutover; deep-dive, currency and tax before AI |
| 17 | Currency tab (§5) | It extends the currency-effect cards: effect per period and over time, and inside versus outside market hours for any period; not only rate charts |
| 18 | Size of v7 (§8) | Ten pushes, releases 7.0 to 7.6; the model features are a separate push after the cut; the assistant is "maybe later" |
| 19 | News (§4.3) | Its own page when it ships, not folded into the deep-dive |
| 20 | Additions (§9a) | P1–P3 and P5–P10 accepted, P4 dropped; C1 and C4 yes, C2 no, C3 as a middle ground: tax figures calculated in USD; USD view shows dollars only, EUR view shows their euro worth where it makes sense |
| 21 | Currency tab stats (§5) | A KPI strip that is always visible, plus a strip per sub-tab, as well as the panels |
| 16 | Scope (§1) | Investing accounts only. No other account types, no net worth, no FBAR. Tax-relevant information is welcome, without guarantees; it is not a tax app |

---

## 9a. Additions accepted 2026-11-10

Accepted by the owner, inside the scope of decision 16. Each is built in
the push named; the detail is settled at the start of that push.

| # | Addition | Push |
|---|---|---|
| P1 | **Tax year page (USD).** Per calendar year, collected from the ledger: dividends, money-market and interest income, capital-gain distributions, realised short- and long-term gains, wash-sale adjustments, withholding paid, fees. Year to date for the running year. EUR-native instruments translated at each transaction's own date. CSV export. Headed "information from your ledger, not tax advice; your broker's 1099 is what counts". | 9 (7.5) |
| P2 | **1099 check.** You type in the totals from the broker's 1099; the page shows where the ledger differs. | 9 (7.5) |
| P3 | **Holding-period countdown and loss list.** In the tranche tab: "long-term in 23 days". In the tax pages: tranches with an unrealised loss, short or long, with the wash-sale window marked. | 5 (7.1) and 9 (7.5) |
| P5 | **FX outlook.** Sensitivity, the rate slider and the Projection rate band. Now part of the Currency tab design (§5, "What if"). | 6 (7.2) |
| P6 | **"Invest this month" flow.** One guided path: euros to invest, the conversion (real rate, spread shown), the deposit, the buys from the target allocation, then "check against the import" once the broker file is in. Reuses the calculator, the conversion form and the allocation plan. | 7 (7.3) |
| P7 | **Ledger completeness checks.** Data Health reports a dividend or split the price provider shows that the ledger does not have, the days since the last import, and optionally a share-count check against numbers you type from a statement. | 3 |
| P8 | **Month and year recaps.** The Brief's deterministic maths over a month or a year: contributed, market effect, currency effect, dividends, conversion cost. A card on the first visit of a new month or year, and always available on Periods. | 10 (7.6) |
| P9 | **One channel for facts.** Email or web push, off by default, only for facts: backup failed, price feed stalled, ledger gap found, a tranche turned long-term. | 10 (7.6) |
| P10 | **Real euro return.** Periods and the recaps show the EUR return after euro-area inflation, from the public HICP series. | 10 (7.6) |

P4 (a flag on non-US funds) was dropped: the owner holds none.

**Changes:**

| # | Change | Decided |
|---|---|---|
| C1 | Currency-pair-generic naming: `domain/cash_pool.py` keyed by account currency; a conversion has `from_ccy` / `to_ccy`. | Yes |
| C2 | News folded into the deep-dive instead of its own page. | No: news gets its own page when it ships. The model features stay limited in general. |
| C3 | Tax pages always in USD, ignoring the EUR/USD toggle. | Middle ground (owner, 2026-11-10): always calculated in USD. USD selected shows dollars only; EUR selected shows the euro worth wherever that makes sense, with the dollar figure beside it. Details below. |
| C4 | The assistant stays last and optional. | Yes: maybe later, not committed |

**C3 as decided: dollars are calculated, euros are shown beside them.** On
the tax pages (tranches, sell planner, tax year, 1099 check):

- Every tax figure is **calculated in USD**, whatever the EUR/USD switch
  says. The switch decides what you see:
  - **USD selected: dollars only.** No euro figures anywhere on the page.
  - **EUR selected: euros wherever a euro figure makes sense.** The main
    figure is what the dollar amount is worth in euros ("≈ €460"), with
    the dollar figure the IRS counts beside it, smaller ("taxable:
    $500"). Lines that only mean something in dollars stay in dollars even
    then: the 1099 check, and anything that mirrors a form line.
  One line per page says which is which: "Calculated in USD, as the IRS
  counts; euro figures show what those dollars are worth."
- The euro worth is the dollar figure converted at a single instant,
  which the currency rule allows:
  - something that already happened (a sale's gain, a dividend, tax
    withheld) uses **its own date's rate**; a year's total is the sum of
    those;
  - something that has not happened (an unrealised gain, a planned sale)
    uses **today's rate**, and says so.
- It is never called "your gain in euros". That is a different number: the
  euro gain includes what the exchange rate did, and can be a loss while
  the taxable dollar gain is positive. In the EUR view, where both matter
  (a tranche, a planned sale) they sit side by side with plain labels:
  **"Taxable gain"** (its euro worth, dollars beside it) and **"Your gain
  in euros"**. Seeing the two together is the point: it shows when you
  would owe tax on a sale that made you nothing in euros.

---

## 10. What v7 deliberately does not build

- **Anything German-tax.** Out of scope, per the above.
- **Other kinds of account, or net worth.** Investing accounts only
  (decision 16). No bank accounts, pensions, property or liabilities.
- **A tax app.** No FBAR or foreign-account reporting, no forms, no filing
  figures. The app collects tax-relevant facts from the ledger and labels
  them as information without guarantees.
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
