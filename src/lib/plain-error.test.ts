import { describe, expect, it } from "vitest";
import { plainError } from "./plain-error";

describe("plainError", () => {
  it("turns each machine shape into one plain line and keeps the original", () => {
    const shapes: Array<[string, RegExp]> = [
      ["Failed to fetch", /could not reach its helper/],
      ["TypeError: Failed to fetch", /could not reach its helper/],
      ["ECONNREFUSED 127.0.0.1:8799", /could not reach its helper/],
      ["401", /sign-in has expired/],
      ["HTTP 429 Too Many Requests", /busy right now/],
      ["503 Service Unavailable", /hit a snag/],
      ["404", /could not be found/],
      ['{"error":{"message":"x"}}', /reply it could not read/],
      ["TypeError: x is undefined\n    at run (/app/a.js:1:2)", /Something went wrong/],
      ["ERR_INVALID_ARG_TYPE", /Something went wrong/],
    ];
    for (const [raw, expected] of shapes) {
      const out = plainError(raw);
      expect(out.line, raw).toMatch(expected);
      expect(out.details, raw).toBe(raw);
    }
  });
  it("leaves a sentence a person or bot wrote untouched", () => {
    for (const raw of ["Name is required.", "The file Failed to fetch.txt was not found", "Could not save: 404 pages are not allowed here", "That bot is busy."]) {
      expect(plainError(raw)).toEqual({ line: raw, details: null });
    }
    expect(plainError("")).toEqual({ line: "", details: null });
  });
  it("never uses a dash or banned wording", () => {
    for (const raw of ["Failed to fetch", "401", "429", "500", "404", "{}", "ERR_X"]) {
      expect(plainError(raw).line).not.toMatch(/—|\s[–−]\s|\b(safe|safely|safety|unsafe)\b/i);
    }
  });
});

describe("plain error wording", () => {
  it("does not promise an automatic retry", () => {
    expect(plainError("429").line).not.toMatch(/Murage can try again|will retry|retrying/i);
  });
});
