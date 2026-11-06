import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { toHealthStatus } from "../../lib/health";
import { Diagnostics } from "./Diagnostics";

const check = (over: Record<string, unknown>) => ({
  severity: "ok",
  count: 0,
  detail: "",
  examples: [],
  actions: [],
  ...over,
});

const DIAG = {
  status: "warning",
  count: 2,
  generated_at: "2025-05-01T00:00:00",
  checks: [
    check({ id: "fine", title: "Positions add up" }),
    check({
      id: "ecb_fallback_deposits",
      title: "Deposits paid at the ECB rate",
      severity: "warning",
      count: 1,
      detail: "Add the missing conversion.",
      examples: ["2025-04-10 (500 USD)"],
      actions: [{ kind: "link", id: "ecb", label: "Add conversion", params: {}, danger: "none", href: "/conversions" }],
    }),
    check({
      id: "stale_prices",
      title: "Stale prices",
      severity: "error",
      count: 2,
      detail: "Two holdings have old prices.",
      actions: [{ kind: "job", id: "prices.refresh", label: "Refresh prices", params: { force: true }, danger: "none", href: null }],
    }),
  ],
  providers: [],
  provider_log: [{ provider: "yfinance", status: "ok", message: "fetched 3", at: "2025-05-01T00:00:00Z" }],
  problems: [{ id: 7, source: "refresh", message: "timeout", severity: "error", at: "2025-05-01T00:00:00Z" }],
  refresh: { active: false, source: null, last_update_at: null, historical: false, progress_done: 0, progress_total: 0, progress_label: null },
};

const job = (over: Record<string, unknown>) => ({
  backup_first: false,
  confirm_word: null,
  danger: "none",
  description: "",
  heavy: false,
  last_run: null,
  params: [],
  running: false,
  ...over,
});

const CATALOGUE = {
  generated_at: "2025-05-01T00:00:00Z",
  groups: [
    { id: "prices", label: "Prices" },
    { id: "cache", label: "Cache" },
  ],
  heavy_job: null,
  recent: [],
  jobs: [
    job({ id: "prices.refresh", label: "Refresh prices now", group: "prices", description: "Fetch the latest prices." }),
    job({
      id: "cache.reset",
      label: "Reset cached market data",
      group: "cache",
      description: "Deletes all prices.",
      danger: "typed",
      confirm_word: "RESET",
      backup_first: true,
      heavy: true,
    }),
  ],
};

let calls: { url: string; method: string; body: unknown }[];

const TIINGO = {
  configured: true,
  hourly_cap: 10,
  daily_cap: 200,
  hour_used: 3,
  day_used: 12,
  remaining: 7,
  hour_resets_at: "2025-05-01T11:00:00Z",
  day_resets_at: "2025-05-02T04:00:00Z",
  rate_limited_at: null,
  nav_probes_today: 2,
  last_status: "ok",
  last_message: "IEX VTI 78 intraday bar(s)",
  last_at: "2025-05-01T10:30:00Z",
  uses: [{ title: "Graph gap fill", detail: "Fills holes in the graphs." }],
};

beforeEach(() => {
  localStorage.clear();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.includes("/api/maintenance/jobs/") && method === "POST") {
        const id = url.split("/jobs/")[1];
        return json({ id: `run-${id}`, job: id, status: "running", actor: "session", params: {}, result: null, error: null, started_at: "2025-05-01T10:00:00Z", finished_at: null }, 202);
      }
      if (url.includes("/api/maintenance/runs/"))
        return json({ id: "run-x", job: "x", status: "succeeded", actor: "s", params: {}, result: { updated: 3 }, error: null, started_at: "2025-05-01T10:00:00Z", finished_at: "2025-05-01T10:00:05Z" });
      if (url.includes("/api/maintenance/jobs")) return json(CATALOGUE);
      if (url.includes("/api/maintenance/tiingo")) return json(TIINGO);
      if (url.includes("/problems/")) return json({ dismissed: 1 });
      if (url.includes("/api/diagnostics")) return json(DIAG);
      if (url.includes("/refresh")) return json({ running: false });
      return json([]);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPage(path = "/diagnostics") {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Diagnostics />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("Health & Repair: Health tab", () => {
  it("lists problems first, worst first, with example chips and fix actions", async () => {
    renderPage();
    const attention = (await screen.findByText("Needs attention")).closest("section") as HTMLElement;
    const titles = within(attention)
      .getAllByRole("listitem")
      .map((li) => li.querySelector(".diagnostics__issue-title")?.textContent)
      .filter(Boolean);
    expect(titles).toEqual(["Stale prices", "Deposits paid at the ECB rate"]);
    expect(within(attention).getByText("2025-04-10 (500 USD)")).toBeInTheDocument();
    expect(within(attention).getByRole("link", { name: /Add conversion/ })).toHaveAttribute("href", "/conversions");

    fireEvent.click(within(attention).getByRole("button", { name: "Refresh prices" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/jobs/prices.refresh"))).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ params: { force: true } });
  });

  it("dismisses a recent problem", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss problem: timeout" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/diagnostics/problems/7/dismiss"))).toBe(true));
  });
});

describe("Health & Repair: Repair tab", () => {
  it("runs a safe job straight away and shows its progress", async () => {
    renderPage("/diagnostics?tab=repair");
    const row = (await screen.findByText("Refresh prices now")).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Run" }));
    expect(await within(row).findByText(/Running since|Done/)).toBeInTheDocument();
  });

  it("needs the typed word for a destructive job and says manual fixes go", async () => {
    renderPage("/diagnostics?tab=repair");
    const row = (await screen.findByText("Reset cached market data")).closest("li") as HTMLElement;
    expect(within(row).getByText(/also deletes your manual fixes/)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Run" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/backup of the database is taken/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Run" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Type RESET to confirm"), { target: { value: "reset" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Type RESET to confirm"), { target: { value: "RESET" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/jobs/cache.reset"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/jobs/cache.reset"))?.body).toEqual({ params: {}, confirm: "RESET" });
  });
});

describe("useHealthStatus mapping", () => {
  it("counts checks and background problems", () => {
    expect(toHealthStatus({ severity: "ok", count: 0, problems: 0 })).toMatchObject({ attention: false, count: 0 });
    expect(toHealthStatus({ severity: "ok", count: 0, problems: 2 })).toMatchObject({ attention: true, severity: "warning", count: 2 });
    expect(toHealthStatus({ severity: "error", count: 1, problems: 0 }).label).toContain("1 item need");
  });
});

describe("Health & Repair: Tiingo backup", () => {
  it("shows how many Tiingo requests are used and left, and what the key is for", async () => {
    renderPage("/diagnostics?tab=repair");
    expect(await screen.findByText(/3 of 10 used · 7 left/)).toBeInTheDocument();
    expect(screen.getByText(/12 of 200 used/)).toBeInTheDocument();
    expect(screen.getByText("Graph gap fill.")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /This hour: 3 of 10/ })).toBeInTheDocument();
  });
});
