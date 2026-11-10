import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(async () => ({ id: "cred", response: {} })),
  startRegistration: vi.fn(async () => ({ id: "newcred", response: {} })),
}));

vi.mock("./live", () => ({ reopenLiveStream: vi.fn() }));

import { startAuthentication } from "@simplewebauthn/browser";
import { reopenLiveStream } from "./live";
import { ApiError } from "./api";
import { QueryClient } from "@tanstack/react-query";
import {
  deletePasskey,
  invalidateAuth,
  listPasskeys,
  login,
  logout,
  passkeyLogin,
  registerPasskey,
  safeNext,
} from "./auth";
import { QUERY_CACHE_KEY, queryClient } from "./queries";

function respond(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

afterEach(() => vi.unstubAllGlobals());

describe("auth", () => {
  it("login posts the password and resolves on 204", async () => {
    const fetchMock = vi.fn(async () => respond(204));
    vi.stubGlobal("fetch", fetchMock);
    await expect(login("pw")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.body).toBe(JSON.stringify({ password: "pw" }));
  });

  it("reopens the live stream after a successful sign-in, not after a failed one", async () => {
    vi.mocked(reopenLiveStream).mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => respond(401, { detail: "bad" })));
    await expect(login("x")).rejects.toBeInstanceOf(ApiError);
    expect(reopenLiveStream).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => respond(204)));
    await login("pw");
    expect(reopenLiveStream).toHaveBeenCalledOnce();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.endsWith("options") ? respond(200, { challenge: "abc" }) : respond(204))),
    );
    await passkeyLogin();
    expect(reopenLiveStream).toHaveBeenCalledTimes(2);
  });

  it("login surfaces 401 and 429 as ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(401, { detail: "bad" })));
    await expect(login("x")).rejects.toMatchObject({ status: 401 });
    vi.stubGlobal("fetch", vi.fn(async () => respond(429, { detail: "slow" })));
    await expect(login("x")).rejects.toBeInstanceOf(ApiError);
  });

  it("passkey login runs options, authentication, verify", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("options") ? respond(200, { challenge: "abc" }) : respond(204),
    );
    vi.stubGlobal("fetch", fetchMock);
    await passkeyLogin();
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "abc" }, useBrowserAutofill: false });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "/api/auth/passkey/login/options",
      "/api/auth/passkey/login/verify",
    ]);
  });

  it("names the passkey this device used last, and forgets it when it fails", async () => {
    localStorage.removeItem("iv.passkey.id");
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("options") ? respond(200, { challenge: "abc" }) : respond(204),
    );
    vi.stubGlobal("fetch", fetchMock);
    const optionsBody = (i: number) => (fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].body;

    await passkeyLogin(); // first time: no id yet, the browser shows its picker
    expect(optionsBody(0)).toBe("{}");
    expect(localStorage.getItem("iv.passkey.id")).toBe("cred");

    await passkeyLogin(); // next time: straight to that passkey
    expect(optionsBody(2)).toBe(JSON.stringify({ credential_id: "cred" }));

    await passkeyLogin(true); // autofill lists every passkey
    expect(optionsBody(4)).toBe("{}");

    vi.mocked(startAuthentication).mockRejectedValueOnce(new Error("NotAllowedError"));
    await expect(passkeyLogin()).rejects.toThrow();
    expect(localStorage.getItem("iv.passkey.id")).toBeNull();
  });

  it("registers, lists and deletes passkeys", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("register/options")) return respond(200, { challenge: "c" });
      if (url.endsWith("/passkeys")) return respond(200, [{ id: 1, name: "Phone" }]);
      return respond(204);
    });
    vi.stubGlobal("fetch", fetchMock);
    await registerPasskey("Phone");
    expect(await listPasskeys()).toEqual([{ id: 1, name: "Phone" }]);
    await deletePasskey(1);
    const last = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(last[0]).toBe("/api/auth/passkeys/1");
    expect(last[1].method).toBe("DELETE");
  });

  it("safeNext only allows in-app paths", () => {
    expect(safeNext("?next=%2Fholdings")).toBe("/holdings");
    expect(safeNext("?next=https%3A%2F%2Fevil.com")).toBe("/");
    expect(safeNext("?next=%2F%2Fevil.com")).toBe("/");
    expect(safeNext("")).toBe("/");
  });
  it("logout wipes cached portfolio data, even when the request fails", async () => {
    for (const status of [204, 500]) {
      queryClient.setQueryData(["overview", "EUR"], { total: 1 });
      localStorage.setItem(QUERY_CACHE_KEY, "{}");
      vi.stubGlobal("fetch", vi.fn(async () => respond(status)));
      const done = logout();
      if (status === 204) await expect(done).resolves.toBeUndefined();
      else await expect(done).rejects.toBeInstanceOf(ApiError);
      expect(queryClient.getQueryData(["overview", "EUR"])).toBeUndefined();
      expect(localStorage.getItem(QUERY_CACHE_KEY)).toBeNull();
    }
  });

  it("safeNext rejects backslash tricks", () => {
    expect(safeNext("?next=/%5C%5Cevil.example")).toBe("/");
    expect(safeNext("?next=/settings")).toBe("/settings");
  });
});

describe("invalidateAuth", () => {
  it("a sign-in check sent before the login cannot land afterwards and bounce to /login", async () => {
    const qc = new QueryClient();
    let release: (v: { authenticated: boolean }) => void = () => {};
    // A check started before the sign-in (no session cookie yet): answers "signed out" late.
    const stale = qc
      .fetchQuery({
        queryKey: ["auth", "me"],
        queryFn: ({ signal }) =>
          new Promise<{ authenticated: boolean }>((resolve, reject) => {
            release = resolve;
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      })
      .catch(() => undefined);
    await invalidateAuth(qc);
    release({ authenticated: false });
    await stale;
    // Nothing cached: the guard asks the server again (now with the session cookie).
    expect(qc.getQueryData(["auth", "me"])).toBeUndefined();
  });
});
