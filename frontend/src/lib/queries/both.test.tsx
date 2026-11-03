import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, clearEtagCache } from "../api";
import { useOverview } from "./portfolio";

afterEach(() => {
  vi.unstubAllGlobals();
  clearEtagCache();
});

describe("/both ETag revalidation", () => {
  it("sends If-None-Match only once something is remembered and answers a 304 from memory", async () => {
    const calls: Array<Record<string, string>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push(headers);
      if (headers["If-None-Match"] === 'W/"abc"') return new Response(null, { status: 304 });
      return new Response(JSON.stringify({ EUR: { n: 1 }, USD: { n: 2 } }), {
        status: 200,
        headers: { ETag: 'W/"abc"' },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await api("/api/overview/both");
    const second = await api("/api/overview/both");
    expect(calls[0]!["If-None-Match"]).toBeUndefined();
    expect(calls[1]!["If-None-Match"]).toBe('W/"abc"');
    expect(second).toEqual(first);
    expect(second).toEqual({ EUR: { n: 1 }, USD: { n: 2 } });
  });

  it("never sends If-None-Match for other URLs", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response("{}", { status: 200, headers: { ETag: 'W/"x"' } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await api("/api/overview?ccy=EUR");
    await api("/api/overview?ccy=EUR");
    for (const c of fetchMock.mock.calls) expect((c[1]!.headers as Record<string, string>)["If-None-Match"]).toBeUndefined();
  });
});

describe("currency switch", () => {
  it("makes zero requests and shows the other currency's values", async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ EUR: { kpis: { total_value: "100" } }, USD: { kpis: { total_value: "108" } } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(({ ccy }: { ccy: "EUR" | "USD" }) => useOverview(ccy), {
      wrapper,
      initialProps: { ccy: "EUR" },
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect((result.current.data as unknown as { kpis: { total_value: string } }).kpis.total_value).toBe("100");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => rerender({ ccy: "USD" }));
    await waitFor(() =>
      expect((result.current.data as unknown as { kpis: { total_value: string } }).kpis.total_value).toBe("108"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
