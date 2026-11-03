import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OfflineBanner, formatSavedAt } from "./OfflineBanner";

function renderBanner(state: "online" | "offline" | "unreachable") {
  const client = new QueryClient();
  client.setQueryData(["overview", "EUR"], { ok: true });
  return render(
    <QueryClientProvider client={client}>
      <OfflineBanner state={state} />
    </QueryClientProvider>,
  );
}

describe("OfflineBanner", () => {
  it("is hidden while online", () => {
    renderBanner("online");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says the data shown is the saved copy when offline", () => {
    renderBanner("offline");
    expect(screen.getByRole("status")).toHaveTextContent(/You're offline\. Showing data saved at/);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers a retry when the server can't be reached", () => {
    renderBanner("unreachable");
    expect(screen.getByRole("status")).toHaveTextContent("Can't reach the server.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("adds the date for data from an earlier day", () => {
    const now = new Date(2026, 10, 3, 12, 0).getTime();
    expect(formatSavedAt(new Date(2026, 10, 3, 9, 5).getTime(), now)).not.toMatch(/Nov/);
    expect(formatSavedAt(new Date(2026, 10, 2, 9, 5).getTime(), now)).toMatch(/2/);
  });
});
