# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Responsive web app, installable as a home-screen web app on phones. Phone and desktop are both first-class.)

## Users

- **Primary: the owner.** A Europe-based investor who thinks in EUR but holds almost entirely USD-denominated funds through US brokers. Writes code but is not a sysadmin. Red-green color-blind (protan).
- **Later: other self-hosters.** Single-user today, but future work should keep a path open for other people (family, friends) to run their own instance. Do not hard-code the owner's brokers, currencies or habits into the product.
- **Demo viewers.** Anyone who opens the offline demo on GitHub Pages (`web/`, no real data). They look around; they do not operate the product.

## Product Purpose

A personal investment dashboard that turns broker exports into one transaction ledger and computes honest portfolio returns from it (XIRR, TWR, CAGR, period growth, drawdown, risk metrics), reported in EUR or USD.

It exists to help a European understand USD assets from a European point of view: how much of a gain came from the market and how much from the dollar, without blending the two. Success means the owner can trust every number, see at a glance how the portfolio is doing today, and plan and settle the routine money moves without a spreadsheet.

## Positioning

- **FX-aware EUR truth.** Amounts are stored in their native currency. Cashflows convert at their own date's rate, valuations at the valuation moment's rate. EUR returns are built from a EUR cashflow stream, never from a USD return converted after the fact, and USD figures come only from native dollars. Market effect and currency effect are shown apart (Currency page: impact, bridge, the dollar's position, what-if scenarios).
- **Own ledger, any broker.** One broker-agnostic ledger that the owner controls, encrypted (SQLCipher) on their own server, with importers as plugins (Vanguard, Fidelity, Wise statements and more).
- **Calm daily check-in.** A fast, honest glance (Daily Brief, freshness on every view, movers, intraday value) matters as much as the deep analytics.
- **Plan the money journey.** Recurring conversions, deposits and multi-fund buys, with estimated rows and quick settling, are a core job, not a side feature.

## Operating Context

- **Phone glance, desktop deep.** Quick phone check-ins most days; desktop for imports, analysis, settling, reconciling and settings. Features never disappear on phones; layout and density adapt.
- **The owner's money journey:** a bank auto-converts EUR to USD, a fixed monthly deposit goes to a broker money-market fund, and weekly auto-buys follow. Only the conversions and buys need the owner's attention in the app.
- Prices from Yahoo (yfinance), FX from Frankfurter/ECB, with a Tiingo fallback. US market hours drive what "live" means; every view says how fresh its data is.
- Hosted on the owner's Hetzner server (Docker Compose, Caddy, sealed off-site backups). Server-sent events push updates to the client.

## Capabilities and Constraints

- **Pages:** Overview, Holdings and holding detail, Periods (monthly/yearly), Activity, Risk, Projection, Allocations, Currency, Currency conversions, Recurring, Transactions, Import, Instruments, Lookup, Diagnostics (data health), Settings, Help, Onboarding and a guided tour.
- **Server computes, client patches.** Every non-linear money calculation (returns, FX-aware figures, period growth) happens on the server. The client does only linear presentation maths on server-supplied values and never computes a return.
- **Reporting currency is a parameter** (EUR default, EUR/USD toggle), never hard-coded. EUR and USD views need not look identical, but each must look good and nothing may visibly jump when switching.
- **Must look good with zero EUR holdings** (the owner's real case), even though fixtures contain some.
- **Tunable server settings are visible** in Settings, grouped by topic, never hidden as "advanced".
- **American English** in UI and docs; en-US number formats; dates written with the month name ("14 Nov 2026"), never month-first numerics.
- Repo is public: no real holdings, account data, IPs or secrets in code, docs or screenshots. Design work uses fixture data only.
- **Undecided:** how multi-user or self-hosting for others would work (accounts, onboarding, packaging). Keep it possible; do not build it.

## Brand Commitments

- Name: **Investment Dashboard** (page title "Investment Overview"; home-screen title "Investments"). A `BrandMark` component exists.
- Voice: plain, calm, precise. Every metric carries a short ⓘ explanation; the user never needs to understand the maths to use the app.
- Standing bar from the v6 frontend brief: clearly professional and mature, not a hobby page.

## Evidence on Hand

- Fixture dev server (`npm run dev:fixtures` in `frontend/`) with synthetic portfolios; the offline demo in `web/`.
- In-app Help and `docs/user_guide.md`; product plans and decisions in `docs/v7_plan.md` and `docs/v6_frontend_design.md`.
- No testimonials, external users, press or benchmarks exist. Do not invent any.

## Product Principles

1. **Never blend currencies to look simpler.** Show market and FX effects apart and compute each currency natively; an honest, slightly more complex view beats a tidy wrong one.
2. **Every number earns trust.** Show freshness, explain each metric, flag estimates as estimates, and surface data problems calmly instead of hiding them.
3. **Holdings come first.** The portfolio and its holdings are the main column; lifetime FX and secondary analysis support them.
4. **Same product on every screen.** Phone gets the glance, desktop gets the depth, but neither loses information.
5. **Built for one, open to more.** Serve the owner's real workflow first without baking in anything that would stop another person from running their own copy.

## Accessibility & Inclusion

- **Protan-safe color is mandatory.** Gains and losses are blue / orange, never red / green. Every co-displayed color pair must stay distinguishable in a Machado 2009 protan simulation (CIEDE2000 ≥ 20; ≥ 15 for deutan and normal vision) in both themes, enforced by `frontend/src/styles/tokens.cvd.test.ts`. Never rely on color alone: secondary chart series are dashed, statuses carry an icon or label.
- WCAG AA contrast in light and dark themes, visible focus rings, keyboard shortcuts on desktop, tap targets of at least 44 px on phones.
