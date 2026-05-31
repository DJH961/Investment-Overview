# Investment Dashboard — User Guide

A plain-English guide to using the dashboard, with a control-by-control
walkthrough of the **Settings** page. This is the same content available in the
app under **Help** (the `?` icon in the top-right header, or **Settings → Help &
documentation**).

> You do **not** need to understand the maths to use the app. Every metric in
> the UI has a small ⓘ icon — hover it for a one-line explanation in context.

---

## 1. Quick start

1. **First launch** — the app notices an empty database and opens the
   onboarding screen. Choose:
   - **Seed default setup** to load the bundled example accounts (Vanguard,
     Fidelity, Savings Bank) and instruments, or
   - **Start empty / add manually** to build your own from Settings.
2. **Add your data** — import or enter your transactions so there is something
   to analyse.
3. **Pick your currency** — open **Settings → Display preferences** and choose
   **EUR** or **USD**.
4. **Explore** — browse **Overview** and **Analytics**. Hover any ⓘ icon to
   learn what a number means.
5. **Tune the metrics** — in **Settings → Analytics preferences**, set the
   benchmark and risk-free rate you want the risk metrics to use.

You can change everything later, so it is safe to experiment.

---

## 2. The pages

| Page | What it is for |
|---|---|
| **Overview** | Your portfolio at a glance: total value, gain, growth, and the headline returns (XIRR, TWR, CAGR). |
| **Deposits** | Every contribution and withdrawal — the cash you put in, kept separate from investment growth. |
| **Transactions** | The full ledger of buys, sells, dividends and fees. This is the source of truth everything is computed from. |
| **Monthly** | Performance broken down per calendar month. |
| **Yearly** | Performance broken down per calendar year. |
| **Analytics** | Deeper risk/performance metrics (Sharpe, Sortino, drawdown, beta, alpha, allocation drift). |
| **Projection** | Project your portfolio forward under different return, contribution and inflation assumptions. |
| **Calculator** | "I have €X to invest" — works out how many shares of each holding to buy to move toward your target allocation (buy-only rebalance). |
| **Settings** | Where you change how the app behaves — see the next section. |

---

## 3. Settings, explained control by control

The Settings page is organised top to bottom into the sections below.

### Display preferences

- **Primary display currency (EUR / USD)** — switches every page, KPI, table
  and chart between euros and dollars. It changes presentation only; it does
  **not** move money or alter your transactions. The choice is saved locally
  and persists across restarts.

### Analytics preferences

- **Benchmark symbol** — the market index your portfolio is compared against
  for Beta, Alpha and the comparison curve. Default: **VT** (Vanguard Total
  World). Type a ticker and press **Save**.
- **Risk-free symbol** — the yield used as the "risk-free" baseline by Sharpe,
  Sortino and Alpha. Default: **^IRX** (13-week US T-bill), fetched live. Use
  **Refresh now** to update the cached value.
- **Manual override** — pin the risk-free rate to a fixed value instead of the
  live feed. Enter it as a decimal fraction (`0.04` = 4%). Leave it blank (or
  clear it) to go back to the live ^IRX feed.

### Storage

A panel showing where your three database files live:

- **Ledger** — your source of truth (accounts, transactions).
- **Config** — your preferences and overrides.
- **Cache** — derived data; kept on the local device by default.

It also shows whether **encryption** is enabled and whether any file is inside
a detected **cloud-sync** folder (OneDrive, iCloud, Dropbox, Google Drive). The
tier paths themselves are read-only, but you **can** point the ledger and config
tiers at a **cloud / sync folder of your choice** here (for example a different
cloud provider, or a plain local folder) — the change takes effect on the next
restart. Use **Move ledger…** to physically relocate the ledger and config files
to a new folder (the app copies them with an integrity check and a safety backup,
removes the originals, and remembers the new location). You can also store the
SQLCipher **encryption passphrase** in your OS keychain and download an offline
**recovery file** so an encrypted ledger always has a key-recovery path.

### Data refresh

