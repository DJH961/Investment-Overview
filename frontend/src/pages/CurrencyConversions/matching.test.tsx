import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import type { DepositMatch, FxConversion } from "../../lib/queries/manage";
import { RateChip } from "../Transactions/RateChip";
import {
  conversionName,
  depositsById,
  depositStatusLook,
  ecbCell,
  offPctText,
  offPctWords,
  trimDecimal,
  offEcbText,
  pinCandidates,
  rateChipLabel,
  validatePins,
} from "./matching";
import { PinDialog } from "./PinDialog";

afterEach(() => vi.unstubAllGlobals());

const conv = (id: number, date: string, usd = "1000"): FxConversion =>
  ({
    id,
    date,
    eur_sent: "900",
    usd_received: usd,
    rate: "1.1111",
    all_in_rate: "1.1111",
    kept_usd: "0",
    fees_eur: null,
    note: null,
    provider: null,
    used_by: [],
    remaining_usd: usd,
    ecb_rate: null,
    from_ccy: "EUR",
    is_estimate: false,
    to_ccy: "USD",
    effective_rate: "1.1111",
  }) as FxConversion;

const deposit = (over: Partial<DepositMatch> = {}): DepositMatch =>
  ({
    transaction_id: 7,
    date: "2026-03-06",
    usd: "1500",
    status: "matched",
    slices: [],
    pinned: false,
    fallback_usd: null,
    ...over,
  }) as DepositMatch;

describe("conversionName", () => {
  it("joins date, amounts and rate in the app formats", () => {
    const name = conversionName({ date: "2025-03-12", eur_sent: "2770", usd_received: "3000", rate: "1.0830" });
    expect(name.split(" · ")).toHaveLength(3);
    expect(name).toContain("1.0830");
    expect(name).toMatch(/2.?770/);
    expect(name).toMatch(/3.?000/);
  });
});

describe("status mapping", () => {
  it("maps each status to a label and icon", () => {
    expect(depositStatusLook("matched", false)).toMatchObject({ label: "Matched", icon: "check" });
    expect(depositStatusLook("partial", false)).toMatchObject({ label: "Partly matched", icon: "half" });
    expect(depositStatusLook("ecb_only", false)).toMatchObject({ label: "ECB only", icon: "ecb" });
    expect(depositStatusLook("matched", true)).toMatchObject({ label: "Pinned", icon: "pin" });
  });
  it("labels the Transactions chip", () => {
    expect(rateChipLabel("matched")).toBe("Your rate");
    expect(rateChipLabel("partial")).toBe("Your rate");
    expect(rateChipLabel("ecb_only")).toBe("ECB");
  });
});

describe("offEcbText", () => {
  it("says under or over, or nothing without both rates", () => {
    expect(offEcbText(1.0830, 1.0855)).toMatch(/0\D23 % under it/);
    expect(offEcbText(1.09, 1.0855)).toMatch(/over it/);
    expect(offEcbText(null, 1.0855)).toBeNull();
  });
});

describe("pin validation", () => {
  const conversions = [conv(1, "2026-03-09", "2000"), conv(2, "2026-03-20", "2000")];
  const d = { date: "2026-03-06", usd: "1500" };
  it("lists only conversions up to 7 days after the deposit", () => {
    expect(pinCandidates(d, conversions).map((c) => c.id)).toEqual([1]);
  });
  it("accepts a valid pin", () => {
    expect(validatePins(d, [{ conversion_id: 1, usd: "500" }], conversions)).toBeNull();
  });
  it("rejects too-late conversions, over-pinning and bad amounts", () => {
    expect(validatePins(d, [{ conversion_id: 2, usd: "10" }], conversions)).toMatch(/7 days/);
    expect(validatePins(d, [{ conversion_id: 1, usd: "1501" }], conversions)).toMatch(/more than the deposit/);
    expect(validatePins(d, [{ conversion_id: 1, usd: "0" }], conversions)).toMatch(/above zero/);
    expect(validatePins(d, [{ conversion_id: 1, usd: "2500" }], [conv(1, "2026-03-09", "2000")])).toMatch(/more/);
  });
});

describe("PinDialog", () => {
  it("shows the validation message and sends nothing", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method) calls.push(init.method);
        return new Response("{}", { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <PinDialog deposit={deposit()} conversions={[conv(1, "2026-03-09")]} onClose={() => undefined} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save pin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/more dollars than the conversion|more than the deposit/);
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "500,5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save pin" }));
    await waitFor(() => expect(calls).toEqual(["PUT"]));
  });
});

describe("Transactions chip join", () => {
  it("joins by deposit id and renders the chip label", () => {
    const map = depositsById([deposit({ transaction_id: 7, status: "ecb_only" }), deposit({ transaction_id: 8 })]);
    const m = map.get(7);
    expect(m).toBeDefined();
    expect(map.get(99)).toBeUndefined();
    const onOpen = vi.fn();
    render(
      <MemoryRouter>
        <RateChip match={m as DepositMatch} onOpen={onOpen} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /ECB/ }));
    expect(onOpen).toHaveBeenCalledWith(m);
  });
});

describe("table cells", () => {
  it("trims the server's padding from a prefilled figure", () => {
    expect(trimDecimal("861.730000")).toBe("861.73");
    expect(trimDecimal("1000.000000")).toBe("1000");
    expect(trimDecimal("100")).toBe("100");
    expect(trimDecimal(null)).toBe("");
  });
  it("shows vs ECB in the app's one signed percent format", () => {
    expect(offPctText("-0.0056")).toBe("-0.56%");
    expect(offPctText("0.0123")).toBe("+1.23%");
    expect(offPctText(null)).toBe("–");
    expect(offPctWords("-0.0056")).toMatch(/0\D56 % below ECB/);
  });
  it("labels a weekend fixing with its own date, and a missing one with a reason", () => {
    const weekend = ecbCell({ date: "2026-11-22", ecb_rate: "1.1612", ecb_rate_date: "2026-11-20" }, "2026-11-23");
    expect(weekend.text).toMatch(/1\D1612/);
    expect(weekend.from).toContain("20 Nov 2026");
    expect(ecbCell({ date: "2026-11-20", ecb_rate: "1.1612", ecb_rate_date: "2026-11-20" }).from).toBeNull();
    expect(ecbCell({ date: "2026-06-06", ecb_rate: null, ecb_rate_date: null }, "2026-11-23").text).toBe("No fixing");
    expect(ecbCell({ date: "2026-11-23", ecb_rate: null, ecb_rate_date: null }, "2026-11-23").text).toBe("Not yet");
  });
  it("lists pin candidates nearest date first", () => {
    const list = [conv(1, "2026-03-12"), conv(2, "2026-03-05"), conv(3, "2026-03-07")];
    expect(pinCandidates({ date: "2026-03-06" }, list).map((c) => c.id)).toEqual([3, 2, 1]);
  });
});
