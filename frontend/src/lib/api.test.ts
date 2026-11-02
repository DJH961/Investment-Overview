import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, addAuthLostListener, api, reauthLoginPath, setReauthHandler, setUnauthorizedHandler } from "./api";

function respond(status: number, body?: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("returns parsed JSON and sends same-origin credentials", async () => {
    respond(200, { ok: true });
    await expect(api("/api/x")).resolves.toEqual({ ok: true });
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
  });
  it("returns undefined for 204", async () => {
    respond(204);
    await expect(api("/api/x", { method: "POST" })).resolves.toBeUndefined();
  });
  it("throws ApiError with status and detail", async () => {
    respond(422, { detail: "bad input" });
    await expect(api("/api/x")).rejects.toMatchObject({ status: 422, message: "bad input" });
  });
  it("calls the unauthorized handler on 401 and still throws", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    respond(401, { detail: "no" });
    await expect(api("/api/x")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("skips the redirect when asked", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    respond(401, {});
    await expect(api("/api/auth/me", { skipAuthRedirect: true })).rejects.toBeInstanceOf(ApiError);
    expect(handler).not.toHaveBeenCalled();
  });
  it("notifies auth-lost listeners on every 401, even without the redirect", async () => {
    setUnauthorizedHandler(vi.fn());
    const lost = vi.fn();
    const off = addAuthLostListener(lost);
    respond(401, {});
    await expect(api("/api/x")).rejects.toBeInstanceOf(ApiError);
    respond(401, {});
    await expect(api("/api/auth/login", { method: "POST", skipAuthRedirect: true })).rejects.toBeInstanceOf(ApiError);
    expect(lost).toHaveBeenCalledTimes(2);
    off();
    respond(401, {});
    await expect(api("/api/x")).rejects.toBeInstanceOf(ApiError);
    expect(lost).toHaveBeenCalledTimes(2);
  });
  it("asks for a new sign-in on 403 reauth_required", async () => {
    const reauth = vi.fn();
    setReauthHandler(reauth);
    respond(403, { detail: { code: "reauth_required", message: "Please sign in again to continue." } });
    await expect(api("/api/backup")).rejects.toMatchObject({
      status: 403,
      code: "reauth_required",
      message: "Please sign in again to continue.",
    });
    expect(reauth).toHaveBeenCalledTimes(1);
    respond(403, { detail: "Cross-origin request rejected." });
    await expect(api("/api/x", { method: "POST" })).rejects.toMatchObject({ status: 403, code: undefined });
    expect(reauth).toHaveBeenCalledTimes(1);
  });
  it("builds a login path that returns to the page", () => {
    expect(reauthLoginPath("/settings?tab=security")).toBe("/login?next=%2Fsettings%3Ftab%3Dsecurity&reauth=1");
  });
});
