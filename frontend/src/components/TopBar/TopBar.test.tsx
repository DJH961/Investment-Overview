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
    expect(screen.getByLabelText("Reporting currency")).toBeInTheDocument();
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
    expect(screen.queryByRole("link", { name: /Data health/ })).not.toBeInTheDocument();
  });

  it("shows a tinted health badge linking to Data health", () => {
    renderBar({ health: { severity: "warn", count: 2 } });
    const link = screen.getByRole("link", { name: "Data health: 2 warnings" });
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
    expect(screen.getByRole("link", { name: "Data health" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Theme:/ })).toBeInTheDocument();
  });
});
