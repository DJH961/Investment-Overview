/**
 * Phase 4 compute tests: the live current-period overlay, the analytics/deposits
 * mapping, and the forward-projection calculator (which mirrors the Python
 * `ui/pages/_projection_query.project`).
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import type { OverviewView } from "../src/compute";
import {
  buildAnalytics,
  buildDeposits,
  buildPeriods,
  buildPlan,
  projectForward,
} from "../src/phase4";
import type { MobileExport } from "../src/types";

function baseExport(extra: Partial<MobileExport> = {}): MobileExport {
  return {
    meta: {
      schema_version: 1,
      app_version: "test",
      generated_at: "2026-06-19T08:00:00+00:00",
      as_of: "2026-06-19",
      display_currency: "EUR",
      fx_pivot: "EUR",
      fx_rate_eur_usd: "1.08",
      currency_note: "",
    },
    holdings: [],
    portfolio_cashflows: [],
    cash: [],
    period_openings: { month_start_value_eur: "0", year_start_value_eur: "0", holdings: {} },
    ...extra,
  };
}

function overview(extra: Partial<OverviewView> = {}): OverviewView {
  return {
    generatedAt: "2026-06-19T08:00:00+00:00",
    asOf: "2026-06-19",
    liveAsOf: null,
    liveAsOfFallbackDate: "2026-06-19",
    lastDataPullAt: null,
    totalValueEur: new Decimal("39000"),
    cashValueEur: new Decimal(0),
    totalCostBasisEur: new Decimal(0),
    totalGainEur: new Decimal(0),
    totalGainPct: null,
    todayMoveEur: new Decimal(0),
    todayMovePct: null,
    todayFxMoveEur: new Decimal(0),
    eurUsdSource: "none",
    fxRateEurUsdPrev: null,
    mtdGrowthPct: new Decimal("0.05"),
    ytdGrowthPct: new Decimal("0.11"),
    portfolioXirr: null,
    totalGrowthCompoundedPct: null,
    totalValueUsd: null,
    totalCostBasisUsd: null,
    totalGainUsd: null,
    totalGainPctUsd: null,
    todayMoveUsd: null,
    mtdGrowthPctUsd: null,
    ytdGrowthPctUsd: null,
    portfolioXirrUsd: null,
    totalGrowthCompoundedPctUsd: null,
    totalDividendsEur: new Decimal(0),
    dividendYieldPct: null,
    fxRateEurUsd: null,
    holdingsCount: 0,
    missingPriceSymbols: [],
    staleValueSymbols: [],
    fxMissingCurrencies: [],
    totalValueIsComplete: true,
    liveDegradedReason: null,
    dailyCreditsUsed: null,
    dailyCreditLimit: 800,
    ...extra,
  };
}

describe("buildPeriods", () => {
  const data = baseExport({
    monthly: {
      rows: [
        { label: "2026-05", contributions_eur: "1200", dividends_eur: "0", interest_eur: "6", net_flow_eur: "1206", opening_value_eur: "37000", closing_value_eur: "38400", growth_pct: "0.006" },
        { label: "2026-06", contributions_eur: "1200", dividends_eur: "0", interest_eur: "5", net_flow_eur: "1205", opening_value_eur: "35800", closing_value_eur: "38000", growth_pct: "0.02" },
      ],
    },
    yearly: {
      rows: [
        { label: "2025", contributions_eur: "9000", dividends_eur: "0", interest_eur: "0", net_flow_eur: "9000", opening_value_eur: "24800", closing_value_eur: "33000", growth_pct: "0.094" },
        { label: "2026", contributions_eur: "7200", dividends_eur: "0", interest_eur: "0", net_flow_eur: "7200", opening_value_eur: "33000", closing_value_eur: "38000", growth_pct: "0.04" },
      ],
    },
  });

  it("overlays the live current month with the live MTD growth + value", () => {
    const { monthly } = buildPeriods(data, overview());
    const current = monthly.find((r) => r.label === "2026-06")!;
    expect(current.isCurrent).toBe(true);
    expect(current.isLive).toBe(true);
    expect(current.growthPct!.toString()).toBe("0.05");
    expect(current.closingValueEur!.toString()).toBe("39000");
  });

  it("leaves completed prior months frozen as exported", () => {
    const { monthly } = buildPeriods(data, overview());
    const may = monthly.find((r) => r.label === "2026-05")!;
    expect(may.isCurrent).toBe(false);
    expect(may.growthPct!.toString()).toBe("0.006");
  });

  it("overlays the live current year with YTD growth and lists newest first", () => {
    const { yearly } = buildPeriods(data, overview());
    expect(yearly[0].label).toBe("2026");
    expect(yearly[0].isLive).toBe(true);
    expect(yearly[0].growthPct!.toString()).toBe("0.11");
  });

  it("returns empty tables when no period read-models are present", () => {
    const { monthly, yearly } = buildPeriods(baseExport(), overview());
    expect(monthly).toEqual([]);
    expect(yearly).toEqual([]);
  });

  it("synthesises the current month when the export omits it", () => {
    const noCurrent = baseExport({
      monthly: {
        rows: [
          { label: "2026-04", contributions_eur: "1200", dividends_eur: "0", interest_eur: "0", net_flow_eur: "1200", opening_value_eur: "35000", closing_value_eur: "37000", growth_pct: "0.02" },
          { label: "2026-05", contributions_eur: "1200", dividends_eur: "0", interest_eur: "0", net_flow_eur: "1200", opening_value_eur: "37000", closing_value_eur: "38400", growth_pct: "0.006" },
        ],
      },
    });
    const { monthly } = buildPeriods(noCurrent, overview());
    // Newest first: the synthesised live current month leads the list.
    expect(monthly[0].label).toBe("2026-06");
    expect(monthly[0].isCurrent).toBe(true);
    expect(monthly[0].isLive).toBe(true);
    expect(monthly[0].closingValueEur!.toString()).toBe("39000");
    expect(monthly[0].growthPct!.toString()).toBe("0.05");
  });

  it("fills a missing first-period growth via a Modified Dietz fallback", () => {
    const firstYearMissing = baseExport({
      yearly: {
        rows: [
          // Opens at 0 with no exported growth — the very first period.
          { label: "2024", contributions_eur: "7650", dividends_eur: "0", interest_eur: "0", net_flow_eur: "7650", opening_value_eur: "0", closing_value_eur: "8200", growth_pct: null },
          { label: "2025", contributions_eur: "9000", dividends_eur: "0", interest_eur: "0", net_flow_eur: "9000", opening_value_eur: "8200", closing_value_eur: "20000", growth_pct: "0.10" },
        ],
      },
    });
    const { yearly } = buildPeriods(firstYearMissing, overview());
    const first = yearly.find((r) => r.label === "2024")!;
    // (8200 - 0 - 7650) / (0 + 7650/2) = 550 / 3825 ≈ 0.1438
    expect(first.growthPct).not.toBeNull();
    expect(first.growthPct!.toDecimalPlaces(4).toString()).toBe("0.1438");
  });
});

describe("buildAnalytics / buildDeposits", () => {
  it("returns null when the blocks are absent", () => {
    expect(buildAnalytics(baseExport())).toBeNull();
    expect(buildDeposits(baseExport())).toBeNull();
  });

  it("maps analytics metrics and sorts attribution by P/L", () => {
    const data = baseExport({
      analytics: {
        as_of: "2026-06-19", start: "2025-06-19", currency: "EUR",
        cagr: "0.11", twr: null, xirr: "0.12", volatility: "0.14", sharpe: "0.9",
        sortino: null, max_drawdown: "-0.16", calmar: null, ulcer: null,
        var_95: "-0.02", cvar_95: null, skew: null, kurtosis: null,
        beta: "0.94", alpha: "0.02", risk_free_rate: "0.025",
        risk_free_symbol: "EURIBOR", benchmark_symbol: "VWCE",
        curve: [],
        attribution: [
          { instrument_id: 1, symbol: "A", start_value: "1", end_value: "2", net_contribution: "0", absolute_pnl: "10", pct_of_total_return: "0.1" },
          { instrument_id: 2, symbol: "B", start_value: "1", end_value: "2", net_contribution: "0", absolute_pnl: "30", pct_of_total_return: "0.3" },
        ],
      },
    });
    const a = buildAnalytics(data)!;
    expect(a.benchmarkSymbol).toBe("VWCE");
    expect(a.attribution[0].symbol).toBe("B"); // higher P/L first
    expect(a.returns.find((m) => m.label === "CAGR")?.value?.toString()).toBe("0.11");
  });

  it("maps deposit summary + records (newest first)", () => {
    const data = baseExport({
      deposits: {
        summary: { total_contrib_eur: "37200", ytd_contrib_eur: "7200", mtd_contrib_eur: "1200" },
        rows: [
          { id: 1, date: "2023-02-15", account: "Taxable", kind: "contribution", amount_eur: "6000", currency: "EUR", description: null },
          { id: 2, date: "2026-06-01", account: "Taxable", kind: "contribution", amount_eur: "1200", currency: "EUR", description: null },
        ],
      },
    });
    const d = buildDeposits(data)!;
    expect(d.totalEur!.toString()).toBe("37200");
    expect(d.rows[0].date).toBe("2026-06-01");
  });

  it("carries the per-date-FX USD contribution figures from the blob", () => {
    const data = baseExport({
      deposits: {
        summary: {
          total_contrib_eur: "37200", ytd_contrib_eur: "7200", mtd_contrib_eur: "1200",
          total_contrib_usd: "41000", ytd_contrib_usd: "7800", mtd_contrib_usd: "1300",
        },
        rows: [
          { id: 1, date: "2023-02-15", account: "Taxable", kind: "contribution", amount_eur: "6000", amount_usd: "6500", currency: "USD", description: null },
        ],
      },
    });
    const d = buildDeposits(data)!;
    expect(d.totalUsd!.toString()).toBe("41000");
    expect(d.ytdUsd!.toString()).toBe("7800");
    expect(d.mtdUsd!.toString()).toBe("1300");
    expect(d.rows[0].amountUsd!.toString()).toBe("6500");
  });

  it("maps the USD `*_display` period figures when the row is USD-denominated", () => {
    const data = baseExport({
      yearly: {
        rows: [
          {
            label: "2025", contributions_eur: "9000", dividends_eur: "0", interest_eur: "10",
            net_flow_eur: "9010", opening_value_eur: "24800", closing_value_eur: "33000", growth_pct: "0.094",
            display_currency: "USD", contributions_display: "9800", dividends_display: "0",
            interest_display: "11", net_flow_display: "9811", opening_value_display: "26000",
            closing_value_display: "35000", growth_pct_display: "0.09",
          },
        ],
      },
    });
    const { yearly } = buildPeriods(data, overview());
    const row = yearly.find((r) => r.label === "2025")!;
    expect(row.contributionsEur.toString()).toBe("9000");
    expect(row.contributionsUsd!.toString()).toBe("9800");
    expect(row.closingValueUsd!.toString()).toBe("35000");
  });

  it("leaves USD period figures null when the row is not USD-denominated", () => {
    const data = baseExport({
      yearly: {
        rows: [
          {
            label: "2025", contributions_eur: "9000", dividends_eur: "0", interest_eur: "0",
            net_flow_eur: "9000", opening_value_eur: "24800", closing_value_eur: "33000", growth_pct: "0.094",
          },
        ],
      },
    });
    const { yearly } = buildPeriods(data, overview());
    const row = yearly.find((r) => r.label === "2025")!;
    expect(row.contributionsUsd).toBeNull();
  });
});

describe("buildPlan + projectForward", () => {
  it("seeds the annual contribution from the average of positive yearly contributions", () => {
    const data = baseExport({
      yearly: {
        rows: [
          { label: "2024", contributions_eur: "8000", dividends_eur: "0", interest_eur: "0", net_flow_eur: "8000", opening_value_eur: "0", closing_value_eur: "0", growth_pct: null },
          { label: "2025", contributions_eur: "10000", dividends_eur: "0", interest_eur: "0", net_flow_eur: "10000", opening_value_eur: "0", closing_value_eur: "0", growth_pct: null },
        ],
      },
    });
    const plan = buildPlan(data, overview({ totalValueEur: new Decimal("39000") }));
    expect(plan.startingValueEur.toString()).toBe("39000");
    expect(plan.defaultAnnualContributionEur.toString()).toBe("9000");
  });

  it("anchors the projection base year to the export as_of date", () => {
    const plan = buildPlan(baseExport(), overview());
    expect(plan.baseYear).toBe(2026); // meta.as_of = 2026-06-19
    const rows = projectForward(new Decimal("1000"), new Decimal("0"), 2, plan.baseYear, ["0"]);
    expect(rows[0].year).toBe(2027);
    expect(rows[1].year).toBe(2028);
  });

  it("projects an ordinary annuity: grow by the rate, then add the contribution", () => {
    // One year, 0% growth, 1000 contribution → starting + 1000.
    const rows = projectForward(new Decimal("10000"), new Decimal("1000"), 1, 2026, ["0"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].year).toBe(2027);
    expect(rows[0].valuesByRate.get("0")!.toString()).toBe("11000");
    expect(rows[0].contributedEur.toString()).toBe("1000");
  });

  it("compounds across multiple years at the scenario rate", () => {
    // 10% on 10000 with no contributions → 12100 after two years.
    const rows = projectForward(new Decimal("10000"), new Decimal("0"), 2, 2026, ["0.1"]);
    expect(rows[1].valuesByRate.get("0.1")!.toString()).toBe("12100");
  });
});
