import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  browserSupportsWebAuthnAutofill: vi.fn(async () => false),
  startAuthentication: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}));

import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { rememberPasskeyDevice } from "../../lib/auth";
import { Login } from "./Login";

function renderLogin(url = "/login?next=%2Fholdings") {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
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
  vi.mocked(startAuthentication).mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

/** fetch stub: passkey options, then a 204 for verify. */
function passkeyServer() {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).endsWith("/options")
      ? new Response(JSON.stringify({ challenge: "c", rpId: "x" }), { status: 200 })
      : new Response(null, { status: 204 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

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

  it("explains a forced re-sign-in when ?reauth=1", () => {
    renderLogin("/login?reauth=1");
    expect(screen.getByRole("status")).toHaveTextContent("For your security, please sign in again to continue.");
  });

  it("shows no re-sign-in note by default", () => {
    renderLogin();
    expect(screen.queryByRole("status")).toBeNull();
  });

  describe("passkey auto-prompt", () => {
    it("opens the passkey dialog by itself on a device that used one before", async () => {
      rememberPasskeyDevice();
      passkeyServer();
      vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
      renderLogin();
      expect(await screen.findByText("holdings page")).toBeInTheDocument();
      expect(startAuthentication).toHaveBeenCalledWith(expect.objectContaining({ useBrowserAutofill: false }));
    });

    it("does not auto-prompt on a device without a passkey hint", async () => {
      passkeyServer();
      renderLogin();
      await new Promise((r) => setTimeout(r, 20));
      expect(startAuthentication).not.toHaveBeenCalled();
    });

    it("does not auto-prompt right after signing out on purpose", async () => {
      rememberPasskeyDevice();
      sessionStorage.setItem("iv.signed-out", "1");
      passkeyServer();
      renderLogin();
      await new Promise((r) => setTimeout(r, 20));
      expect(startAuthentication).not.toHaveBeenCalled();
    });

    it("falls back to the form quietly when the dialog is dismissed", async () => {
      rememberPasskeyDevice();
      passkeyServer();
      vi.mocked(startAuthentication).mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
      renderLogin();
      await waitFor(() => expect(startAuthentication).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByRole("button", { name: "Sign in with passkey" })).toBeEnabled());
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
