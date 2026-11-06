import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TwinHealth } from "../../lib/queries/maintenance";

const state = vi.hoisted(() => ({ data: null as TwinHealth | null }));
vi.mock("../../lib/queries/maintenance", () => ({
  useTwinHealth: () => ({ data: state.data, isPending: false, isError: false, refetch: vi.fn() }),
}));

import { TwinsCard } from "./TwinsCard";

const FUND = {
  instrument_id: 7,
  symbol: "FXAIX",
  name: "Fidelity 500 Index",
  twin_symbol: "VOO",
  estimating: true,
  stored_sessions: 240,
  first_session: "2025-11-10",
  last_session: "2026-11-05",
  last_price_at: "2026-11-05T20:00:00Z",
  year_backfill_done: true,
  divergence: {
    last_gap_pp: "-0.03",
    last_date: "2026-11-05",
    median_abs_pp: "0.02",
    bias_pp: "0.01",
    sessions: 18,
  },
};

const render1 = (h: TwinHealth) => {
  state.data = h;
  return render(<TwinsCard />);
};

describe("TwinsCard", () => {
  it("names the pair and reports coverage and accuracy in percentage points", () => {
    render1({ enabled: true, window: 20, funds: [FUND] } as unknown as TwinHealth);
    expect(screen.getByText("FXAIX")).toBeInTheDocument();
    expect(screen.getByText(/≈ VOO/)).toBeInTheDocument();
    expect(screen.getByText("estimating now")).toBeInTheDocument();
    expect(screen.getByText(/240/)).toBeInTheDocument();
    // Signed, two decimals, already in pp — never re-scaled by 100.
    expect(screen.getByText(/Last gap -0\.03 pp/)).toBeInTheDocument();
    expect(screen.getByText(/bias \+0\.01 pp over 18 of 20 sessions/)).toBeInTheDocument();
  });

  it("says estimates are off and that accuracy is still measured", () => {
    render1({ enabled: false, window: 20, funds: [FUND] } as unknown as TwinHealth);
    expect(screen.getByText(/Twin estimates are/)).toHaveTextContent("off");
    expect(screen.getByText(/keeps being measured/)).toBeInTheDocument();
  });

  it("explains the empty case rather than showing a bare heading", () => {
    render1({ enabled: true, window: 20, funds: [] } as unknown as TwinHealth);
    expect(screen.getByText(/No fund has an ETF twin yet/)).toBeInTheDocument();
  });

  it("does not claim accuracy before the two series share a session", () => {
    const fresh = { ...FUND, divergence: null, year_backfill_done: false, stored_sessions: 0 };
    render1({ enabled: true, window: 20, funds: [fresh] } as unknown as TwinHealth);
    expect(screen.getByText(/No accuracy yet/)).toBeInTheDocument();
    expect(screen.getByText("not backfilled yet")).toBeInTheDocument();
  });
});
