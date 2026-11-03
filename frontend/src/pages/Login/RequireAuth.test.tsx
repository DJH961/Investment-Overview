import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGNED_IN_KEY } from "../../lib/queries";
import { RequireAuth } from "./RequireAuth";

function renderGuard() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/overview"]}>
        <Routes>
          <Route path="/login" element={<div>login page</div>} />
          <Route element={<RequireAuth />}>
            <Route path="/overview" element={<div>cached overview</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("RequireAuth", () => {
  it("shows the cached app at once on a slow connection when this browser was signed in", () => {
    localStorage.setItem(SIGNED_IN_KEY, "1");
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // never answers
    renderGuard();
    expect(screen.getByText("cached overview")).toBeInTheDocument();
  });

  it("waits for the probe on a browser that was not signed in", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderGuard();
    expect(screen.queryByText("cached overview")).toBeNull();
  });

  it("still redirects once the server says the session ended", async () => {
    localStorage.setItem(SIGNED_IN_KEY, "1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ authenticated: false, passkeys: 0 }))));
    renderGuard();
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(localStorage.getItem(SIGNED_IN_KEY)).toBeNull();
  });
});
