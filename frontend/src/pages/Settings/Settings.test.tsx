import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { Settings } from "./Settings";

const phone = vi.hoisted(() => ({ value: false }));
vi.mock("../../lib/useMediaQuery", async (orig) => ({
  ...(await orig<typeof import("../../lib/useMediaQuery")>()),
  useMediaQuery: () => phone.value,
}));

const field = (over: Record<string, unknown>) => ({
  choices: [],
  danger: null,
  default: null,
  env_bound: null,
  env_var: null,
  help: "",
  level: "user",
  max: null,
  min: null,
  nullable: false,
  restart_required: false,
  secret: false,
  since: "6.0",
  unit: null,
  ...over,
});
const val = (value: unknown, over: Record<string, unknown> = {}) => ({
  value,
  source: "default",
  default: value,
  env_value_present: false,
  modified_at: null,
  is_set: value !== null,
  stored_invalid: false,
  ...over,
});

const SCHEMA = {
  sections: [
    { id: "display", label: "Display" },
    { id: "data_refresh", label: "Data refresh" },
    { id: "providers", label: "Providers" },
  ],
  fields: [
    field({ key: "theme", type: "enum", section: "display", label: "Theme", choices: ["auto", "light", "dark"] }),
    field({
      key: "live_refresh_interval_seconds",
      type: "int",
      section: "display",
      label: "Live refresh interval",
      help: "How often prices refresh.",
      min: "15",
      max: "3600",
      unit: "s",
    }),
    field({ key: "boot.backfill_days", type: "int", section: "display", label: "Boot backfill", level: "advanced" }),
    field({
      key: "twin.divergence_window",
      type: "int",
      section: "data_refresh",
      label: "ETF twin accuracy: look back over",
      help: "The Holdings page shows how far the twin was from the real NAV.",
      min: "5",
      max: "250",
      unit: "sessions",
    }),
    field({ key: "tiingo.api_token", type: "string", section: "providers", label: "Tiingo API token", secret: true, nullable: true }),
  ],
};

let values: Record<string, unknown>;
let calls: { url: string; method: string; body: unknown }[];
let patchResponse: (body: { changes: Record<string, unknown> }) => Response;

