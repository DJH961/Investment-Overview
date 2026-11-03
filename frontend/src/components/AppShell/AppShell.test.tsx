import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrefsProvider } from "../../lib/prefs";
import { resetRefreshState, setRefreshState } from "../../lib/refresh";
import { ShellProvider } from "../../lib/shell";
import { ToastProvider } from "../Toast";
import { AppShell } from "./AppShell";

function mockViewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = (max ? width <= Number(max[1]) : true) && (min ? width >= Number(min[1]) : true);
    return { matches, media: query, addEventListener: () => {}, removeEventListener: () => {} };
  });
}

function renderShell() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
    <PrefsProvider>
      <ToastProvider>
      <ShellProvider>
        <MemoryRouter initialEntries={["/overview"]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/overview" element={<div>page body</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ShellProvider>
      </ToastProvider>
    </PrefsProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetRefreshState();
});

describe("AppShell", () => {
  it("renders the sidebar navigation on desktop", () => {
    mockViewport(1280);
    renderShell();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Holdings" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main tabs" })).not.toBeInTheDocument();
    expect(screen.getByText("page body")).toBeInTheDocument();
  });
  it("shows the bottom tab bar on a phone and no sidebar", () => {
    mockViewport(390);
    renderShell();
    expect(screen.getByRole("navigation", { name: "Main tabs" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
    // Refresh and the account menu (sign out) are in the top bar, enabled without any page registering a handler.
    expect(screen.getByRole("button", { name: "Refresh data" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Account and sign out" })).toBeInTheDocument();
  });
  it("shows Updating… and a progress bar while a server refresh runs", () => {
    mockViewport(1280);
    renderShell();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    act(() => setRefreshState({ running: true, historical: true, done: 2, total: 4 }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByText("Downloading history 2/4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh data" })).toBeDisabled();
  });
});
