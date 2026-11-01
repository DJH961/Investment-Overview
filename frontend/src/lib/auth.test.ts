import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(async () => ({ id: "cred", response: {} })),
  startRegistration: vi.fn(async () => ({ id: "newcred", response: {} })),
}));

import { startAuthentication } from "@simplewebauthn/browser";
import { ApiError } from "./api";
import { deletePasskey, listPasskeys, login, passkeyLogin, registerPasskey, safeNext } from "./auth";

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
});