- **Refresh FX rates** — pull fresh EUR/USD rates.
- **Refresh prices** — pull the latest market prices. During market hours
  ETF and stock quotes update intraday (roughly every couple of minutes in
  the background), so values move through the day rather than only at the
  daily close; mutual-fund NAVs update about once a day when published.
- **Seed default setup** — add the bundled example accounts and instruments.
  Safe to run repeatedly: existing rows are skipped, only missing ones are
  added.

The app also refreshes in the background, so you usually only need these
buttons when you want the latest numbers immediately.

### Connectivity

Shows whether the last call to each data provider succeeded:

- **yfinance** — market prices.
- **Frankfurter** — FX rates.

Green means the provider responded. Expand **Recent activity** to see the most
recent attempts if a refresh is not behaving as expected.

### Accounts

Your brokerage and savings accounts.

- **Add account** — create a new one (broker, label, native currency, type).
- **Edit** — rename it, change its type, or mark it **inactive**. Inactive
  accounts are kept for history but excluded from the live view.

### Instruments

The funds, ETFs and cash lines you hold.

- **Add instrument** — register a ticker (symbol, name, asset class, category,
  native currency, optional expense ratio).
- **Edit** — change its name, category, asset class or expense ratio. The
  **expense ratio** is a decimal fraction (`0.0007` = 0.07%). **Categories**
  group instruments together in allocation views.

### Target allocations

Your desired mix of instruments, by percentage.

- **New allocation** — set a weight for each instrument; the weights must add up
  to **100%**.
- **Activate** — choose which allocation the drift metrics compare against. Only
  **one** allocation is active at a time.

### Help & documentation

A shortcut back to the in-app **Help** page (the same content as this guide).

### Developer tools

A collapsed panel with an **audit export**. Expand it and (if a developer
password is configured) enter it to unlock **Download audit export (JSON)**.
The export bundles every dashboard's computed figures — overview KPIs and
positions, deposits, the monthly and yearly tables, analytics and the
calculator — together with the **raw ledger** into one JSON file. Use it to
reconcile the app's totals and growth rates against an external source (for
example a spreadsheet) and pin down where they diverge. It is read-only and
never alters your data. Set `INV_DASHBOARD_DEV_PASSWORD` to require a password
here; leave it unset to keep the export ungated on a single-user machine.

---

## 4. Understanding the headline return metrics

You will see several different "return" numbers. They answer different
questions:

- **XIRR** — *your personal return*, accounting for **when** you deposited
  money. Best when contributions are irregular.
- **TWR (Time-Weighted Return)** — how the investments themselves grew,
  **ignoring** deposit timing. Best for comparing against an index.
- **CAGR** — the single constant growth rate that would take a **lump sum** from
  start to today. Simplest, but assumes one upfront investment.
- **YTD / MTD growth** — performance since 1 January / the 1st of this month,
  excluding new contributions.

For risk metrics (Sharpe, Sortino, drawdown, beta, alpha, etc.), hover the ⓘ
icon next to each on the Analytics page.

---

## 5. FAQ & troubleshooting

**A number looks wrong or out of date.**
Open **Settings → Data refresh** and click **Refresh prices** and **Refresh FX
rates**, then check **Settings → Connectivity** to confirm the providers
responded.

**I want to start over with example data.**
**Settings → Data refresh → Seed default setup** adds the bundled example
accounts and instruments. It is safe to run: existing rows are skipped.

**Where is my data, and is it private?**
Everything stays in local SQLite files on your machine — see **Settings →
Storage** for the exact paths. The app is single-user and local-first; nothing
is uploaded unless you place the files in a cloud-sync folder yourself.

**Can I use the app on my phone?**
Yes, on the same Wi-Fi: open `http://<laptop-LAN-IP>:8080` in your phone's
browser. See the README for the optional read-only JSON API and snapshot export
used by the mobile companion.

---

For installation, configuration and developer details, see the
[README](../README.md) and [`docs/architecture.md`](architecture.md).
