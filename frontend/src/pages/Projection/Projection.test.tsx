import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrefsProvider } from "../../lib/prefs";
import { axisLabel, detailRows, Projection } from "./Projection";

vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

const seed = (monthly: boolean) => ({
  as_of: "2026-10-31",
  avg_contribution: monthly ? "250" : "3000",
  ccy: "EUR",
  expected_rate: "0.07",
  monthly,
  starting_value: "10000",
  usd_per_eur: "1.1",
  xirr_available: true,
});

const calc = {
  as_of: "2026-10-31",
  categories: [],
  ccy: "EUR",
  fx_usd_per_eur: "1.1",
  instruments: [],
  projection_defaults: { month: seed(true), year: seed(false) },
  total_value: "10000",
};

const pt = (label: string, years: string) => ({
  label,
  years,
  contributed: "100",
  expected: "200",
  expected_real: "190",
  optimistic: "300",
  optimistic_real: "290",
  pessimistic: "150",
  pessimistic_real: "140",
});

function out(monthly: boolean) {
  return {
    as_of: "2026-10-31",
    assumptions: { expected_rate_default: "0.07", usd_per_eur: "1.1", xirr_available: true },
    ccy: "EUR",
    final: { expected: "200", optimistic: "300", pessimistic: "150", projected_growth: "50" },
    hits: { Expected: { label: "2031", years: "5.5" } },
    inputs: { band: "3", contribution: "250", expected_rate: "0.07", horizon: monthly ? 120 : 10, inflation: "0.02", stepup: "0", target: "5000" },
    monthly,
    points: monthly
      ? [pt("2026-11", "0.0833"), pt("2027-10", "1"), pt("2028-10", "2")]
      : [pt("2027", "1"), pt("2028", "2")],
    real: false,
    required_contribution: "400",
    starting_value: "10000",
    total_contributed: "100",
  };
}

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { monthly: boolean };
        return new Response(JSON.stringify(out(body.monthly)), { status: 200 });
      }
      return new Response(JSON.stringify({ EUR: calc, USD: calc }), { status: 200 });
    }),
  );
}

function wrap() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PrefsProvider>
        <Projection />
      </PrefsProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("Projection", () => {
  it("prefills inputs from the server seeds", async () => {
    stub();
    wrap();
    await waitFor(() => expect(screen.getByLabelText(/Expected return/)).toHaveValue("7"));
    expect(screen.getByLabelText(/Contribution per year/)).toHaveValue("3000");
    expect(await screen.findByText("Next 10 years")).toBeInTheDocument();
    expect(screen.getByLabelText("Horizon (years)")).toHaveValue(10);
  });

  it("never refills a suggested value while it is being edited", async () => {
    stub();
    wrap();
    const field = screen.getByLabelText(/Contribution per year/);
    await waitFor(() => expect(field).toHaveValue("3000"));
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "" } });
    // Cleared to type a new number: stays empty, suggestion only as a hint.
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("placeholder", "3000");
    fireEvent.change(field, { target: { value: "45" } });
    expect(field).toHaveValue("45");
    // Left empty and tapped away: the suggestion comes back.
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    expect(field).toHaveValue("3000");
  });

  it("labels months in monthly mode and restores saved inputs", async () => {
    stub();
    window.localStorage.setItem(
      "iv.projection.form",
      JSON.stringify({
        ccy: "EUR",
        form: {
          monthly: true, real: false, expected: "", band: "3", contribution: "", stepUp: "0",
          inflation: "2", target: "0", horizon: "",
        },
      }),
    );
    wrap();
    expect(await screen.findByText("Next 120 months")).toBeInTheDocument();
    expect(screen.getByLabelText("Horizon (months)")).toBeInTheDocument();
    expect(screen.getByLabelText(/Contribution per month/)).toHaveValue("250");
  });

  it("keeps the chart mounted while a second request is pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { monthly: boolean; horizon: number | null };
          if (body.horizon === 5) {
            // Never answers until the request is cancelled, like a slow server.
            return new Promise<Response>((_, reject) =>
              init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
            );
          }
          return new Response(JSON.stringify(out(body.monthly)), { status: 200 });
        }
        return new Response(JSON.stringify({ EUR: calc, USD: calc }), { status: 200 });
      }),
    );
    wrap();
    expect(await screen.findByText("Next 10 years")).toBeInTheDocument();
    const chart = screen.getByLabelText("Projected value scenarios");

    fireEvent.change(screen.getByLabelText("Horizon (years)"), { target: { value: "5" } });

    // Dimmed while the new result loads, but the same chart stays on screen.
    await waitFor(() => expect(chart.closest(".chart")).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByLabelText("Projected value scenarios")).toBe(chart);
    expect(screen.getByText("Next 10 years")).toBeInTheDocument();
  });

  it("formats the axis and filters monthly detail rows", () => {
    expect(axisLabel(10, true)).toBe("Month 120");
    expect(axisLabel(2, false)).toBe("Year 2");
    const rows = detailRows(out(true) as never);
    expect(rows.map((r) => r.label)).toEqual(["2027-10", "2028-10"]);
  });
});
