import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { draftError, ShareCountsCard } from "./ShareCountsCard";

let calls: { url: string; method: string; body: unknown }[];
let stored: { account_id: number; instrument_id: number; shares: string }[];

beforeEach(() => {
  localStorage.clear();
  calls = [];
  stored = [{ account_id: 1, instrument_id: 2, shares: "12.5" }];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes("/share-counts")) {
        if (method === "PUT") stored = body.counts;
        return json({ counts: stored });
      }
      if (url.includes("/api/accounts")) return json([{ id: 1, account_label: "Main", broker: "fidelity", account_type: "brokerage", active: true, native_currency: "USD", transaction_count: 3 }]);
      if (url.includes("/api/instruments")) return json([{ id: 2, symbol: "VTI", name: "Total Market" }]);
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderCard() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <ShareCountsCard />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("draftError", () => {
  const row = (account: string, instrument: string, shares: string) => ({ key: 1, account, instrument, shares });
  it("accepts blank rows and valid counts", () => {
    expect(draftError([row("", "", ""), row("1", "2", "0"), row("1", "3", "12.5")])).toBeNull();
  });
  it("rejects half-filled, negative and duplicate rows", () => {
    expect(draftError([row("1", "", "3")])).toMatch(/Pick an account/);
    expect(draftError([row("1", "2", "-1")])).toMatch(/zero or more/);
    expect(draftError([row("1", "2", "")])).toMatch(/zero or more/);
    expect(draftError([row("1", "2", "1"), row("1", "2", "2")])).toMatch(/only once/);
  });
});

describe("Data Health: broker share counts", () => {
  it("shows the stored counts and saves an edit with the whole list", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /Broker share counts/ }));
    const shares = await screen.findByLabelText("Shares at the broker, row 1");
    expect(shares).toHaveValue("12.5");
    fireEvent.change(shares, { target: { value: "13" } });
    fireEvent.click(screen.getByRole("button", { name: "Save counts" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ counts: [{ account_id: 1, instrument_id: 2, shares: "13" }] });
  });

  it("blocks a bad count with an alert and sends nothing", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /Broker share counts/ }));
    fireEvent.change(await screen.findByLabelText("Shares at the broker, row 1"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save counts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/zero or more/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("switches the check off by sending an empty list", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /Broker share counts/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Switch the check off" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ counts: [] }));
  });
});
