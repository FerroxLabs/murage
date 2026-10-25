// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { isGenericCredentialPatch, LEGACY_PENDING_REVOKE_KEY, PENDING_REVOKES_KEY, pendingRevokes, pendingRevokesPatch, serverCredentialProjection } from "./credential-projection.ts";

describe("pending-revoke list projection", () => {
  it("hides the list and the legacy field from the server", () => {
    const projected = serverCredentialProjection({ fluxApiKey: "k", [PENDING_REVOKES_KEY]: '["x"]', [LEGACY_PENDING_REVOKE_KEY]: "y" });
    expect(projected).toEqual({ fluxApiKey: "k" });
  });
  it("rejects a client write of either field", () => {
    expect(isGenericCredentialPatch({ [PENDING_REVOKES_KEY]: "[]" })).toBe(false);
    expect(isGenericCredentialPatch({ [LEGACY_PENDING_REVOKE_KEY]: "" })).toBe(false);
    expect(isGenericCredentialPatch({ fluxApiKey: "k" })).toBe(true);
  });
  it("reads the list, migrates the legacy value, dedupes, and survives garbage", () => {
    expect(pendingRevokes({ [PENDING_REVOKES_KEY]: '["a","b"]', [LEGACY_PENDING_REVOKE_KEY]: "c" })).toEqual(["a", "b", "c"]);
    expect(pendingRevokes({ [PENDING_REVOKES_KEY]: '["a"]', [LEGACY_PENDING_REVOKE_KEY]: "a" })).toEqual(["a"]);
    expect(pendingRevokes({ [PENDING_REVOKES_KEY]: "{not json", [LEGACY_PENDING_REVOKE_KEY]: "c" })).toEqual(["c"]);
    expect(pendingRevokes({})).toEqual([]);
    expect(pendingRevokesPatch([])).toEqual({ [PENDING_REVOKES_KEY]: "", [LEGACY_PENDING_REVOKE_KEY]: "" });
  });
});