beforeEach(() => {
  localStorage.clear();
  calls = [];
  values = {
    theme: val("auto"),
    live_refresh_interval_seconds: val(60, { source: "db", default: 60 }),
    "boot.backfill_days": val(14),
    "twin.divergence_window": val(20),
    "tiingo.api_token": val(null, { is_set: true, source: "db" }),
  };
  patchResponse = () => new Response(JSON.stringify({ changed: [], values }), { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.includes("/settings/schema")) return new Response(JSON.stringify(SCHEMA));
      if (url.includes("/settings/values") && method === "PATCH") return patchResponse(body);
      if (url.includes("/settings/values")) return new Response(JSON.stringify({ values }));
      if (url.includes("/settings/reset")) return new Response(JSON.stringify({ changed: body.keys, values }));
      return new Response("[]");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  phone.value = false;
});

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <Settings />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("Settings (schema form)", () => {
  it("renders a control per type with source badge and help", async () => {
    renderPage();
    expect(await screen.findByText("Live refresh interval")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Light" })).toBeInTheDocument();
    expect(screen.getByLabelText("Live refresh interval")).toHaveValue("60");
    expect(screen.getByText("How often prices refresh.")).toBeInTheDocument();
    expect(screen.getByTitle(/Set in the app/)).toHaveTextContent("App");
    // Advanced fields stay hidden until asked for.
    expect(screen.queryByText("Boot backfill")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show 1 advanced/ }));
    expect(screen.getByText("Boot backfill")).toBeInTheDocument();
  });

  it("blocks out-of-range input and shows server 422 errors per field", async () => {
    renderPage();
    const input = await screen.findByLabelText("Live refresh interval");
    fireEvent.change(input, { target: { value: "5" } });
    expect(screen.getByText("At least 15")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    patchResponse = () =>
      new Response(JSON.stringify({ detail: "Invalid settings", errors: { live_refresh_interval_seconds: "too fast for the provider" } }), {
        status: 422,
      });
    fireEvent.change(input, { target: { value: "20" } });
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("too fast for the provider")).toBeInTheDocument();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ changes: { live_refresh_interval_seconds: 20 } });
  });

  it("shows the ETF twin divergence window in Data refresh with its range and help", async () => {
    localStorage.setItem("iv.settings.section", JSON.stringify("data_refresh"));
    renderPage();
    const input = await screen.findByLabelText("ETF twin accuracy: look back over");
    expect(input).toHaveValue("20");
    expect(screen.getByText(/Range 5–250 sessions/)).toBeInTheDocument();
    expect(screen.getByText(/how far the twin was from the real NAV/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "3" } });
    expect(screen.getByText("At least 5")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ changes: { "twin.divergence_window": 40 } });
  });

  it("resets one field to its default", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Reset Live refresh interval/ }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/settings/reset"))).toBe(true));
    expect(calls.find((c) => c.url.includes("/settings/reset"))?.body).toEqual({ all: false, keys: ["live_refresh_interval_seconds"] });
  });

  it("keeps secrets write-only: shows set/not set, replace sends the new value", async () => {
    localStorage.setItem("iv.settings.section", JSON.stringify("providers"));
    renderPage();
    const card = (await screen.findByText("Tiingo API token")).closest(".setting-field") as HTMLElement;
    expect(within(card).getByText(/Set/)).toBeInTheDocument();
    expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();
    // Clear = back to the env value / default (a reset, not an empty write).
    expect(within(card).getByRole("button", { name: "Clear" })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Replace" }));
    fireEvent.change(within(card).getByPlaceholderText("New value"), { target: { value: "abc123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ changes: { "tiingo.api_token": "abc123" } });
  });

  it("asks for a fresh sign-in when the server says reauth_required", async () => {
    patchResponse = () =>
      new Response(JSON.stringify({ detail: { code: "reauth_required", message: "Please sign in again." } }), { status: 403 });
    localStorage.setItem("iv.settings.section", JSON.stringify("providers"));
    renderPage();
    const card = (await screen.findByText("Tiingo API token")).closest(".setting-field") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Replace" }));
    fireEvent.change(within(card).getByPlaceholderText("New value"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("link", { name: "Sign in again" })).toHaveAttribute("href", expect.stringContaining("reauth=1"));
  });

  it("filters by search across sections", async () => {
    renderPage();
    await screen.findByText("Live refresh interval");
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "tiingo" } });
    expect(screen.getByText("Tiingo API token")).toBeInTheDocument();
    expect(screen.queryByText("Live refresh interval")).not.toBeInTheDocument();
  });

  it("puts Save above the settings, before the first section", async () => {
    renderPage();
    const input = await screen.findByLabelText("Live refresh interval");
    fireEvent.change(input, { target: { value: "30" } });
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    const firstSection = screen.getByRole("heading", { name: "Display" });
    // DOCUMENT_POSITION_FOLLOWING: the section comes after the bar.
    expect(bar.compareDocumentPosition(firstSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("Settings on a phone", () => {
  it("shows every section on one page as foldable sections that remember their state", async () => {
    phone.value = true;
    renderPage();
    const display = await screen.findByRole("button", { name: /^Display/ });
    const providers = screen.getByRole("button", { name: /^Providers/ });
    // No section picker: Display is open by default, the rest folded.
    expect(screen.queryByRole("combobox", { name: "Section" })).not.toBeInTheDocument();
    expect(display).toHaveAttribute("aria-expanded", "true");
    expect(providers).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Live refresh interval")).toBeInTheDocument();
    expect(screen.queryByText("Tiingo API token")).not.toBeInTheDocument();
    fireEvent.click(providers);
    expect(providers).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Tiingo API token")).toBeInTheDocument();
    fireEvent.click(display);
    expect(screen.queryByText("Live refresh interval")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("iv.settings.open") ?? "[]")).toEqual(["providers"]);
  });
});
