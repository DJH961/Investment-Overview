import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { CurrencyConversions } from "./CurrencyConversions";

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
