/* eslint-disable @typescript-eslint/no-explicit-any */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSaveAccount } from "./accounts";
import { useDeleteTransaction, useUpdateTransaction } from "./ledger";
import { useUpdateInstrument } from "./instruments";
import { usePatchSettings } from "./settings";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}
const row = (id: number) => ({ id, date: "2026-01-01", kind: "buy", description: "x" });
const page = () => ({ rows: [row(1), row(2)], total: 2 });

function stubFetch(status: number, body: unknown, gate?: Promise<void>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (gate) await gate;
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

describe("optimistic writes", () => {
  it("delete: row leaves the cached page at once, comes back on error", async () => {
    const { qc, wrapper } = setup();
    qc.setQueryData(["transactions", { limit: 50 }], page());
    let open!: () => void;
    stubFetch(500, { detail: "boom" }, new Promise<void>((r) => (open = r)));
    const { result } = renderHook(() => useDeleteTransaction(), { wrapper });
    act(() => result.current.mutate(1));
    await waitFor(() => expect((qc.getQueryData(["transactions", { limit: 50 }]) as any).rows.length).toBe(1));
    open();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((qc.getQueryData(["transactions", { limit: 50 }]) as any).rows.length).toBe(2);
    expect((qc.getQueryData(["transactions", { limit: 50 }]) as any).total).toBe(2);
  });

  it("delete: lowers total while pending", async () => {
    const { qc, wrapper } = setup();
    qc.setQueryData(["transactions", { limit: 50 }], page());
    let open!: () => void;
    stubFetch(204, null, new Promise<void>((r) => (open = r)));
    const { result } = renderHook(() => useDeleteTransaction(), { wrapper });
    act(() => result.current.mutate(2));
    await waitFor(() => expect((qc.getQueryData(["transactions", { limit: 50 }]) as any).total).toBe(1));
    open();
  });

  it("update: edits the cached row, rolls back on error", async () => {
    const { qc, wrapper } = setup();
    qc.setQueryData(["transactions", { limit: 50 }], page());
    let open!: () => void;
    stubFetch(422, { detail: "bad" }, new Promise<void>((r) => (open = r)));
    const { result } = renderHook(() => useUpdateTransaction(), { wrapper });
    act(() =>
      result.current.mutate({ id: 1, body: { account_id: 3, date: "2026-02-02", kind: "sell", route_money_market: false } as any }),
    );
    await waitFor(() => expect((qc.getQueryData(["transactions", { limit: 50 }]) as any).rows[0].date).toBe("2026-02-02"));
    open();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((qc.getQueryData(["transactions", { limit: 50 }]) as any).rows[0].date).toBe("2026-01-01");
  });

  it("instrument edit and account edit patch the cached lists", async () => {
    const { qc, wrapper } = setup();
    qc.setQueryData(["instruments"], [{ id: 1, name: "Old", active: true }]);
    qc.setQueryData(["accounts"], [{ id: 5, account_label: "A", broker: "vanguard", native_currency: "USD", account_type: null }]);
    let open!: () => void;
    stubFetch(200, {}, new Promise<void>((r) => (open = r)));
    const inst = renderHook(() => useUpdateInstrument(), { wrapper });
    const acc = renderHook(() => useSaveAccount(), { wrapper });
    act(() => inst.result.current.mutate({ id: 1, patch: { name: "New" } }));
    act(() =>
      acc.result.current.mutate({ id: 5, body: { account_label: "B", broker: "vanguard", native_currency: "USD" } }),
    );
    await waitFor(() => expect((qc.getQueryData(["instruments"]) as any)[0].name).toBe("New"));
    await waitFor(() => expect((qc.getQueryData(["accounts"]) as any)[0].account_label).toBe("B"));
    open();
  });

  it("settings patch shows the new value, rolls back on error", async () => {
    const { qc, wrapper } = setup();
    qc.setQueryData(["settings", "values"], { theme: { value: "light" }, other: { value: 1 } });
    let open!: () => void;
    stubFetch(422, { errors: { theme: "no" } }, new Promise<void>((r) => (open = r)));
    const { result } = renderHook(() => usePatchSettings(), { wrapper });
    act(() => result.current.mutate({ theme: "dark" }));
    await waitFor(() => expect((qc.getQueryData(["settings", "values"]) as any).theme.value).toBe("dark"));
    expect((qc.getQueryData(["settings", "values"]) as any).other.value).toBe(1);
    open();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((qc.getQueryData(["settings", "values"]) as any).theme.value).toBe("light");
  });
});
