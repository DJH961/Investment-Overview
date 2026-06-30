import { describe, expect, it } from "vitest";

import { buildTransactions } from "../src/transactions";
import type { MobileExport } from "../src/types";

/** A minimal export carrying only the fields buildTransactions inspects. */
function exportWith(transactions: unknown): MobileExport {
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
    // Cast through unknown so the test can feed deliberately malformed blobs.
    transactions: transactions as MobileExport["transactions"],
  } as MobileExport;
}

describe("buildTransactions", () => {
  it("reports unavailable when the export omits the ledger", () => {
    const view = buildTransactions(exportWith(undefined));
    expect(view.available).toBe(false);
    expect(view.rows).toEqual([]);
    expect(view.kinds).toEqual([]);
  });

  it("treats a malformed transactions block as unavailable", () => {
    expect(buildTransactions(exportWith({ rows: "nope" })).available).toBe(false);
    expect(buildTransactions(exportWith(42)).available).toBe(false);
    expect(buildTransactions(exportWith(null)).available).toBe(false);
  });

  it("is available with an empty rows array", () => {
    const view = buildTransactions(exportWith({ rows: [] }));
    expect(view.available).toBe(true);
    expect(view.rows).toHaveLength(0);
  });

  it("parses decimal fields and preserves order (newest-first from the source)", () => {
    const view = buildTransactions(
      exportWith({
        rows: [
          {
            id: 2,
            date: "2026-06-01",
            account: "Taxable",
            kind: "buy",
            symbol: "VWCE",
            quantity: "8",
            price_native: "120.50",
            fees_native: "1.20",
            gross_native: "964.00",
            net_native: "-965.20",
            net_eur: "-965.20",
            net_usd: "-1042.42",
            source: "manual",
          },
          {
            id: 1,
            date: "2026-03-09",
            account: "Taxable",
            kind: "interest",
            symbol: "VMFXX",
            quantity: null,
            price_native: null,
            fees_native: null,
            gross_native: "11.40",
            net_native: "11.40",
            net_eur: "10.56",
            net_usd: "11.40",
            source: "import",
          },
        ],
      }),
    );
    expect(view.available).toBe(true);
    expect(view.rows).toHaveLength(2);
    expect(view.rows[0].id).toBe(2);
    expect(view.rows[0].quantity?.toString()).toBe("8");
    expect(view.rows[0].netUsd?.toString()).toBe("-1042.42");
    expect(view.rows[1].quantity).toBeNull();
    expect(view.rows[1].netEur?.toString()).toBe("10.56");
  });

  it("collects the distinct kinds, sorted, for the filter dropdown", () => {
    const view = buildTransactions(
      exportWith({
        rows: [
          { id: 3, date: "2026-06-01", account: "A", kind: "sell", symbol: "X", quantity: "-1", price_native: "1", fees_native: "0", gross_native: "1", net_native: "1", net_eur: "1", net_usd: "1", source: null },
          { id: 2, date: "2026-05-01", account: "A", kind: "buy", symbol: "X", quantity: "1", price_native: "1", fees_native: "0", gross_native: "1", net_native: "-1", net_eur: "-1", net_usd: "-1", source: null },
          { id: 1, date: "2026-04-01", account: "A", kind: "buy", symbol: "X", quantity: "1", price_native: "1", fees_native: "0", gross_native: "1", net_native: "-1", net_eur: "-1", net_usd: "-1", source: null },
        ],
      }),
    );
    expect(view.kinds).toEqual(["buy", "sell"]);
  });

  it("tolerates non-numeric decimal strings by nulling the field, not throwing", () => {
    const view = buildTransactions(
      exportWith({
        rows: [
          { id: 1, date: "2026-06-01", account: "A", kind: "buy", symbol: "X", quantity: "abc", price_native: "", fees_native: null, gross_native: null, net_native: null, net_eur: "NaN", net_usd: "1.5", source: null },
        ],
      }),
    );
    expect(view.rows[0].quantity).toBeNull();
    expect(view.rows[0].priceNative).toBeNull();
    expect(view.rows[0].netEur).toBeNull();
    expect(view.rows[0].netUsd?.toString()).toBe("1.5");
  });

  it("normalises money-market reinvestments to a dividend with no shares or price", () => {
    const view = buildTransactions(
      exportWith({
        rows: [
          {
            id: 1,
            date: "2026-03-31",
            account: "Taxable",
            kind: "dividend_reinvest",
            symbol: "VMFXX",
            quantity: "12.34",
            price_native: "1.00",
            fees_native: null,
            gross_native: "12.34",
            net_native: "0",
            net_eur: "11.42",
            net_usd: "12.34",
            source: "import",
          },
        ],
      }),
    );
    const row = view.rows[0];
    expect(row.kind).toBe("dividend");
    expect(row.quantity).toBeNull();
    expect(row.priceNative).toBeNull();
    // The cash legs are untouched so the amount still shows.
    expect(row.netUsd?.toString()).toBe("12.34");
    // The dropdown lists the normalised kind, not the raw reinvest slug.
    expect(view.kinds).toEqual(["dividend"]);
  });

  it("leaves a non-money-market reinvestment (real shares) untouched", () => {
    const view = buildTransactions(
      exportWith({
        rows: [
          { id: 1, date: "2026-03-31", account: "Taxable", kind: "dividend_reinvest", symbol: "VWCE", quantity: "0.42", price_native: "120.50", fees_native: null, gross_native: "50.61", net_native: "0", net_eur: "50.61", net_usd: "54.66", source: "import" },
        ],
      }),
    );
    const row = view.rows[0];
    expect(row.kind).toBe("dividend_reinvest");
    expect(row.quantity?.toString()).toBe("0.42");
    expect(row.priceNative?.toString()).toBe("120.5");
  });

  it("detects money-market funds flagged on holdings, beyond the static symbol list", () => {
    const data = exportWith({
      rows: [
        { id: 1, date: "2026-03-31", account: "Taxable", kind: "dividend_reinvest", symbol: "ZZMM", quantity: "5", price_native: "1.00", fees_native: null, gross_native: "5", net_native: "0", net_eur: "4.6", net_usd: "5", source: "import" },
      ],
    });
    // A non-standard ticker the export marks as money-market.
    (data.holdings as unknown as Array<Record<string, unknown>>).push({
      symbol: "ZZMM",
      price_symbol: "ZZMM",
      is_money_market: true,
    });
    const row = buildTransactions(data).rows[0];
    expect(row.kind).toBe("dividend");
    expect(row.quantity).toBeNull();
    expect(row.priceNative).toBeNull();
  });
});
