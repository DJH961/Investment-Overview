import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { Onboarding } from "./Onboarding";

afterEach(() => vi.unstubAllGlobals());

describe("Onboarding", () => {
  it("marks the steps the server reports as done", async () => {
    const state = {
      account: true,
      first_import: true,
      password: true,
      passkey: false,
      conversions: false,
      targets: false,
      complete: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(url.includes("onboarding") ? JSON.stringify(state) : "[]", { status: 200 }),
      ),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter>
            <Onboarding />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("Add a passkey");
    await vi.waitFor(() => expect(screen.getAllByLabelText("Done")).toHaveLength(3));
    expect(screen.getAllByLabelText("To do")).toHaveLength(3);
  });
});
