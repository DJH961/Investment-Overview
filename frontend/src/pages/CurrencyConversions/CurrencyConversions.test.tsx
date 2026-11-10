import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { ConversionDialog, CurrencyConversions } from "./CurrencyConversions";

afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <CurrencyConversions />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ConversionDialog numbers", () => {
  it("accepts decimal commas, sends dot decimals, and rejects text", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") bodies.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <ConversionDialog open onOpenChange={() => undefined} editing={null} prefill={{ date: "2026-01-05" }} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText("EUR sent"), { target: { value: "1.000,50" } });
    fireEvent.change(screen.getByLabelText("USD received"), { target: { value: "abc" } });
    expect(screen.getByDisplayValue("2026-01-05")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/positive EUR and USD/);
    expect(bodies).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("USD received"), { target: { value: "1200,25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ eur_sent: "1000.50", usd_received: "1200.25", date: "2026-01-05" });
  });
});

describe("CurrencyConversions", () => {
  it("shows the empty state when there are no conversions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(
          url.includes("pool")
            ? JSON.stringify({ balance_eur: "0", balance_usd: "0", deposits: [], fallbacks: [], remaining: [] })
            : "[]",
          { status: 200 },
        ),
      ),
    );
    renderPage();
    expect(await screen.findByText("No conversions yet")).toBeInTheDocument();
  });
});
