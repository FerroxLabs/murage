// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { HookProof, TurnRefusal, hookDidNotStartLine } from "./turn-refusal.ts";

describe("TurnRefusal (Rules 67, 68c)", () => {
  it("refuses one way and keeps the first cause", () => {
    const refusal = new TurnRefusal();
    expect(refusal.refused).toBe(false);
    expect(refusal.refuse("first")).toBe(true);
    expect(refusal.refuse("second")).toBe(false);
    expect(refusal.refused).toBe(true);
    expect(refusal.cause).toBe("first");
  });

  it("turns every allow into a deny carrying the cause once refused, in the shape of the answer", () => {
    const refusal = new TurnRefusal();
    expect(refusal.allow({ decision: "allow" as const, updatedInput: { a: 1 } })).toEqual({ decision: "allow", updatedInput: { a: 1 } });
    expect(refusal.allow({ behavior: "allow" as const })).toEqual({ behavior: "allow" });
    expect(refusal.verdict("allow")).toBe("allow");
    refusal.refuse("stopped");
    expect(refusal.allow({ decision: "allow" as const, updatedInput: { a: 1 } })).toEqual({ decision: "deny", reason: "stopped" });
    expect(refusal.allow({ behavior: "allow" as const })).toEqual({ behavior: "deny", message: "stopped" });
    expect(refusal.allow({ decision: "accept" }, () => ({ decision: "decline" }))).toEqual({ decision: "decline" });
    expect(refusal.verdict("allow")).toBe("deny");
    expect(refusal.verdict("deny")).toBe("deny");
    expect(refusal.verdict("answer")).toBe("answer");
  });

  it("takes no proof after a refusal, so a late SessionStart never revives the turn", () => {
    const refusal = new TurnRefusal();
    refusal.refuse("no proof");
    expect(refusal.acceptProof()).toBe(false);
    expect(refusal.hookLive).toBe(false);
    const proven = new TurnRefusal();
    expect(proven.acceptProof()).toBe(true);
    expect(proven.hookLive).toBe(true);
  });

  it("records whether an item had started before the refusal, and the owner line follows it", () => {
    const quiet = new TurnRefusal();
    quiet.refuse((started) => hookDidNotStartLine("Codex", started));
    expect(quiet.startedFirst).toBe(false);
    expect(quiet.cause).toBe("Codex's pre-execution hook did not start, so this turn was stopped before it ran anything.");
    const begun = new TurnRefusal();
    begun.noteStarted();
    begun.refuse((started) => hookDidNotStartLine("Codex", started));
    expect(begun.startedFirst).toBe(true);
    expect(begun.cause).toBe("Codex's pre-execution hook did not start, so this turn was stopped as soon as it started.");
    // an item that starts after the refusal does not change what was recorded
    quiet.noteStarted();
    expect(quiet.startedFirst).toBe(false);
  });

  it("starts a turn proven only on a valid process proof under the same hook configuration, and a void proof stays void", () => {
    const proof = new HookProof("cfg-1");
    expect(new TurnRefusal({ proof, hookConfig: "cfg-1" }).hookLive).toBe(false);
    const first = new TurnRefusal({ proof, hookConfig: "cfg-1" });
    first.acceptProof();
    expect(proof.valid).toBe(true);
    expect(new TurnRefusal({ proof, hookConfig: "cfg-1" }).hookLive).toBe(true);
    expect(new TurnRefusal({ proof, hookConfig: "cfg-2" }).hookLive).toBe(false);
    proof.void();
    expect(proof.valid).toBe(false);
    expect(proof.voided).toBe(true);
    expect(new TurnRefusal({ proof, hookConfig: "cfg-1" }).hookLive).toBe(false);
    const again = new TurnRefusal({ proof, hookConfig: "cfg-1" });
    again.acceptProof();
    expect(proof.valid).toBe(false);
  });
});
