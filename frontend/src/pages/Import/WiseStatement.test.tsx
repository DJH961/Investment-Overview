import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { depositStatusLook, rateChipLabel } from "../CurrencyConversions/matching";
import { WiseStatement } from "./WiseStatement";

afterEach(() => vi.unstubAllGlobals());

const row = (over: Record<string, unknown>) => ({
  line: 2,
  external_id: "CONVERSION_ORDER-1",
  date: "2023-11-14",
  status: "conversion",
  reason: null,
  description: null,
  eur_sent: "198.89",
  fees_eur: "1.11",
  usd_received: "215.73",
  rate: "1.0846",
  fee_stated: true,
  sent_on: false,
  is_duplicate: false,
  warnings: [],
  ...over,
});

const preview = {
  import_id: "abc",
  filename: "wise.csv",
  counts: { rows: 3, new: 2, duplicates: 0, skipped: 1 },
  rows: [
    row({}),
    row({ line: 3, external_id: "TRANSFER-2", sent_on: true }),
    row({ line: 4, external_id: "CARD-1", status: "skipped", reason: "Card payment, not a conversion", eur_sent: null }),
  ],
  headers: [],
  fields: [],
  missing: [],
  ignore_non_usd: true,
  expires_at: "2030-01-01T00:00:00Z",
};

describe("WiseStatement", () => {
  it("lets a row be ticked off and sends the choices", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/imports/wise")) return new Response(JSON.stringify(preview), { status: 201 });
        if (url.endsWith("/confirm")) {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ import_id: "abc", imported: 1, skipped: 2, duplicates: 0 }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <MemoryRouter>
            <WiseStatement />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "wise.csv", { type: "text/csv" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Preview conversions" }));
    expect(await screen.findByText(/Card payment, not a conversion/)).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[1]); // tick off the second conversion
    fireEvent.click(screen.getByRole("button", { name: "Import 1 conversion" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      rows: [
        { line: 2, skip: false, kept_usd: "0" },
        { line: 3, skip: true, kept_usd: "0" },
      ],
    });
  });
});

describe("Received in USD status", () => {
  it("has its own icon and label, never color alone", () => {
    expect(depositStatusLook("received_usd", false)).toEqual({ label: "Received in USD", tone: "neutral", icon: "usd" });
    expect(rateChipLabel("received_usd")).toBe("USD");
  });
});
