// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { PooledSessionAudiences, sessionAudienceChanged, sessionContractChanged } from "./session-audience.ts";

describe("session audience (SPEC-P 13.1)", () => {
  it("a cursor is resumed only under the audience it was made for", () => {
    expect(sessionAudienceChanged("owner", true, "owner")).toBe(false);
    expect(sessionAudienceChanged("owner", true, "unproven,workspace-owner:local:1")).toBe(true);
    expect(sessionAudienceChanged(undefined, true, "owner")).toBe(false);
    expect(sessionAudienceChanged(undefined, true, "person:x:1")).toBe(true);
    expect(sessionAudienceChanged("owner", false, "person:x:1")).toBe(false);
  });
  it("a pooled room process resets when the audience moves, until a turn for the new audience is accepted", () => {
    const pooled = new PooledSessionAudiences();
    expect(pooled.changed("t", "claude", "owner")).toBe(false);
    pooled.accepted("t", "claude", "owner");
    expect(pooled.changed("t", "claude", "owner")).toBe(false);
    expect(pooled.changed("t", "claude", "unproven,x")).toBe(true);
    // that attempt failed before dispatch: the next still owes the reset
    expect(pooled.changed("t", "claude", "unproven,x")).toBe(true);
    pooled.accepted("t", "claude", "unproven,x");
    expect(pooled.changed("t", "claude", "unproven,x")).toBe(false);
    expect(pooled.changed("t", "pi", "owner")).toBe(false);
    pooled.forget("t");
    expect(pooled.changed("t", "claude", "owner")).toBe(false);
  });
});

describe("session contract (claude.ts CLAUDE_ISOLATION_CONTRACT)", () => {
  it("never resumes a cursor made before or without the engine's current contract", () => {
    // a cursor from before the isolation contract existed
    expect(sessionContractChanged(undefined, true, 1)).toBe(true);
    // one made under an older contract
    expect(sessionContractChanged(1, true, 2)).toBe(true);
    // one made under this contract resumes
    expect(sessionContractChanged(1, true, 1)).toBe(false);
  });

  it("leaves engines without a contract, and threads without a cursor, alone", () => {
    expect(sessionContractChanged(undefined, true, undefined)).toBe(false);
    expect(sessionContractChanged(undefined, false, 1)).toBe(false);
  });
});
