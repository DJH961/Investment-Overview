# Tiingo Forex (FX) fallback — findings & implementation notes

> Status: **investigated, not yet built.** A follow‑up idea captured for later
> implementation. The core price fallback (desktop + web, equities/NAV via the
> Tiingo **IEX** endpoint) is already implemented — see `tiingo_fallback_plan.md`.
> This doc covers extending that same secondary‑provider idea to the **home‑currency
> FX rate** (USD→EUR), which currently has no secondary source on either stack.
>
> Written 2026‑06‑23. All API responses below were captured **live** on that date
> against the real account token.

## TL;DR

- **Yes — your Tiingo plan includes Forex.** USD→EUR is available and was verified
  live (HTTP 200, real quotes).
- Tiingo only quotes the **`eurusd`** direction. The inverse pair `usdeur` returns
  an **empty array** (`[]`), *not* an error — so to get USD→EUR you read `eurusd`
  and **invert** (`USD→EUR = 1 / eurusd_mid`).
- FX uses a **separate endpoint family** (`tiingo/fx/...`), distinct from the
  `iex/` route the Worker proxies today. Wiring it in is therefore net‑new work:
  a Worker route + a small client path + an inversion step. Cheap and simple —
  no NAV‑late / market‑calendar complexity (FX quotes continuously).

## Motivation

The equity/NAV fallback (Tiingo behind yfinance on desktop, behind Twelve Data on
web) closed the single‑provider risk for **instrument prices**. But the **home
currency conversion** (USD→EUR), used to translate the whole portfolio into the
display currency, still rides on a **single FX source**. If that source has an
outage or a stale‑rate glitch (exactly the FSKAX‑style failure that started this
whole effort), the entire portfolio's converted value is wrong with no backup.

Tiingo's FX feed is a natural, already‑paid‑for secondary source for that rate.

## Live evidence (2026‑06‑23, real token)

### 1. Live top‑of‑book — `GET /tiingo/fx/top?tickers=eurusd`

```
HTTP 200
[{
  "ticker": "eurusd",
  "quoteTimestamp": "2026-06-23T16:06:52.450000+00:00",
  "bidPrice": 1.13818,
  "bidSize": 1000000.0,
  "askPrice": 1.13819,
  "askSize": 1000000.0,
  "midPrice": 1.138185
}]
```

→ Live EUR/USD mid **1.138185**. So **USD→EUR = 1 / 1.138185 = 0.87859**.

### 2. Inverse pair — `GET /tiingo/fx/top?tickers=usdeur`

```
HTTP 200
[]
```

→ Empty array, **not** an error. Tiingo doesn't quote the inverted direction;
always request `eurusd` and invert.

### 3. Daily history — `GET /tiingo/fx/eurusd/prices?startDate=2026-06-19&resampleFreq=1day`

```
HTTP 200
[
  {"date":"2026-06-19T00:00:00.000Z","ticker":"eurusd","open":1.145835,"high":1.14808, "low":1.141795,"close":1.146945},
  {"date":"2026-06-21T00:00:00.000Z","ticker":"eurusd","open":1.146945,"high":1.146945,"low":1.14515, "close":1.146255},
  {"date":"2026-06-22T00:00:00.000Z","ticker":"eurusd","open":1.146270,"high":1.14737, "low":1.14190, "close":1.142680},
  {"date":"2026-06-23T00:00:00.000Z","ticker":"eurusd","open":1.142675,"high":1.143195,"low":1.141875,"close":1.142905}
]
```

→ Clean daily OHLC. Usable to back up a **daily‑close** FX rate as well as the
live rate. (Note weekends/holidays are simply absent — 20 Jun was a Saturday.)

## Endpoint reference

| Need | Endpoint | Returns |
|---|---|---|
| Live rate | `GET https://api.tiingo.com/tiingo/fx/top?tickers=eurusd` | `bidPrice`, `askPrice`, `midPrice`, `quoteTimestamp` |
| Daily history | `GET https://api.tiingo.com/tiingo/fx/eurusd/prices?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&resampleFreq=1day` | per‑day OHLC |
| Intraday history | same `/prices` path with `resampleFreq=1hour` / `5min` etc. | per‑bar OHLC |

