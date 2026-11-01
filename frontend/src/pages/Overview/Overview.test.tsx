import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { toNum } from "../../lib/queries/portfolio";

const overview = {
  as_of: "2026-10-30",
  ccy: "EUR",
  generated_at: "2026-10-30T20:00:00Z",
  is_live: false,
  position_count: 0,
  warnings: { zero_value: [], bad_history: [], missing_fx: [] },
};
const idle = { data: undefined, isPending: true, isError: false, isFetching: false, refetch: vi.fn() };

vi.mock("../../lib/queries/portfolio", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/portfolio")>()),
  useOverview: () => ({ ...idle, data: overview, isPending: false }),
  useHoldings: () => idle,
  useAllocations: () => idle,
  useGraph: () => idle,
}));
vi.mock("../../lib/prefs", () => ({ usePrefs: () => ({ currency: "EUR" }) }));
vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

import { Overview } from "./Overview";

describe("Overview page", () => {
  it("shows the empty state without positions", () => {
    render(<Overview />);
    expect(screen.getByText("No positions yet")).toBeInTheDocument();
  });
  it("parses decimal strings for display", () => {
    expect(toNum("1.5")).toBe(1.5);
    expect(toNum(null)).toBeNull();
  });
});
