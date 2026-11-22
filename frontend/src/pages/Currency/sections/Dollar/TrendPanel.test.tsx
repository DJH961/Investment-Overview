import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import full from "../../../../fixtures/data/full.json";
import { HideAmountsProvider } from "../../../../lib/hideAmounts";
import type { DollarDto } from "../../../../lib/queries/currencyDollar";
import { RollingPanel } from "./RollingPanel";
import { TrendPanel } from "./TrendPanel";

const fx = full as unknown as Record<string, { EUR: DollarDto; USD: DollarDto }>;
const body = fx["GET /api/currency/dollar/both?range=1y"];

const mount = (node: React.ReactNode) => render(<HideAmountsProvider>{node}</HideAmountsProvider>);

describe("Exposure trend: the dollar's in EUR, the euro's in USD", () => {
  it("EUR view reads the dollar", () => {
    mount(<TrendPanel data={body.EUR} />);
    expect(screen.getByText("Dollar trend")).toBeInTheDocument();
    expect(screen.queryByText("Euro trend")).not.toBeInTheDocument();
  });

  it("USD view reads the euro, with its own server figures", () => {
    const t = body.USD.trend!;
    expect(t.asset).toBe("euro");
    mount(<TrendPanel data={body.USD} />);
    expect(screen.getByText("Euro trend")).toBeInTheDocument();
    expect(screen.queryByText(/the dollar/i)).not.toBeInTheDocument();
    // A euro moving the other way from the dollar, by its own (not the negated) amount.
    const eur = body.EUR.trend!.regime!;
    const usd = t.regime!;
    expect(Math.sign(Number(usd.since_change_pct))).toBe(-Math.sign(Number(eur.since_change_pct)));
    expect(Number(usd.since_change_pct)).not.toBe(-Number(eur.since_change_pct));
  });

  it("rolling changes are the euro's in USD", () => {
    mount(<RollingPanel data={body.USD} />);
    expect(screen.getByText("the euro's change")).toBeInTheDocument();
  });
});
