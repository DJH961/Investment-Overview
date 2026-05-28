# Mobile companion app — proposal & technical design

> **Status:** proposal. Phases 1 & 2 (the Python-side shared read-model
> layer + delivery channels) are **implemented** in this change; the
> Android client (Phase 3) and APK packaging (Phase 4) are described here
> for sign-off before any mobile code is written.

## 1. Goal

A read-only Android companion to the Investment Dashboard: *check my
investments on the go*. Modern, native look and feel; the **same numbers
and logic** as the desktop web app. The guiding constraint is that
business logic stays in **one place** (Python) so a change to a metric or
rule flows to both the web UI and the phone automatically.

## 2. How "shared logic" is achieved

The desktop app is cleanly layered: `domain/` (pure math) → `services/`
(orchestration) → per-page query helpers → `ui/` (NiceGUI). The phone
cannot run Python, so the seam between "compute" and "present" is made
explicit and reused:

```
        domain/  +  services/  +  query helpers      ← single source of truth
                          │
                  readmodels/   (UI-agnostic, JSON-serializable)
                          │
        ┌─────────────────┼──────────────────────────┐
        ▼                 ▼                           ▼
   FastAPI /api      export-snapshot → file      NiceGUI web app
   (live, LAN/VPN)   (cloud-synced JSON)          (existing)
        │                 │
        └──────┬──────────┘
               ▼
        Android app (Kotlin + Jetpack Compose)
```

* **`readmodels/`** (new) serializes the output of the existing
  `domain`/`services` compute into plain JSON-native structures. It adds
  **no** business logic — it only shapes existing results — so the web UI
  and the phone can never disagree about a number.
* Both delivery channels (`/api` and the exported file) call the **same**
  `readmodels.build_snapshot()`, so they cannot drift from each other.

Decimals are serialized as **strings** (e.g. `"1234.50"`) to preserve
precision in transit; the client parses them into `BigDecimal`. Dates are
ISO-8601 strings. `None` → JSON `null`.

## 3. Data delivery — consumer-cloud sync (option **d**)

The chosen model: the laptop periodically writes the full snapshot JSON
into a folder the user's existing **consumer-cloud auto-sync** app
(OneDrive / iCloud / Dropbox / Google Drive) already mirrors. The phone's
sync app pulls the freshest copy; the app reads it **offline**, for a
local feel and **no always-on server**.

* `inv-dashboard-export-snapshot` writes the snapshot atomically
  (temp file + rename) so the sync agent never uploads a half-written
  file. Default destination: `mobile_snapshot.json` beside the config
  tier (so it inherits the sync the user already set up), overridable with
  `--output` or `INV_DASHBOARD_SNAPSHOT_PATH`.
* Schedule it however suits you (Windows Task Scheduler, a `--refresh`
  run after market close, or on demand). `--refresh` first pulls fresh
  FX/prices; without it the export is fully offline.

The **live `/api`** channel is also provided (same data) for when the
laptop is reachable — useful on the LAN, or later via a VPN — but it is
**not required** for the option-d experience.

## 4. JSON contract (schema v1)

Top-level snapshot document (`GET /api/snapshot` or the exported file):

| Key | Contents |
|---|---|
| `meta` | `schema_version`, `app_version`, `generated_at` (UTC ISO), `as_of`, `base_currency` (`"EUR"`), `display_currency`, `fx_rate_eur_to_display`, `fx_rate_eur_usd` |
| `overview` | `metrics` (KPI quartet: total value, contributions, dividends, capital gain, growth %, XIRR, YTD variants), `positions[]`, `allocation[]` |
| `deposits` | `summary` (contribution KPIs), `rows[]` (raw cash-flow rows) |
| `transactions` | `rows[]` (raw ledger rows incl. `net_eur`/`net_usd`) |
| `monthly` / `yearly` | `rows[]` (per-period contributions, dividends, interest, opening/closing value, growth %, plus FX-aware `*_display` fields) |
| `analytics` | equity `curve[]`, risk metrics (CAGR/TWR/XIRR, vol, Sharpe, Sortino, max drawdown, Calmar, Ulcer, VaR/CVaR, skew, kurtosis, beta, alpha), `attribution[]` |
| `calculator` | `scenarios[]` + `yearly[]`/`monthly[]` projection rows |

Every value that cannot be computed (sparse history, no benchmark/risk-free
data, empty DB) is `null`; the contract is stable on a brand-new database.

Individual sections are also available as their own endpoints
(`/api/overview`, `/api/deposits`, …) for lighter requests; `/api/health`
is an unauthenticated liveness/version probe so a client can discover
`schema_version` before sending a token.

`schema_version` (`readmodels.SCHEMA_VERSION`) must be bumped on any
breaking shape change; the client should refuse a major mismatch and
prompt the user to update.

