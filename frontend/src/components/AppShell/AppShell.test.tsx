import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrefsProvider } from "../../lib/prefs";
import { ShellProvider } from "../../lib/shell";
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
    <PrefsProvider>
      <ShellProvider>
        <MemoryRouter initialEntries={["/overview"]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/overview" element={<div>page body</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ShellProvider>
    </PrefsProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

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
  });
});
