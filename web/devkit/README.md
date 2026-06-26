# devkit — data-pulling test harness

A lightweight, **no-UI** framework for exercising the companion's live-data
pulling without a browser, a real Twelve Data / Tiingo key, or a real network.
Data pulling is the no.1 thing to debug here, so this lets you **preset a cache
condition and a blob/provider condition, see what the system *would* pull, then
answer as Twelve Data / Tiingo / Frankfurter and watch how the real fetchers
react.**

It drives the *actual* production code — `data-orchestrator.ts`, `quotes.ts`,
`blob.ts`, `cache.ts` — with the clock, storage and network injected, so what you
observe is exactly what the app would do.

## Run it

```bash
cd web
npm run data-pull            # list the built-in scenarios
npm run data-pull -- all     # run every scenario
npm run data-pull -- stale-quotes blob-304   # run specific scenarios
```

Each run prints, per scenario:

- **PLAN** — what `data-orchestrator.planPull` would pull for the given freshness.
- **REQUESTS** — every call the real fetchers made through the fake providers,
  with HTTP status, symbols, conditional validators, and the Twelve Data credit
  cost.
- **QUOTES / FX / EUR-USD / BLOB** — how each symbol/leg resolved (fetched, from
  cache, deferred for budget, failed) and the budget left afterwards.

> Runs on plain Node (22+) via `--experimental-transform-types` plus a tiny
> resolve hook in `devkit/ts-resolve-hook.mjs`. No new dependencies.

## The pieces

| File | Role |
| --- | --- |
| `src/devkit/fake-provider.ts` | `FakeProvider` — one injectable `FetchLike` that simulates the blob server, Twelve Data (`/quote`, `/time_series`), Frankfurter and Tiingo, and records every request. |
| `src/devkit/harness.ts` | `MemoryStorage` + `runScenario` / `formatResult` — seeds the cache with the real `cache.ts` writers, runs the plan and/or a real fetcher, returns a structured + printable result. |
| `src/devkit/scenarios.ts` | The built-in `SCENARIOS` library (worked examples). |
| `src/devkit/cli.ts` | The CLI entry point behind `npm run data-pull`. |

## Write your own scenario

A `Scenario` declares the three things you want to preset, then either a pull
**decision** (`plan`) and/or a real **execution** (`run`):

```ts
import { runAndFormat, type Scenario } from "../src/devkit/harness";
import { recordCredits } from "../src/cache";

const scenario: Scenario = {
  name: "my-repro",
  nowMs: Date.parse("2024-01-10T15:00:00Z"),
  // 1) cache condition — seed with the real cache.ts writers
  seedCache: (storage, now) => recordCredits(799, now - 3_600_000, storage),
  // 2) blob / provider condition — what each upstream answers
  provider: {
    twelveData: { quotes: { AAPL: { close: "190", previous_close: "188", currency: "USD" } } },
  },
  // 3a) the decision: what WOULD the orchestrator pull?
  // plan: { kind: "auto", nowMs, market: "open", ... },
  // 3b) the execution: run the real fetcher and observe
  run: { kind: "quotes", symbols: ["AAPL"], options: { forceMarketFetch: true } },
};

console.log(await runAndFormat(scenario));
```

Use it the same way from a Vitest test (`test/devkit.test.ts` has examples) —
`runScenario` returns a structured `ScenarioResult` you can assert on. This makes
it equally useful for a coding agent reproducing and fixing a data-pull bug.

## What you can preset

- **Cache condition** (`seedCache`): cached quotes/ages, FX, the encrypted blob +
  HTTP validators, and the credit-spend log — anything in `cache.ts`.
- **Blob condition** (`provider.blob`): the envelope, the `portfolio.meta.json`
  version sidecar, `ETag` / `Last-Modified` (drives conditional 304s), or a forced
  HTTP status (404 "not published", 500, …).
- **Provider condition**: per-symbol Twelve Data `quotes` / `series`, or a forced
  whole-call error (`429` rate-limit, `401`/`403` bad key); Frankfurter `rates`;
  a Tiingo `body`/`status`.

This folder is **dev-only**: nothing in the shipped app imports it, so it is never
bundled into the site by Vite.