## 5. Security — minimal but real

Per the single-user, local-first design, the safety is deliberately
light-weight but sufficient:

* **Optional bearer token.** `INV_DASHBOARD_API_TOKEN` guards every `/api`
  route except `/health`; sent as `Authorization: ****** or
  `X-API-Token`. Compared in constant time. **Off by default** so the
  current LAN experience is unchanged; turn it on the moment the server
  is reachable beyond the LAN.
* **Read-only API.** No write endpoints exist, so a leaked token cannot
  mutate the ledger.
* **Encryption at rest already exists** for the synced tiers (SQLCipher);
  the exported snapshot is plain JSON, so treat the sync folder as
  sensitive (the cloud providers encrypt in transit and at rest on their
  side).
* **Recommended exposure path (future):** a mesh VPN such as Tailscale, so
  the phone reaches `/api` without opening any port to the internet. TLS
  via a reverse proxy if ever exposed publicly.

## 6. Android client (Phase 3) — Kotlin + Jetpack Compose

Recommended stack — the modern, idiomatic, "worth learning" Android path:

| Concern | Choice | Why |
|---|---|---|
| Language | **Kotlin** | The standard for Android; concise, null-safe. |
| UI | **Jetpack Compose** + **Material 3** | Declarative (like React/SwiftUI), dynamic color/dark theme out of the box — gives the "modern look" with little effort. |
| Architecture | **MVVM** (ViewModel + `StateFlow`) | Google's recommended app architecture; testable. |
| Data source (option d) | **Storage Access Framework** | Let the user pick the cloud-synced `mobile_snapshot.json` via the system file picker; read it offline. |
| Data source (live) | **Retrofit** + **OkHttp** + **kotlinx.serialization** | Typed access to `/api` when reachable; token added via an OkHttp interceptor. |
| Numbers | **`java.math.BigDecimal`** | Parse the string-encoded decimals losslessly. |
| Charts | **Vico** (or Compose canvas) | Equity curve, allocation donut, period bars. |
| Local cache | **DataStore** (or a small Room table) | Remember the last good snapshot + chosen source. |
| Build/APK | **Gradle** + Android Studio; signed release APK | Side-load your own APK; no Play Store needed. |

Screen plan (mirrors the web pages; ship in priority order):

1. **Overview** — KPI cards, allocation chart, positions list (the
   "on the go" essentials).
2. **Monthly / Yearly** — period tables + growth.
3. **Transactions / Deposits** — searchable lists.
4. **Analytics** — equity curve + risk metrics.
5. **Calculator** — projection scenarios.

A read-only **EUR/USD/DKK display toggle** uses the `fx_rate_*` values in
`meta` to convert the EUR figures client-side.

### Learning path (you're new to Android)

1. Android Studio + the official *Now in Android* sample (canonical
   Compose + MVVM reference).
2. Build the Overview screen against a **checked-in sample snapshot**
   (no networking) to learn Compose first.
3. Add the file-picker (option d) reader, then optionally Retrofit for the
   live `/api`.
4. Layer in the remaining screens, theming, and charts.

## 7. APK packaging (Phase 4)

* Generate a signing keystore; build a signed **release APK** in Android
  Studio (or `./gradlew assembleRelease`).
* Distribute by side-loading (copy the APK to the phone, or host it
  privately). No Play Store account required for personal use.
* Optional later: a tiny in-app update check against a private URL,
  mirroring the desktop installer's self-update.

## 8. What this change delivers now (Phases 1 & 2)

* `readmodels/` — shared, UI-agnostic, JSON-serializable read-models +
  full-snapshot assembler (`SCHEMA_VERSION = 1`).
* Refactor of the deposits/transactions query helpers to separate
  raw-fetch from display-formatting (so both front-ends share the fetch).
* `api/` — read-only FastAPI app (`create_app`, `mount_api`), optional
  token auth, `inv-dashboard-api` script; auto-mounted on the NiceGUI
  server when `INV_DASHBOARD_API_ENABLED=true`.
* `inv-dashboard-export-snapshot` — atomic JSON export for option-d cloud
  delivery.
* Config + `.env.example` keys: `API_ENABLED`, `API_TOKEN`,
  `SNAPSHOT_PATH`.
* Tests for serialization, every read-model section, the snapshot, all API
  routes, token auth, and the export CLI.

## 9. Open follow-ups (not in this change)

* The Android app itself (Phase 3) and APK pipeline (Phase 4).
* A Settings → "Mobile" panel in the web UI to show the snapshot path,
  trigger an export, and generate/rotate the API token.
* Optional: encrypt the exported snapshot (vs. relying on the cloud
  provider's at-rest encryption) if the sync folder is considered
  untrusted.
