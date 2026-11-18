import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { BriefVisitCard, isoToWallTime, wallTimeToIso } from "./BriefVisitCard";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "Europe/Berlin" }));

let calls: { url: string; method: string; body: unknown }[];
let brief: Record<string, unknown>;
let failPut: boolean;
let qc: QueryClient;

beforeEach(() => {
  localStorage.clear();
  calls = [];
  failPut = false;
  brief = { due: false, visit_from: "2026-11-18T21:10:00Z", last_seen_at: "2026-11-18T20:00:00Z" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.includes("/api/brief/visit")) {
        if (method === "PUT") {
          if (failPut) return new Response(JSON.stringify({ detail: "visit_from must be in the past" }), { status: 422 });
          brief = { ...brief, visit_from: body.visit_from };
        } else brief = { ...brief, visit_from: null };
      }
      return new Response(JSON.stringify(brief), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderCard() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <BriefVisitCard />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function openCard() {
  fireEvent.click(await screen.findByRole("button", { name: /Daily Brief: last visit/ }));
}

describe("wall time helpers", () => {
  it("convert in the owner's zone, winter and summer", () => {
    expect(wallTimeToIso("2026-11-18T22:10", "Europe/Berlin")).toBe("2026-11-18T21:10:00.000Z");
    expect(wallTimeToIso("2026-07-01T22:10", "Europe/Berlin")).toBe("2026-07-01T20:10:00.000Z");
    expect(isoToWallTime("2026-11-18T21:10:00Z", "Europe/Berlin")).toBe("2026-11-18T22:10");
    expect(wallTimeToIso("garbage", "UTC")).toBeNull();
  });
});

describe("BriefVisitCard", () => {
  it("shows the current values in the owner's zone", async () => {
    renderCard();
    await openCard();
    expect(await screen.findByTestId("brief-visit-from")).toHaveTextContent("22:10");
    expect(screen.getByTestId("brief-last-seen")).toHaveTextContent("21:00");
  });

  it("Set sends an ISO instant and puts the answer in the brief cache", async () => {
    renderCard();
    await openCard();
    const input = await screen.findByLabelText("Pretend last visit");
    fireEvent.change(input, { target: { value: "2026-11-17T09:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ visit_from: "2026-11-17T08:30:00.000Z" });
    await waitFor(() =>
      expect((qc.getQueryData(["brief"]) as { visit_from: string }).visit_from).toBe("2026-11-17T08:30:00.000Z"),
    );
  });

  it("shows the server's error", async () => {
    failPut = true;
    renderCard();
    await openCard();
    fireEvent.change(await screen.findByLabelText("Pretend last visit"), { target: { value: "2030-01-01T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/in the past/);
  });

  it("Back to automatic sends DELETE and clears the override", async () => {
    renderCard();
    await openCard();
    fireEvent.click(await screen.findByRole("button", { name: "Back to automatic" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("brief-visit-from")).toHaveTextContent(/automatic/));
  });
});
