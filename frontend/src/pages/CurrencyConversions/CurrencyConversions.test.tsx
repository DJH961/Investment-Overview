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

  it("submits eur_sent net of fees in Including fees mode without float drift", async () => {
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
    expect(screen.getByRole("radio", { name: "Excluding fees" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Including fees" }));
    expect(screen.getByRole("radio", { name: "Including fees" })).toBeChecked();

    fireEvent.change(screen.getByLabelText("Total EUR paid (incl. fees)"), { target: { value: "1.002,50" } });
    fireEvent.change(screen.getByLabelText("USD received"), { target: { value: "1200" } });
    fireEvent.change(screen.getByLabelText("Fees (EUR, optional)"), { target: { value: "2,50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      eur_sent: "1000.00",
      usd_received: "1200",
      fees_eur: "2.50",
      date: "2026-01-05",
    });

    // Classic float drift case: 100.1 - 0.2 must be 99.90, not 99.89999999999999.
    fireEvent.change(screen.getByLabelText("Total EUR paid (incl. fees)"), { target: { value: "100.1" } });
    fireEvent.change(screen.getByLabelText("Fees (EUR, optional)"), { target: { value: "0.2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ eur_sent: "99.90", fees_eur: "0.2" });
  });

  it("rejects fees >= total EUR paid in Including fees mode", async () => {
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
    fireEvent.click(screen.getByRole("radio", { name: "Including fees" }));
    fireEvent.change(screen.getByLabelText("Total EUR paid (incl. fees)"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("USD received"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Fees (EUR, optional)"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Fees must be less than the total EUR paid.");
    expect(bodies).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Fees (EUR, optional)"), { target: { value: "12.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Fees must be less than the total EUR paid.");
    expect(bodies).toHaveLength(0);
  });

  it("updates live breakdown, rates, and ECB comparison when toggling modes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("reference")) {
          return new Response(
            JSON.stringify({ date: "2026-01-05", ecb_rate: "1.2000", ecb_rate_date: "2026-01-05", published: true }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <ConversionDialog open onOpenChange={() => undefined} editing={null} prefill={{ date: "2026-01-05" }} />
        </ToastProvider>
      </QueryClientProvider>,
    );

    // Excluding fees with fee > 0: shows Total paid, Converted rate, All-in rate, and ECB diff based on all-in rate.
    fireEvent.change(screen.getByLabelText("EUR sent"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("USD received"), { target: { value: "1200" } });
    fireEvent.change(screen.getByLabelText("Fees (EUR, optional)"), { target: { value: "2.50" } });

    expect(screen.getByTestId("eur-breakdown")).toHaveTextContent("Total paid (incl. fees): €1,002.50");
    expect(screen.getByTestId("rate-line")).toHaveTextContent("Converted rate: 1.2000 · All-in rate: 1.1970 USD per EUR");
    // 1200 / 1002.50 = 1.197007... vs ECB 1.2000 -> -0.25% under it
    expect(await screen.findByTestId("ecb-line")).toHaveTextContent(/0\.25 % under it/);

    // Switch to Including fees keeping typed inputs: now 1000 is total paid, 997.50 is converted EUR.
    fireEvent.click(screen.getByRole("radio", { name: "Including fees" }));
    expect(screen.getByLabelText("Total EUR paid (incl. fees)")).toHaveValue("1000");
    expect(screen.getByTestId("eur-breakdown")).toHaveTextContent("Converted EUR: €997.50 (excl. fees)");
    // 1200 / 997.50 = 1.2030, all-in = 1200 / 1000 = 1.2000 -> at ECB rate
    expect(screen.getByTestId("rate-line")).toHaveTextContent("Converted rate: 1.2030 · All-in rate: 1.2000 USD per EUR");
    expect(screen.getByTestId("ecb-line")).toHaveTextContent(/you are at it/);
  });

  it("defaults to Excluding fees when editing an existing conversion", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <ConversionDialog
            open
            onOpenChange={() => undefined}
            editing={{
              id: 42,
              date: "2026-01-05",
              eur_sent: "1000.000000",
              usd_received: "1200.000000",
              fees_eur: "2.500000",
              note: null,
              effective_rate: "1.200000",
              from_ccy: "EUR",
              to_ccy: "USD",
              direction: "to_usd",
              provider: "wise",
              kept_usd: "0",
              rate: "1.200000",
              all_in_rate: "1.197007",
              ecb_rate: null,
              ecb_rate_date: null,
              off_pct: null,
              spread_eur: null,
              cost_eur: null,
              fees_usd: null,
              cost_usd: null,
              used_by: [],
              remaining_usd: "1200.000000",
              is_estimate: false,
            }}
          />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("radio", { name: "Excluding fees" })).toBeChecked();
    expect(screen.getByLabelText("EUR sent")).toHaveValue("1000");
    expect(screen.getByLabelText("Fees (EUR, optional)")).toHaveValue("2.5");
    expect(screen.getByTestId("eur-breakdown")).toHaveTextContent("Total paid (incl. fees): €1,002.50");
    expect(screen.getByTestId("rate-line")).toHaveTextContent("Converted rate: 1.2000 · All-in rate: 1.1970 USD per EUR");
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
