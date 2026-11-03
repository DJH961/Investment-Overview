import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ServerStatus } from "../../lib/serverStatus";
import { OfflineBanner } from "./OfflineBanner";

function renderServer(server: ServerStatus) {
  const client = new QueryClient();
  client.setQueryData(["overview", "EUR"], { ok: true });
  return render(
    <QueryClientProvider client={client}>
      <OfflineBanner state="online" server={server} />
    </QueryClientProvider>,
  );
}

describe("OfflineBanner server states", () => {
  it("is hidden when idle", () => {
    renderServer({ kind: "idle" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("announces a restart with version, eta and the time of the shown numbers", () => {
    renderServer({ kind: "restarting", version: "6.3.0", etaS: 20, since: Date.now() });
    expect(screen.getByRole("status")).toHaveTextContent(
      /Updating to 6\.3\.0, back in about 20 s\. Showing numbers from \d{1,2}[:.]\d{2}/,
    );
  });

  it("shows the planned update time", () => {
    renderServer({ kind: "planned", at: "21:30" });
    expect(screen.getByRole("status")).toHaveTextContent("Update planned at 21:30");
  });

  it("says the connection is lost", () => {
    renderServer({ kind: "lost", since: Date.now() });
    expect(screen.getByRole("status")).toHaveTextContent("Connection to the server lost, retrying");
  });

  it("confirms the update", () => {
    renderServer({ kind: "updated", version: "6.3.0" });
    expect(screen.getByRole("status")).toHaveTextContent("Updated to 6.3.0");
  });
});
