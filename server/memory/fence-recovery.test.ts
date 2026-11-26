// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { fenceVerdict } from "./deny-read.ts";
import { promptPart, noneRef } from "./prompt-parts.ts";
import { initializeTurnSourceHolds, threadRangeNow } from "../turn-source-holds.ts";
import { WritetimeFixture, CONTENT } from "./testing/writetime-fixture.ts";

describe("fence omission cause", () => {
  it("each omission term maps to its own cause, and the owner-facing cause stays checking, changed or unknown", async () => {
    const { fenceOmissionCause } = await import("./fence-recovery.ts");
    expect(fenceOmissionCause({ pendingWithheld: 2 })).toEqual({ cause: "checking" });
    expect(fenceOmissionCause({ ownerPendingKept: true })).toEqual({ cause: "checking" });
    expect(fenceOmissionCause({ workingChecking: 3 })).toEqual({ cause: "checking" });
    expect(fenceOmissionCause({ renderedWithheld: 1 })).toEqual({ cause: "changed" });
    expect(fenceOmissionCause({ workingChanged: 1 })).toEqual({ cause: "changed" });
    expect(fenceOmissionCause({ workingUnknown: 28 })).toEqual({ cause: "unknown", logCause: "lookup-failed" });
    expect(fenceOmissionCause({ bundle: 26 })).toEqual({ cause: "unknown", logCause: "bundle-fence" });
    expect(fenceOmissionCause({ pack: 1 })).toEqual({ cause: "unknown", logCause: "pack-unreleased" });
    expect(fenceOmissionCause({})).toEqual({ cause: "unknown" });
    expect(fenceOmissionCause({ bundle: 5, workingChecking: 1 })).toEqual({ cause: "checking" });
  });
});

