import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { fieldErrors, transactionsQueryString } from "./ledger";

describe("ledger helpers", () => {
  it("builds a query string skipping empty values", () => {
    expect(transactionsQueryString({ limit: 50, offset: 0, q: "", kind: "buy", hide_sweeps: true })).toBe(
      "limit=50&offset=0&kind=buy&hide_sweeps=true",
    );
  });

  it("maps 422 details to field errors", () => {
    const err = new ApiError(422, "x", { detail: [{ loc: ["body", "date"], msg: "bad date", type: "x" }] });
    expect(fieldErrors(err)).toEqual({ date: "bad date" });
  });

  it("falls back to a form error", () => {
    expect(fieldErrors(new ApiError(409, "Conflict"))).toEqual({ _form: "Conflict" });
  });
});
