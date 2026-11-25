import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CashOutOut } from "../../lib/journey-types";
import { CashOutCard } from "./CashOutCard";

const SAMPLE: CashOutOut = {
  conversion_id: 31,
  date: "2026-03-16",
  usd_sent: "2400.00",
  eur_received: "2201.30",
  fees_eur: "4.50",
  eur: {
    put_in: "1850.00",
    market: "336.41",
    currency: "23.13",
    conversion_cost: "-8.24",
    realised: "351.30",
    realised_pct: "0.1899",
    xirr: "0.1221",
  },
  usd: {
    put_in: "2035.00",
    market: "365.00",
    realised: "365.00",
    realised_pct: "0.1794",
    xirr: "0.1158",
  },
  note: "In euros you kept 0.6 points a year more than in dollars: the dollar rose while you held.",
  flagged: false,
};

describe("CashOutCard", () => {
  it("shows euros beside dollars, fees, and the server note", () => {
    render(<CashOutCard out={SAMPLE} />);
    expect(screen.getByRole("region", { name: "Cash-out result" })).toBeInTheDocument();
    expect(screen.getByText(/back in euros/)).toBeInTheDocument();
    expect(screen.getByText(/fees/)).toBeInTheDocument();
    expect(screen.getByText("In euros")).toBeInTheDocument();
    expect(screen.getByText("In dollars")).toBeInTheDocument();
    expect(screen.getByText("Put in")).toBeInTheDocument();
    expect(screen.getByText("Currency")).toBeInTheDocument();
    expect(screen.getByText("Conversion cost")).toBeInTheDocument();
    expect(screen.getByText("Realized")).toBeInTheDocument();
    expect(screen.getByText("A year")).toBeInTheDocument();
    expect(screen.getAllByText("only in euros")).toHaveLength(2);
    expect(screen.getByText(SAMPLE.note)).toBeInTheDocument();
    expect(screen.queryByText("Part at the ECB rate")).not.toBeInTheDocument();
  });

  it("shows the flagged chip and handles null xirr without fees", () => {
    render(
      <CashOutCard
        out={{
          ...SAMPLE,
          fees_eur: "0.00",
          flagged: true,
          eur: { ...SAMPLE.eur, xirr: null },
          usd: { ...SAMPLE.usd, xirr: null },
        }}
      />,
    );
    expect(screen.getByText("Part at the ECB rate")).toBeInTheDocument();
    expect(screen.queryByText(/fees/)).not.toBeInTheDocument();
  });
});
