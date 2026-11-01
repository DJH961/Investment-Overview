import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  browserSupportsWebAuthnAutofill: vi.fn(async () => false),
  startAuthentication: vi.fn(),
}));

import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { Login } from "./Login";

function renderLogin() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/login?next=%2Fholdings"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/holdings" element={<div>holdings page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(true);
});

describe("Login", () => {
  it("signs in and navigates to ?next", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    renderLogin();
    await userEvent.type(screen.getByLabelText("Password"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("holdings page")).toBeInTheDocument();
  });

  it("shows wrong-password and rate-limit errors", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: "x" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    renderLogin();
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Wrong password/)).toBeInTheDocument();

    fetchMock.mockImplementation(async () => new Response("{}", { status: 429 }));
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/try again in a minute/)).toBeInTheDocument();
  });

  it("shows an offline message when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    renderLogin();
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/offline/i));
  });

  it("toggles password visibility and hides passkey button without WebAuthn", async () => {
    renderLogin();
    expect(screen.getByRole("button", { name: "Sign in with passkey" })).toBeInTheDocument();
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input).toHaveAttribute("type", "text");
  });

  it("hides the passkey button when WebAuthn is unsupported", () => {
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(false);
    renderLogin();
    expect(screen.queryByRole("button", { name: "Sign in with passkey" })).toBeNull();
  });
});
