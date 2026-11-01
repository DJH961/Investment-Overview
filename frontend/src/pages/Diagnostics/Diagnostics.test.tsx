import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { Diagnostics } from "./Diagnostics";

afterEach(() => vi.unstubAllGlobals());

describe("Diagnostics", () => {
  it("lists the deposits that fell back to the ECB rate", async () => {
    const body = {
      status: "warning",
      count: 1,
      generated_at: "2025-05-01T00:00:00",
      checks: [
        {
          id: "ecb_fallback_deposits",
          title: "Deposits paid at the ECB rate",
          severity: "warning",
          count: 1,
          detail: "Add the missing conversion.",
          examples: ["2025-04-10 (500 USD)"],
        },
      ],
      providers: [],
      provider_log: [],
      problems: [],
      refresh: {
        active: false,
        source: null,
        last_update_at: null,
        historical: false,
        progress_done: 0,
        progress_total: 0,
        progress_label: null,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(url.includes("refresh") ? JSON.stringify({ running: false }) : JSON.stringify(body), {
          status: 200,
        }),
      ),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter>
            <Diagnostics />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Deposits paid at the ECB rate")).toBeInTheDocument();
    expect(screen.getByText("2025-04-10 (500 USD)")).toBeInTheDocument();
  });
});