describe("bounded fence recovery", () => {
  it("R7 rebuilds selectively then message-only, at most twice", async () => {
    const { FENCE_REBUILDS, nextFenceTier } = await import("./fence-recovery.ts");
    expect(FENCE_REBUILDS).toBe(2);
    expect([0, 1, 2, 3, -1, NaN, .5].map(nextFenceTier)).toEqual([{ tier: 1 }, { tier: 2 }, undefined, undefined, undefined, undefined, undefined]);
  });
  it("R8 real message-only prompt uses raw human input and never queries the database", async () => {
    const { messageOnlyPrompt } = await import("./fence-recovery.ts");
    const prompt = messageOnlyPrompt(undefined, { rawHumanText: "raw human words", frame: "static frame", now: "time" });
    const db = new Proxy({}, { get() { throw new Error("database must not be touched"); } }) as DatabaseSync;
    expect(fenceVerdict(db, prompt, { audience: null })).toEqual({ state: "shown" });
    expect(prompt.text).toContain("raw human words");
    expect(prompt.parts.every(p => p.lineageOf.length && p.lineageOf.every(r => r.kind === "none"))).toBe(true);
    expect(messageOnlyPrompt(undefined, { rawHumanText: undefined, frame: "static frame", now: "time" }).text).not.toContain("undefined");
  });
  // MAIN RULING 2026-11-17T07:33Z R5: at message-only recovery a server-authored project delivery (review ask, lead wake) is carried as
  // Murage's own instruction exactly as the server rendered it: never relabelled as the owner's words, never with a nonce of its own.
  it("R5 a server-authored delivery survives message-only recovery as Murage's instruction, verbatim, with no invented nonce", async () => {
    const { messageOnlyPrompt } = await import("./fence-recovery.ts");
    const serverFrame = promptPart('Review card 1: Pricing section\n<murage-review nonce="0123456789abcdef0123456789abcdef">', [noneRef("murage")]);
    const prompt = messageOnlyPrompt(undefined, { rawHumanText: undefined, frame: "static frame", now: "time", serverFrame });
    const db = new Proxy({}, { get() { throw new Error("database must not be touched"); } }) as DatabaseSync;
    expect(fenceVerdict(db, prompt, { audience: null })).toEqual({ state: "shown" });
    expect(prompt.parts.map(part => part.text)).toEqual(["static frame", serverFrame.text, "time"]);
    expect(prompt.parts[1].lineageOf).toEqual([{ kind: "none", reason: "murage" }]);
    expect(prompt.parts.some(part => part.lineageOf.some(ref => ref.kind === "none" && ref.reason === "owner-turn"))).toBe(false);
    expect(prompt.text.match(/nonce="[a-f0-9]{32}"/g)).toEqual(['nonce="0123456789abcdef0123456789abcdef"']);
    // no server frame: the static instruction, and no nonce at all
    const plain = messageOnlyPrompt(undefined, { rawHumanText: undefined, frame: "static frame", now: "time", serverFrame: null });
    expect(plain.parts[1].text).toBe("Stored context is unavailable for this turn. Ask for a fresh message before continuing.");
    expect(plain.text).not.toMatch(/nonce=/);
    // fresh human words still win and stay the owner's
    expect(messageOnlyPrompt(undefined, { rawHumanText: "raw human words", frame: "static frame", now: "time", serverFrame }).parts[1]).toEqual({ text: "raw human words", lineageOf: [{ kind: "none", reason: "owner-turn" }] });
  });
  // comms "queues eight helpers" (1.0.20): a delegated turn's recovery carries its task as the hand-off's own line, fenced like any line.
  it("H2 a delegated turn's message-only recovery carries the hand-off line as that line, and is refused once the line is withheld", async () => {
    const { messageOnlyPrompt, handoffFramePart, assertHandoffRecoveryCarriesTask } = await import("./fence-recovery.ts");
    const fixture = new WritetimeFixture().reply("desk", "handoff", 2);
    try {
      const frame = handoffFramePart("desk", { id: "handoff", text: "batch work 3" });
      expect(frame).toEqual({ text: "batch work 3", lineageOf: [{ kind: "line", threadId: "desk", messageId: "handoff" }] });
      const prompt = messageOnlyPrompt(undefined, { rawHumanText: undefined, frame: "static", now: "time", serverFrame: frame });
      expect(prompt.parts.map(part => part.text)).toEqual(["static", "batch work 3", "time"]);
      expect(prompt.text).not.toContain("Stored context is unavailable");
      expect(fenceVerdict(fixture.db, prompt, CONTENT)).toEqual({ state: "shown" });
      fixture.denyLine("desk", 2);
      expect(fenceVerdict(fixture.db, prompt, CONTENT).state).toBe("withheld");
      // no line, no text: no frame, and a delegated recovery without one is refused (never the static instruction read as done)
      for (const line of [null, undefined, { id: "handoff" }, { id: "handoff", text: null }, { id: "handoff", text: "  \n" }]) expect(handoffFramePart("desk", line)).toBeNull();
      expect(() => assertHandoffRecoveryCarriesTask(true, null)).toThrow("MEMORY_CONTEXT_REVOKED");
      expect(() => assertHandoffRecoveryCarriesTask(true, undefined)).toThrow("MEMORY_CONTEXT_REVOKED");
      expect(() => assertHandoffRecoveryCarriesTask(true, promptPart(" ", [noneRef("murage")]))).toThrow("MEMORY_CONTEXT_REVOKED");
      expect(() => assertHandoffRecoveryCarriesTask(true, frame)).not.toThrow();
      expect(() => assertHandoffRecoveryCarriesTask(false, null)).not.toThrow();
    } finally { fixture.close(); }
  });
  it("H1 recovery retains the result and card refs through a withdrawal after rendering, and refuses unknown lineage", async () => {
    const { messageOnlyPrompt } = await import("./fence-recovery.ts");
    const fixture = new WritetimeFixture().reply("desk", "result", 2);
    try {
      const serverFrame = promptPart("Review card 1: current result", [
        noneRef("murage"), { kind: "line", threadId: "desk", messageId: "result" },
        { kind: "memory", ref: { kind: "card", id: "card" } },
      ]);
      const prompt = messageOnlyPrompt(undefined, { rawHumanText: undefined, frame: "static", now: "time", serverFrame });
      expect(prompt.parts[1]).toEqual(serverFrame);
      expect(fenceVerdict(fixture.db, prompt, CONTENT)).toEqual({ state: "shown" });
      fixture.denyLine("desk", 2);
      expect(fenceVerdict(fixture.db, prompt, CONTENT).state).toBe("withheld");
      const cardOnly = messageOnlyPrompt(undefined, { rawHumanText: undefined, frame: "static", now: "time",
        serverFrame: promptPart("Review card", [{ kind: "memory", ref: { kind: "card", id: "card" } }]) });
      expect(fenceVerdict(fixture.db, cardOnly, CONTENT)).toEqual({ state: "shown" });
      fixture.denyMemory("card", "card");
      expect(fenceVerdict(fixture.db, cardOnly, CONTENT).state).toBe("withheld");
      const unknown = messageOnlyPrompt(undefined, { rawHumanText: undefined, frame: "static", now: "time", serverFrame: promptPart("unaccounted", []) });
      expect(fenceVerdict(fixture.db, unknown, CONTENT)).toEqual({ state: "checking", reason: "no-lineage" });
    } finally { fixture.close(); }
  });
  it("H1 a recovered range keeps its hold stamp and refuses withdrawal or an unknown endpoint", async () => {
    const { recoveryFramePart } = await import("./fence-recovery.ts");
    const fixture = new WritetimeFixture().reply("desk", "result", 2);
    try {
      initializeTurnSourceHolds(fixture.db);
      const range = threadRangeNow("desk", fixture.db)!;
      expect(range).toBeTruthy();
      const shown = { value: "Review current result", origins: [{ threadId: "desk", messageIds: ["result"] }], ranges: [range] };
      const part = recoveryFramePart(fixture.db, shown, [{ kind: "memory", ref: { kind: "card", id: "card" } }]);
      expect(part?.text).toBe(shown.value);
      expect(part?.lineageOf).toContainEqual({ kind: "line", threadId: "desk", messageId: "result" });
      expect(part?.lineageOf).toContainEqual({ kind: "prefix", threadId: "desk" });
      fixture.db.prepare("UPDATE messages SET json=json_set(json,'$.withheldFromBots','forgotten') WHERE thread_id='desk' AND id='result'").run();
      expect(recoveryFramePart(fixture.db, shown, [])).toBeNull();
      expect(recoveryFramePart(fixture.db, { ...shown, ranges: [{ ...range, upTo: "gone" }] }, [])).toBeNull();
    } finally { fixture.close(); }
  });
  it("R9 notes are calm, truthful for changed/checking/unknown causes and absent without an omission", async () => {
    const { recoveryNote } = await import("./fence-recovery.ts");
    expect(recoveryNote(0, { omitted: 0, cause: "checking" })).toBeNull();
    for (const cause of ["checking", "changed", "unknown"] as const) {
      expect(recoveryNote(1, { omitted: 1, cause })?.line).toBeTruthy();
      expect(recoveryNote(2, { omitted: 1, cause })?.kind).toBe("message-only");
      expect(recoveryNote(0, { omitted: 1, cause })?.line).toBeTruthy();
      if (cause !== "checking") expect(recoveryNote(1, { omitted: 1, cause })?.line).not.toMatch(/finishes|few/);
    }
  });
});
