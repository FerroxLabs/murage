// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { agyAuthFromResult, agyAuthFromStderr } from "./antigravity-auth.ts";

describe("agy sign-in refusal classifier", () => {
  it("tier 1 reads only provider-owned codes and a 401, also in details, never the message", () => {
    for (const error of [{ code: "UNAUTHENTICATED" }, { status: "unauthenticated" }, { type: "invalid_grant" }, { code: 401 }, { http_status: 401 }, { details: [{ reason: "invalid_grant" }] }, { details: [{ status: 401 }] }])
      expect(agyAuthFromResult({ error }), JSON.stringify(error)).toBe(true);
    for (const payload of [{ message: "unauthenticated" }, { error: "unauthenticated" }, { error: { message: "invalid_grant" } }, { error: { code: "PERMISSION_DENIED" } }, { error: { code: 403 } }, { error: { code: "UNAVAILABLE", details: [{ status: 503 }] } }, null, {}])
      expect(agyAuthFromResult(payload), JSON.stringify(payload)).toBe(false);
  });
  it("tier 2 matches the anchored phrases and drops bare oauth, 401, 403 and unauthorized", () => {
    for (const text of ["Authentication required", "Error: not logged in", "please sign in", "Please login to continue", "token has been revoked", "token expired", "credentials have expired", "invalid credentials", "login required", "sign-in required", "invalid_grant"])
      expect(agyAuthFromStderr(text), text).toBe(true);
    for (const text of ["oauth callback ready", "HTTP 401", "tool returned 403", "Unauthorized", "an unauthenticatedx path", "simulated crash"])
      expect(agyAuthFromStderr(text), text).toBe(false);
  });
});
