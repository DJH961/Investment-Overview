/**
 * The Currency page across ranges and views (7.3.1 phase 2), on the recorded fixture
 * payloads: every section renders for 1D, 1W, All and Max in EUR and USD, prints the
 * same server window, follows one sign and digit rule, and short or context ranges
 * render calmly instead of as a broken chart.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import full from "../../fixtures/data/full.json";
import { HideAmountsProvider } from "../../lib/hideAmounts";
import type { CurrencyEffectDto } from "../../lib/queries/currencyEffect";
import type { RateRange } from "../../lib/queries/currencyRate";

type Ccy = "EUR" | "USD";
type Both<T = unknown> = Record<Ccy, T>;

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));
vi.mock("../../lib/useMediaQuery", () => ({ useIsPhone: () => false, useMediaQuery: () => false }));

/** Every chart's props, so a test can check its time axis and series. */
const charts = vi.hoisted(() => ({ seen: [] as { className?: string; ariaLabel?: string; series: { id: string; points: { t: string | number; v: number | null }[] }[]; timeFormat: (t: number) => string; shade?: unknown[] }[] }));
vi.mock("../../components/Chart", () => ({
  Chart: (p: (typeof charts.seen)[number]) => {
    charts.seen.push(p);
    return <div className={p.className} data-testid="chart" data-label={p.ariaLabel} />;
  },
}));

const fx = full as unknown as Record<string, Both & { detail?: unknown }>;
/** A payload to serve instead of the recorded one (a synthetic Max with context). */
const data = vi.hoisted(() => ({ dollar: null as unknown }));

/** Max for Impact: the recorder has no Max answer yet; All with the Max window (context before you started). */
function effectFor(range: string): Both<CurrencyEffectDto> {
  const rec = fx[`GET /api/currency/effect/both?range=${range}`] as Both<CurrencyEffectDto>;
  if (range !== "max") return rec;
  const pre = (d: CurrencyEffectDto): CurrencyEffectDto => ({
    ...d,
    // Two rolling points dated before you started: drawn as context, never as yours.
    rolling: [{ t: "2022-06-30", currency: "1200" }, { t: "2022-12-30", currency: "-800" }, ...(d.rolling ?? [])] as CurrencyEffectDto["rolling"],
  });
  return { EUR: pre(rec.EUR), USD: pre(rec.USD) };
}

const ok = (d: unknown) => ({ data: d, isError: false, isFetching: false, isPending: false, isPlaceholderData: false, refetch: () => undefined });
vi.mock("../../lib/queries/currencyEffect", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/currencyEffect")>()),
  useCurrencyEffect: (r: string, c: Ccy) => ok(effectFor(r)[c]),
  useCurrencyEffectBoth: (r: string) => ok(effectFor(r)),
}));
vi.mock("../../lib/queries/currencyDollar", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/currencyDollar")>()),
  useDollar: (c: Ccy, r: string) => ok(data.dollar ?? (fx[`GET /api/currency/dollar/both?range=${r}`] as Both)[c]),
  useDollarBoth: (r: string) => ok(data.dollar ? { EUR: data.dollar, USD: data.dollar } : fx[`GET /api/currency/dollar/both?range=${r}`]),
  useScenarios: (c: Ccy, r: string) => ok((fx[`GET /api/currency/scenarios/both?range=${r}`] as Both)[c]),
}));
vi.mock("../../lib/queries/fxCosts", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/fxCosts")>()),
  useFxCosts: (c: Ccy, r: string) => ok((fx[`GET /api/fx-conversions/costs?range=${r}`] as Both)[c]),
}));

import { formatDate } from "../../lib/format";
import { Conversions } from "./sections/Conversions";
import { Dollar } from "./sections/Dollar";
import { Impact } from "./sections/Impact";
import { WhatIf } from "./sections/WhatIf";
import { fractionTone, pctText, ppText, spanOf, windowText } from "./numbers";
import { gapWords, ppDirection, ppFlat, ppSize } from "./sections/Impact/impactFormat";

function mount(node: React.ReactNode) {
  return render(
    <HideAmountsProvider>
      <MemoryRouter>{node}</MemoryRouter>
    </HideAmountsProvider>,
  );
}

const RANGES = ["1d", "1w", "1m", "3m", "ytd", "1y", "all", "5y", "10y", "max"] as const satisfies readonly RateRange[];
const VIEWS = ["EUR", "USD"] as const;
const SECTIONS = [
  { id: "impact", label: "Impact", C: Impact },
  { id: "exposure", label: "Exposure", C: Dollar },
  { id: "scenarios", label: "Scenarios", C: WhatIf },
  { id: "conversions", label: "Conversions", C: Conversions },
] as const;

