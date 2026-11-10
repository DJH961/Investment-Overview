import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingCard } from "./OnboardingCard";

const state = { account: true, first_import: false, password: true, passkey: false, conversions: false, targets: false, complete: false };

function setup(body: object = state) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <OnboardingCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("OnboardingCard", () => {
  it("shows progress with a link, and stays hidden once dismissed", async () => {
    setup();
    expect(await screen.findByText("2 of 6 steps done")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue setup" })).toHaveAttribute("href", "/onboarding");
    fireEvent.click(screen.getByRole("button", { name: "Hide setup guide" }));
    expect(screen.queryByText("Setup guide")).not.toBeInTheDocument();
    expect(localStorage.getItem("iv.onboarding.dismissed")).toBe("true");
  });

  it("is absent when setup is complete", async () => {
    setup({ ...state, complete: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Setup guide")).not.toBeInTheDocument();
  });
});
