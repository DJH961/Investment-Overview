import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { PrefsProvider } from "../../lib/prefs";
import { TopBar, type TopBarProps } from "./TopBar";

function renderBar(props: Partial<TopBarProps> = {}) {
  const onRefresh = vi.fn();
  const onLogout = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
    <PrefsProvider>
      <MemoryRouter>
        <TopBar
          title="Holdings"
          freshness={{ status: "live", label: "Live · 14:32" }}
          compact
          onRefresh={onRefresh}
          onLogout={onLogout}
          {...props}
        />
      </MemoryRouter>
    </PrefsProvider>
    </QueryClientProvider>,
  );
  return { onRefresh, onLogout };
}

describe("TopBar on a phone", () => {
  it("shows refresh, freshness and the account menu without opening anything", () => {
    const { onRefresh } = renderBar();
    expect(screen.getByText("Live · 14:32")).toBeInTheDocument();
    const refresh = screen.getByRole("button", { name: "Refresh data" });
    expect(refresh).toBeEnabled();
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Account and sign out" })).toBeInTheDocument();
    // One tap swaps the currency on a phone.
    expect(screen.getByRole("button", { name: "Showing EUR, switch to USD" })).toBeInTheDocument();
  });

  it("signs out from the account menu in two taps", async () => {
    const user = userEvent.setup();
    const { onLogout } = renderBar();
    await user.click(screen.getByRole("button", { name: "Account and sign out" }));
    expect(screen.getByRole("menuitem", { name: /Theme/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it("disables refresh only while one runs", () => {
    renderBar({ refreshing: true });
    expect(screen.getByRole("button", { name: "Refresh data" })).toBeDisabled();
  });

  it("hides the health badge when all checks are OK", () => {
    renderBar({ health: { severity: "ok", count: 0 } });
    expect(screen.queryByRole("link", { name: /Health & Repair/ })).not.toBeInTheDocument();
  });

  it("shows a tinted health badge linking to Health & Repair", () => {
    renderBar({ health: { severity: "warn", count: 2 } });
    const link = screen.getByRole("link", { name: "Health & Repair: 2 warnings" });
    expect(link).toHaveAttribute("href", "/diagnostics");
    expect(link).toHaveClass("top-bar__health--warn");
  });

  it("renders the privacy toggle slot", () => {
    renderBar({ privacyToggle: <button type="button">Hide numbers</button> });
    expect(screen.getByRole("button", { name: "Hide numbers" })).toBeInTheDocument();
  });
});

describe("TopBar on desktop", () => {
  it("always shows the health link and a separate theme button", () => {
    renderBar({ compact: false });
    expect(screen.getByRole("link", { name: "Health & Repair" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Theme:/ })).toBeInTheDocument();
  });

  it("keeps the portfolio summary in the same place on every view (a placeholder until it loads)", () => {
    renderBar({ compact: false });
    expect(screen.getByLabelText("Portfolio summary")).toHaveTextContent("Portfolio…");
  });

  it("shows the value and day move when the shell has them", () => {
    renderBar({
      compact: false,
      summary: { value: 1234, currency: "EUR", pct: 0.01, move: 12, dayLabel: "today", estimated: false },
    });
    const box = screen.getByLabelText("Portfolio summary");
    expect(box).toHaveTextContent("€1,234.00");
    expect(box).toHaveTextContent("today");
    expect(box).not.toHaveTextContent("≈");
  });

  it("marks an ETF-twin estimate so the bar is never read as the official book", () => {
    renderBar({
      compact: false,
      summary: { value: 1234, currency: "EUR", pct: 0.01, move: 12, dayLabel: "today", estimated: true },
    });
    const box = screen.getByLabelText("Portfolio summary, estimated");
    expect(box).toHaveTextContent("≈");
    expect(box).toHaveTextContent("€1,234.00");
  });
});

describe("TopBar summary on a phone", () => {
  it("shows the compact value and day % beside the title", () => {
    renderBar({
      summary: { value: 123456, currency: "EUR", pct: -0.001, move: -12, dayLabel: "today", estimated: false },
    });
    expect(screen.getByLabelText("Portfolio summary")).toHaveTextContent(/€123/);
  });

  it("carries the estimate mark into the phone's mini summary too", () => {
    renderBar({
      summary: { value: 123456, currency: "EUR", pct: -0.001, move: -12, dayLabel: "today", estimated: true },
    });
    expect(screen.getByLabelText("Portfolio summary, estimated")).toHaveTextContent("≈");
  });
});