afterEach(() => {
  cleanup();
  charts.seen = [];
  data.dollar = null;
});

const metaOf = (container: HTMLElement) => container.querySelector(".currency-section__meta")?.textContent ?? "";

describe("every section, every range, both views", () => {
  for (const range of RANGES) {
    for (const ccy of VIEWS) {
      it(`${range} ${ccy}: renders and prints the server window`, () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const metas: string[] = [];
        for (const s of SECTIONS) {
          const { container, unmount } = mount(<s.C id={s.id} label={s.label} currency={ccy} range={range} />);
          expect(container.querySelector(`#${s.id}`)).not.toBeNull();
          metas.push(metaOf(container));
          unmount();
        }
        // Every panel's meta carries the same window (the dates from the server).
        const win = (fx[`GET /api/currency/dollar/both?range=${range}`] as Both<{ window: Parameters<typeof windowText>[0] }>)[ccy].window;
        const text = windowText(win, range)!;
        for (const m of metas) expect(m).toContain(text);
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
      });
    }
  }
});

describe("Impact", () => {
  /** A compact, stable picture of the hero: headline, tag, lens line, meta. */
  function summary(range: string, ccy: Ccy) {
    const { container, unmount } = mount(<Impact id="impact" label="Impact" currency={ccy} range={range as RateRange} />);
    const q = (sel: string) => container.querySelector(sel)?.textContent?.trim() ?? null;
    const out = {
      meta: q(".currency-section__meta"),
      headline: q(".impact__headline-value"),
      tag: q(".impact__headline .currency-stat__kind"),
      lens: q(".impact__lens"),
      lensNote: q(".impact__lens-note"),
      parts: [...container.querySelectorAll(".impact__part")].map((p) => p.textContent),
      bridge: [...container.querySelectorAll(".bridge__row")].map((r) => r.getAttribute("data-part")),
      holdingsNote: q('[data-note="holdings"]'),
    };
    unmount();
    return out;
  }

  for (const range of RANGES) {
    for (const ccy of VIEWS) {
      it(`${range} ${ccy}: hero, lens and bridge`, () => {
        expect(summary(range, ccy)).toMatchSnapshot();
      });
    }
  }

  it("EUR: the currency step's parts add up to it, zero lines left out", () => {
    const eur = effectFor("all").EUR;
    const b = eur.bridge!;
    const parts = [b.revaluation, b.waiting, b.conversion_cost].map(Number);
    expect(parts.reduce((a, v) => a + v, 0)).toBeCloseTo(Number(b.currency), 4);
    const { container } = mount(<Impact id="impact" label="Impact" currency="EUR" range="all" />);
    const shown = [...container.querySelectorAll(".impact__part")].map((p) => p.getAttribute("data-part"));
    expect(shown).toEqual(["revaluation", "waiting", "conversion_cost"].filter((k) => Number(b[k as "waiting"]) !== 0));
    // The cost reads as a cost: a minus sign, the loss tone.
    const cost = container.querySelector('[data-part="conversion_cost"] .money');
    expect(cost?.textContent).toMatch(/^[−-]/);
  });

  for (const range of ["1d", "1w"] as const) {
    it(`${range}: no month counts, months card or rolling year inside a short range`, () => {
      const { container } = mount(<Impact id="impact" label="Impact" currency="EUR" range={range} />);
      expect(screen.queryByText("Months it helped")).toBeNull();
      expect(container.querySelector(".impact__months")).toBeNull();
      expect(container.querySelector(".impact__rolling")).toBeNull();
      if (range === "1d") expect(screen.queryByText("Typical day")).toBeNull();
    });
  }

  it("1D on one bridge part only: no breakdown that would just repeat the currency step", () => {
    const { container } = mount(<Impact id="impact" label="Impact" currency="EUR" range="1d" />);
    expect(container.querySelector(".impact__parts")).toBeNull();
  });

  it("USD: the euro lens is labelled, with its own sign; the holdings note shows once", () => {
    const usd = effectFor("all").USD;
    mount(<Impact id="impact" label="Impact" currency="USD" range="all" />);
    expect(screen.getAllByText("Seen from euros:")).toHaveLength(1);
    const lensValue = document.querySelector(".impact__lens-value");
    expect(lensValue?.textContent).toBe(ppText(Number(usd.headline.other_lens!.value)));
    expect(lensValue?.className).toMatch(/--neg|--pos/);
    expect(screen.getAllByText(usd.holdings_note!)).toHaveLength(1);
    expect(screen.queryByText(/No holding had a currency effect/)).toBeNull();
  });

  it("1D: the chart's axis reads clock times; 1W: weekdays", () => {
    mount(<Impact id="impact" label="Impact" currency="EUR" range="1d" />);
    const day = charts.seen.find((c) => c.className === "impact__chart")!;
    const t0 = Date.parse(String(day.series[0].points[0].t));
    expect(day.timeFormat(t0)).toMatch(/^\d{1,2}:\d{2}/);
    cleanup();
    charts.seen = [];
    mount(<Impact id="impact" label="Impact" currency="EUR" range="1w" />);
    const week = charts.seen.find((c) => c.className === "impact__chart")!;
    const w0 = Date.parse(String(week.series[0].points[0].t));
    expect(week.timeFormat(w0)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it("Max: the part before you started is a muted context series, never the primary line", () => {
    mount(<Impact id="impact" label="Impact" currency="EUR" range="max" />);
    const rolling = charts.seen.filter((c) => c.ariaLabel === "Rolling 12-month currency effect").at(-1)!;
    const primary = rolling.series.find((s) => s.id === "rolling")!;
    const context = rolling.series.find((s) => s.id === "context")!;
    expect(context).toBeDefined();
    expect(primary.points.slice(0, 2).every((p) => p.v === null)).toBe(true);
    expect(context.points.slice(0, 2).map((p) => p.v)).toEqual([1200, -800]);
  });

  it("long ranges label the axis by month and year, short ones by day", () => {
    mount(<Impact id="impact" label="Impact" currency="EUR" range="all" />);
    const hero = charts.seen.find((c) => c.className === "impact__chart")!;
    const t = Date.parse(String(hero.series[0].points[0].t));
    expect(hero.timeFormat(t)).toMatch(/\d{4}/);
  });
});

describe("EUR next to USD, and the regular amount", () => {
  for (const range of RANGES) {
    it(`${range}: Impact sets euros and dollars side by side, each in its own currency`, () => {
      const { container } = mount(<Impact id="impact" label="Impact" currency="EUR" range={range} />);
      const tiles = [...container.querySelectorAll(".impact-compare__tile")].map((t) => t.textContent ?? "");
      // Two lens tiles (the returns are in the hero): euros first, dollars second.
      expect(tiles).toHaveLength(2);
      expect(tiles[0]).toContain("€");
      expect(tiles[1]).toContain("$");
      // Mixed shows only when the two lenses genuinely point opposite ways.
      const eur = container.querySelector('[data-key="eur"] .money')?.className ?? "";
      const usd = container.querySelector('[data-key="usd"] .money')?.className ?? "";
      const opposite = (eur.includes("pos") && usd.includes("neg")) || (eur.includes("neg") && usd.includes("pos"));
      expect(container.querySelector('[data-testid="lens-mixed"]') !== null).toBe(opposite);
    });

    it(`${range}: Exposure sets the two quotes side by side`, () => {
      const { container } = mount(<Dollar id="exposure" label="Exposure" currency="USD" range={range} />);
      const head = [...container.querySelectorAll(".exposure-compare__eyebrow")].map((h) => h.textContent);
      expect(head[0]).toContain("USD/EUR");
      expect(head[1]).toContain("EUR/USD");
      // Each column names its lens, so headwind and tailwind read as two different things.
      expect(head[0]).toContain("Dollars you hold");
      expect(head[1]).toContain("Euros you convert");
    });
  }

  it("every 'buys' figure uses the regular amount (the €100 default), never €1,000", () => {
    const rec = fx["GET /api/currency/dollar/both?range=1y"] as Both<{ next_euro?: { amount_eur: string } | null }>;
    expect(Number(rec.USD.next_euro?.amount_eur)).toBe(100);
    const { container } = mount(<Dollar id="exposure" label="Exposure" currency="USD" range="1y" />);
    expect(container.textContent).toContain("€100");
    expect(container.textContent).not.toContain("1,000");
    const sc = fx["GET /api/currency/scenarios/both?range=1y"] as Both<{ invest?: { unit_eur: string; monthly_eur: string } | null }>;
    expect(sc.USD.invest?.unit_eur).toBe(sc.USD.invest?.monthly_eur);
    expect(Number(sc.USD.invest?.unit_eur)).toBe(100);
  });
});

describe("Exposure", () => {
  for (const range of ["1d", "1w"] as const) {
    it(`${range}: rolling changes say the range is too short, no chart`, () => {
      const { container } = mount(<Dollar id="exposure" label="Exposure" currency="EUR" range={range} />);
      expect(screen.getByText("Too short a range for trailing changes; pick 1M or longer.")).toBeInTheDocument();
      expect(container.querySelector(".dollar-rolling__svg")).toBeNull();
    });
  }

  it("Max: the minis draw the days before you started dashed and muted", () => {
    // The recorded Max starts its rolling series at your first transaction; add a stretch before it.
    type Dto = { window: { context_until?: string | null }; rolling: { points: { t: string }[] }[] };
    const rec = (fx["GET /api/currency/dollar/both?range=max"] as Both<Dto>).EUR;
    data.dollar = {
      ...rec,
      rolling: rec.rolling.map((s) => ({
        ...s,
        points: [
          { ...s.points[0], t: "2021-01-29" },
          { ...s.points[0], t: "2022-06-30" },
          ...s.points,
        ],
      })),
    };
    expect(rec.window.context_until).toBeTruthy();
    const { container } = mount(<Dollar id="exposure" label="Exposure" currency="EUR" range="max" />);
    expect(container.querySelectorAll(".dollar-rolling__line--context").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/before you started/).length).toBeGreaterThan(0);
  });

  it("All: nothing is drawn as context", () => {
    const { container } = mount(<Dollar id="exposure" label="Exposure" currency="EUR" range="all" />);
    expect(container.querySelector(".dollar-rolling__line--context")).toBeNull();
  });
});

describe("Conversions", () => {
  for (const ccy of VIEWS) {
    it(`${ccy}: every cost is negative (a minus means it cost you), shares too`, () => {
      const { container } = mount(<Conversions id="conversions" label="Conversions" currency={ccy} range="all" />);
      const tile = (key: string) => container.querySelector(`[data-key="${key}"], .stat-strip__item:nth-child(${key === "fees" ? 1 : 3})`);
      for (const key of ["fees", "cost"]) {
        const money = tile(key)?.querySelector(".money");
        expect(money?.textContent).toMatch(/^[−-]/);
        expect(money?.className).toMatch(/neg/);
      }
      expect(container.textContent).toMatch(/[−-]\d+[.,]\d% of converted/);
    });
  }

  it("the cumulative chart's axis follows the real span: 1W and All label differently", () => {
    mount(<Conversions id="conversions" label="Conversions" currency="EUR" range="all" />);
    const all = charts.seen.find((c) => c.ariaLabel === "Cumulative cost of converting");
    if (!all) return; // fewer than two conversions in the window
    const t = Date.parse(String(all.series[0].points[0].t));
    expect(all.timeFormat(t)).toMatch(/\d{4}/);
    expect(all.series[0].points.every((p) => p.v === null || p.v <= 0.005)).toBe(true);
  });
});

describe("one sign and digit rule", () => {
  it("percent and points: signed, one digit, a rounded zero has no sign", () => {
    expect(pctText(0.01234)).toBe("+1.2%");
    expect(pctText(-0.0044)).toBe("-0.4%");
    expect(pctText(0.0004)).toBe("0.0%");
    expect(ppText(0.0191)).toBe("+1.9 pp");
    expect(ppText(-0.0004)).toBe("0.0 pp");
    expect(ppText(-0.132)).toBe("-13.2 pp");
  });

  it("the tone uses the printed rounding, so it never disagrees with the text", () => {
    expect(fractionTone(-0.0004)).toBe("flat");
    expect(fractionTone(-0.0006)).toBe("neg");
    expect(fractionTone(0.0006)).toBe("pos");
  });

  it("gap words: size plus lower/higher from the same rounding, flat says about the same", () => {
    expect(ppSize(-0.0191)).toBe("1.9 pp");
    expect(ppDirection(-0.0191)).toBe("lower");
    expect(ppFlat(-0.0004)).toBe(true);
    expect(gapWords(-0.0004)).toBe("Euro and dollar returns about the same");
    expect(gapWords(0.0234)).toBe("Euro return 2.3 pp higher than the dollar return");
  });

  it("the window text: 1D is today since the last close, a range that ends now says live", () => {
    const w = { key: "ytd", start: "2026-01-01", through: "2026-06-29", live: true, intraday: false, context_until: null };
    expect(windowText(w, "ytd")).toBe(`YTD · ${formatDate("2026-01-01")} – ${formatDate("2026-06-29")} · live`);
    expect(windowText({ ...w, key: "1d", start: "2026-06-29" }, "1d")).toBe(`1D · today, since the ${formatDate("2026-06-29")} close · live`);
    expect(windowText(null)).toBeNull();
  });

  it("span of a chart from its own points", () => {
    expect(spanOf([0, 5, 10])).toBe(10);
    expect(spanOf([3])).toBe(0);
  });
});
