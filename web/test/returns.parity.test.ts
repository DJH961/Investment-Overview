/**
 * Parity suite: the TypeScript return functions must reproduce the committed
 * Python vectors within the documented tolerances.
 *
 * `tests/parity/vectors.json` is generated from the Python source by
 * `tools/gen_parity_vectors.py` and checked for freshness by
 * `tests/parity/test_vectors_fresh.py`. This test is the browser-side half of
 * the contract: it guarantees the ported maths agrees with the desktop, so the
 * web companion never silently drifts from the authoritative numbers.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import {
  annualizeReturn,
  cagr,
  capitalGain,
  totalGrowthPct,
  totalGrowthPctCompounded,
  xirr,
  yearsBetween,
  type Cashflow,
} from "../src/returns";

const VECTORS_PATH = fileURLToPath(new URL("../../tests/parity/vectors.json", import.meta.url));

interface Vectors {
  tolerances: { money: string; rates: string; xirr: string };
  xirr: Array<{
    name: string;
    inputs: { cashflows: Array<{ date: string; amount: string }>; as_of: string; terminal_value: string | null };
    expected: string | null;
  }>;
  cagr: Array<{ name: string; inputs: { start_value: string; end_value: string; days: number }; expected: string | null }>;
  annualize_return: Array<{ name: string; inputs: { total_return: string; days: number }; expected: string | null }>;
  total_growth_pct: Array<{ name: string; inputs: { contributions: string; current_value: string }; expected: string | null }>;
  total_growth_pct_compounded: Array<{ name: string; inputs: { xirr_rate: string | null; years: string }; expected: string | null }>;
  years_between: Array<{ name: string; inputs: { start: string; end: string }; expected: string | null }>;
  capital_gain: Array<{
    name: string;
    inputs: { contributions: string; current_value: string; cumulative_dividends_cash: string };
    expected: string | null;
  }>;
}

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf-8")) as Vectors;
const TOL = {
  money: new Decimal(vectors.tolerances.money),
  rates: new Decimal(vectors.tolerances.rates),
  xirr: new Decimal(vectors.tolerances.xirr),
};

function expectClose(actual: Decimal | null, expected: string | null, tol: Decimal): void {
  if (expected === null) {
    expect(actual, "expected null result").toBeNull();
    return;
  }
  expect(actual, `expected ${expected}, got null`).not.toBeNull();
  const diff = (actual as Decimal).minus(new Decimal(expected)).abs();
  expect(
    diff.lessThanOrEqualTo(tol),
    `|${(actual as Decimal).toString()} - ${expected}| = ${diff.toString()} > ${tol.toString()}`,
  ).toBe(true);
}

describe("xirr parity", () => {
  for (const c of vectors.xirr) {
    it(c.name, () => {
      const cashflows: Cashflow[] = c.inputs.cashflows.map((f) => ({
        date: f.date,
        amount: new Decimal(f.amount),
      }));
      const terminal = c.inputs.terminal_value === null ? null : new Decimal(c.inputs.terminal_value);
      expectClose(xirr(cashflows, c.inputs.as_of, { terminalValue: terminal }), c.expected, TOL.xirr);
    });
  }
});

describe("cagr parity", () => {
  for (const c of vectors.cagr) {
    it(c.name, () => {
      expectClose(
        cagr(new Decimal(c.inputs.start_value), new Decimal(c.inputs.end_value), c.inputs.days),
        c.expected,
        TOL.rates,
      );
    });
  }
});

describe("annualize_return parity", () => {
  for (const c of vectors.annualize_return) {
    it(c.name, () => {
      expectClose(annualizeReturn(new Decimal(c.inputs.total_return), c.inputs.days), c.expected, TOL.rates);
    });
  }
});

describe("total_growth_pct parity", () => {
  for (const c of vectors.total_growth_pct) {
    it(c.name, () => {
      expectClose(
        totalGrowthPct(new Decimal(c.inputs.contributions), new Decimal(c.inputs.current_value)),
        c.expected,
        TOL.rates,
      );
    });
  }
});

describe("total_growth_pct_compounded parity", () => {
  for (const c of vectors.total_growth_pct_compounded) {
    it(c.name, () => {
      const rate = c.inputs.xirr_rate === null ? null : new Decimal(c.inputs.xirr_rate);
      expectClose(totalGrowthPctCompounded(rate, new Decimal(c.inputs.years)), c.expected, TOL.rates);
    });
  }
});

describe("years_between parity", () => {
  for (const c of vectors.years_between) {
    it(c.name, () => {
      expectClose(yearsBetween(c.inputs.start, c.inputs.end), c.expected, TOL.rates);
    });
  }
});

describe("capital_gain parity", () => {
  for (const c of vectors.capital_gain) {
    it(c.name, () => {
      expectClose(
        capitalGain(
          new Decimal(c.inputs.contributions),
          new Decimal(c.inputs.current_value),
          new Decimal(c.inputs.cumulative_dividends_cash),
        ),
        c.expected,
        TOL.money,
      );
    });
  }
});
