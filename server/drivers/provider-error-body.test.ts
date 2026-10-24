// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { httpErrorDetail, providerErrorFields } from "./provider-error-body.ts";

describe("provider error sentence (item 166)", () => {
  it("shows the provider's sentence with its snake_case code, not cut-off JSON", () => {
    const body = JSON.stringify({ error: { message: "Your team has used all available credits.", code: "credit_exhausted", type: "billing" } });
    expect(httpErrorDetail(body)).toBe("Your team has used all available credits. (credit_exhausted)");
    expect(httpErrorDetail(JSON.stringify({ error: { message: "bad", code: 429 } }))).toBe("bad");
    expect(httpErrorDetail(JSON.stringify({ error: "plain text error" }))).toBe("plain text error");
    expect(providerErrorFields(JSON.stringify({ detail: "d" }))).toEqual({ message: "d" });
  });

  it("falls back to the raw body when it is not an envelope, and caps it", () => {
    expect(httpErrorDetail("upstream connect error")).toBe("upstream connect error");
    expect(httpErrorDetail("x".repeat(900), 500)).toHaveLength(500);
    expect(httpErrorDetail(JSON.stringify({ message: "m".repeat(900) })).length).toBeLessThanOrEqual(500);
    expect(httpErrorDetail("[1,2]")).toBe("[1,2]");
  });
});
