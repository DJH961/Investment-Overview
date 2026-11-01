import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, setUnauthorizedHandler } from "./api";

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
});