Auth (every call): header `Authorization: Token <TIINGO_TOKEN>` — **never** the
token in the URL. Pair tickers are lowercase concatenations: `eurusd`, `gbpusd`,
`usdjpy`, … Only the quoted direction works; invert for the rest.

## How to use it — implementation sketch

The pattern mirrors the existing equity/NAV fallback. **Read `eurusd`, invert to
USD→EUR.** Both stacks share the same shape.

### Desktop (Python)

1. **Client** — add an FX method to the Tiingo adapter (`adapters/tiingo_client.py`),
   e.g. `fetch_fx_rate(base="USD", quote="EUR")`:
   - Map the requested base/quote to Tiingo's quoted pair. For USD↔EUR that's
     `eurusd`; if `base==USD` (we want USD→EUR), fetch `eurusd` and return
     `1 / midPrice`. If `base==EUR` (EUR→USD), return `midPrice` directly.
   - Parse `midPrice` (fall back to `(bid+ask)/2`, then `bidPrice`).
2. **Gate** — the existing FX rate has its own freshness/TTL. Trigger Tiingo only
   when the **primary FX source failed or is stale** (same "worth‑it" idea as
   `marketSymbolEligible`). FX needs **no** NAV/market‑calendar gating — it quotes
   ~24×5, so a simple "primary failed AND held rate is older than today's settled
   FX session" check is enough. It costs **1 call**, so budget pressure is trivial;
   still count it against the same daily Tiingo budget for accounting.
3. **Wiring** — call it from wherever the home‑currency rate is refreshed
   (the FX refresh path, parallel to `refresh_due_prices`), and fold the recovered
   rate in like any other fallback result. Reuse the keyring token
   (`investment-dashboard` / `tiingo-token`) already in place.

### Web (TypeScript + Worker)

1. **Worker route** — extend `web/proxy/worker.js`. The `/price` route currently
   builds only `iex/` and `tiingo/daily/...` URLs. Add an FX branch to
   `buildTiingoUrl` that, on an `fx=<pair>` param, builds a **pinned**
   `https://api.tiingo.com/tiingo/fx/top?tickers=<pair>` URL — validating `<pair>`
   against the same strict ticker charset (lowercase letters only is even safer:
   `/^[a-z]{6}$/`). Token still injected server‑side as the `Authorization` header.
   - Optional: a daily variant for historical FX (`tiingo/fx/<pair>/prices`).
2. **Client** — add `fetchTiingoFx(pair, proxyUrl)` in `web/src/tiingo.ts`,
   mirroring `fetchTiingoQuotes`: GET `?fx=eurusd`, parse `midPrice`, return the
   inverted USD→EUR Decimal. Browser stays Tiingo‑keyless (token only in Worker).
3. **Gate / budget** — reuse the web budget machinery (`tiingo-gate.ts`,
   `cache.ts` ET‑reset credit log). FX is one cheap call with no NAV tiering;
   gate it purely on "primary FX failed/stale AND a newer FX session exists."
4. **Config** — no new setting needed; FX hangs off the **same** `/price` Worker,
   so the existing `priceProxyUrl` derivation already points at it.

## Gotchas / decisions to make later

- **Direction & inversion.** Always request the **quoted** pair (`eurusd`) and
  invert for USD→EUR. Don't request `usdeur` — it silently returns `[]`.
- **bid/ask vs mid.** Use `midPrice` for a neutral rate. Decide whether the app's
  convention wants mid (recommended) or a specific side.
- **Decimal precision.** Invert with the project's `Decimal` (not JS float) to keep
  the converted‑portfolio total exact, matching how prices are already handled.
- **Weekends/holidays.** FX history omits non‑trading days; the live `/top`
  endpoint keeps quoting into Friday evening / over the weekend at the last rate.
  Apply the same "settled session" notion you use for the primary FX source.
- **Budget accounting.** Count FX probes against the shared Tiingo daily budget so
  the 20/80 desktop/web split stays honest, even though FX is only ~1 call.
- **Multi‑currency.** Only USD↔EUR is needed today. The same invert‑the‑quoted‑pair
  rule generalises to any future display currency.

## Security note

The raw token was used **only** locally for the live test and stored to the OS
keyring (`investment-dashboard` / `tiingo-token`). Because it was pasted into a
chat transcript during testing, **rotate the Tiingo token** at tiingo.com when
convenient, then re‑store it (desktop keyring + `wrangler secret put TIINGO_TOKEN`).
