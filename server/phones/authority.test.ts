// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { PhoneAuthorities, phoneMintEligible, type MintFacts } from "./authority.ts";

const ok: MintFacts = { origin: "desktop", unprovenSend: false, ownerActs: true, answer: false, automationSource: undefined, delegationRun: undefined,
  cardContinuation: undefined, askerWake: undefined, commsDepth: undefined, unattended: false, directThread: true, offered: true, carry: undefined };

describe("phoneMintEligible (H1, X2, F4)", () => {
  it("mints for a fresh owner turn", () => { expect(phoneMintEligible(ok)).toBe(true); expect(phoneMintEligible({ ...ok, origin: "companion" })).toBe(true); });
  it.each<[string, Partial<MintFacts>]>([
    ["unproven origin", { origin: "unproven" }], ["missing origin", { origin: undefined }], ["unproven send", { unprovenSend: true }],
    ["not ownerActs", { ownerActs: false }], ["card answer or widget", { answer: true }], ["webhook or routine", { automationSource: "webhook" }],
    ["delegation", { delegationRun: {} }], ["card continuation", { cardContinuation: {} }], ["asker wake", { askerWake: {} }],
    ["comms depth", { commsDepth: 1 }], ["unattended", { unattended: true }], ["room or channel thread", { directThread: false }],
    ["not offered", { offered: false }], ["failover of a turn with no authority", { carry: { held: false } }],
  ])("refuses: %s", (_name, over) => { expect(phoneMintEligible({ ...ok, ...over })).toBe(false); });
  it("failover of an authorised turn mints", () => { expect(phoneMintEligible({ ...ok, carry: { held: true } })).toBe(true); });

  it("fails closed on malformed facts", () => {
    const bad: Array<Partial<Record<keyof MintFacts, unknown>>> = [
      { origin: "Desktop" }, { origin: "" }, { origin: null }, { ownerActs: undefined }, { ownerActs: 1 }, { offered: undefined }, { offered: "yes" },
      { directThread: undefined }, { unprovenSend: undefined }, { answer: undefined }, { unattended: undefined }, { unattended: 0 },
      { carry: null }, { carry: {} }, { carry: { held: "true" } }, { commsDepth: "0" }, { commsDepth: NaN },
      { automationSource: 0 }, { automationSource: false }, { cardContinuation: false }, { askerWake: "" },
    ];
    for (const over of bad) expect(phoneMintEligible({ ...ok, ...over } as MintFacts), JSON.stringify(over)).toBe(false);
    expect(phoneMintEligible(undefined as unknown as MintFacts)).toBe(false);
    expect(phoneMintEligible(null as unknown as MintFacts)).toBe(false);
  });
  it("treats null automation facts as absent (store defaults)", () => { expect(phoneMintEligible({ ...ok, delegationRun: null, askerWake: null })).toBe(true); });
  it("treats commsDepth 0 as absent", () => { expect(phoneMintEligible({ ...ok, commsDepth: 0 })).toBe(true); });
});

describe("PhoneAuthorities", () => {
  const base = { threadId: "t1", turnId: "u1", generation: "g1", origin: "desktop" as const, botId: "b1" };
  it("live returns null for any generation but the minted one", () => {
    const a = new PhoneAuthorities();
    const m = a.mint(base);
    expect(m.issuedAt).toBeTypeOf("number");
    expect(a.live("g1")).toEqual(m);
    expect(a.live("g2")).toBeNull();
    expect(a.live("")).toBeNull();
    expect(a.live(undefined as unknown as string)).toBeNull();
    expect(a.live("__proto__")).toBeNull();
    expect(a.live("constructor")).toBeNull();
  });
  it("heldByThread finds the live authority", () => {
    const a = new PhoneAuthorities();
    const m = a.mint(base);
    expect(a.heldByThread("t1")).toEqual(m);
    expect(a.heldByThread("t2")).toBeNull();
  });
  it("a caller cannot widen a minted authority by mutating what it was given", () => {
    const a = new PhoneAuthorities();
    const m = a.mint(base);
    expect(() => { (m as { botId: string }).botId = "evil"; }).toThrow();
    const got = a.live("g1");
    expect(got?.botId).toBe("b1");
    expect(() => { (got as { threadId: string }).threadId = "evil"; }).toThrow();
    expect(a.live("g1")?.threadId).toBe("t1");
  });
  it("revokeGeneration ends it", () => {
    const a = new PhoneAuthorities();
    a.mint(base);
    a.revokeGeneration("g1");
    expect(a.live("g1")).toBeNull();
    expect(a.heldByThread("t1")).toBeNull();
  });
  it("revokeThread ends that thread's authority only", () => {
    const a = new PhoneAuthorities();
    a.mint(base); a.mint({ ...base, threadId: "t2", generation: "g2" });
    a.revokeThread("t1");
    expect(a.live("g1")).toBeNull();
    expect(a.live("g2")).not.toBeNull();
  });
  it("revokeBot ends all of that bot's", () => {
    const a = new PhoneAuthorities();
    a.mint(base); a.mint({ ...base, threadId: "t2", generation: "g2" }); a.mint({ ...base, threadId: "t3", generation: "g3", botId: "b2" });
    a.revokeBot("b1");
    expect(a.live("g1")).toBeNull();
    expect(a.live("g2")).toBeNull();
    expect(a.live("g3")).not.toBeNull();
  });
  it("a newer mint on a thread ends the older generation", () => {
    const a = new PhoneAuthorities();
    a.mint(base);
    a.mint({ ...base, generation: "g9" });
    expect(a.live("g1")).toBeNull();
    expect(a.heldByThread("t1")?.generation).toBe("g9");
  });
  it("refuses a reused generation and malformed input", () => {
    const a = new PhoneAuthorities();
    a.mint(base);
    expect(() => a.mint({ ...base, threadId: "t2" })).toThrow();
    expect(a.live("g1")?.threadId).toBe("t1");
    expect(() => a.mint({ ...base, generation: "" })).toThrow();
    expect(() => a.mint({ ...base, threadId: "" })).toThrow();
    expect(() => a.mint({ ...base, botId: "", generation: "g5" })).toThrow();
    expect(() => a.mint({ ...base, origin: "unproven" as unknown as "desktop", generation: "g6" })).toThrow();
    expect(a.live("g5")).toBeNull();
    expect(a.live("g6")).toBeNull();
  });
  it("revokes are idempotent and tolerate unknown ids", () => {
    const a = new PhoneAuthorities();
    a.revokeGeneration("nope"); a.revokeThread("nope"); a.revokeBot("nope");
    expect(a.live("nope")).toBeNull();
  });
});
