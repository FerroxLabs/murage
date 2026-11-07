// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HL-RO allow gate (1.0.17, designs/HL-RO-ALLOW-GATE-1104.md section 3): the fact table. One row per way a turn starts; only
// the owner's own fresh line in the bot's direct chat (and that same line re-dispatched) passes.
import { describe, expect, it } from "vitest";
import { HIGHLEVEL_CLOSED_LINE, HIGHLEVEL_OWNER_OPTS, highlevelOwnerTurn, type HighLevelOwnerFacts } from "./owner-turn.ts";

const TICKET = Symbol("highlevel owner ticket");
const ownerLine = (origin: "desktop" | "companion" = "desktop"): HighLevelOwnerFacts => ({
  ticket: TICKET, ownerTicket: TICKET, opts: { threadId: "t1", replyTo: undefined, sendId: "s1", origin, hlTicket: TICKET },
  ownerOrigin: true, directOwnerAudience: true, directThread: true, sharedWork: false, fullAccessOrigin: "owner",
  routineLevel: false, inheritedRoutine: false, conversationMode: false, unattended: false, routineLive: false,
});
/** A start that no runIt made: no ticket, its own opts. */
const other = (opts: Record<string, unknown>, facts: Partial<HighLevelOwnerFacts> = {}): HighLevelOwnerFacts => ({
  ...ownerLine(), ticket: undefined, opts: { threadId: "t1", ...opts }, ...facts,
});

describe("HL-RO: highlevelOwnerTurn is an allow proof", () => {
  it("positive: a fresh desktop or companion line at idle, and its memory redispatch or rebuild", () => {
    expect(highlevelOwnerTurn(ownerLine())).toBe(true);
    expect(highlevelOwnerTurn(ownerLine("companion"))).toBe(true);
    const line = ownerLine();
    expect(highlevelOwnerTurn({ ...line, opts: { ...line.opts, userMessage: { id: "m1" }, excludeMessageIds: ["m0"], memoryRedispatch: 1 } })).toBe(true);
    expect(highlevelOwnerTurn({ ...line, opts: { ...line.opts, rebuildOf: "gen_1", phoneTicket: Symbol("phone") } })).toBe(true);
  });

  const rows: [string, HighLevelOwnerFacts][] = [
    // R0: nobody typing in the direct chat
    ["schedule", other({ automationSource: "schedule", routineRunId: "r1", seatWaitRunId: "r1" }, { routineLevel: true })],
    ["manual run", other({ automationSource: "manual", routineRunId: "r1" }, { routineLevel: true })],
    ["webhook", other({ automationSource: "webhook", unattended: true }, { unattended: true, fullAccessOrigin: "unattended" })],
    ["channel", other({ automationSource: "channel", origin: "unproven" }, { ownerOrigin: false, directOwnerAudience: false })],
    ["unattended", other({ unattended: true }, { unattended: true })],
    // R1: a routine's children
    ["routine child ask (3323)", other({ routineAuthority: { routineId: "r" }, commsDepth: 1, chainRootThreadId: "t0", handoffSourceThreadId: "t0", coordination: {} }, { inheritedRoutine: true })],
    ["hand-off (14998)", other({ delegationRun: {}, handoffOf: { threadId: "t0", messageId: "m" }, routineAuthority: { routineId: "r" } }, { inheritedRoutine: true })],
    ["queued shared hand-off (16897)", other({ sharedWorkRun: {}, chainNotOwner: true }, { sharedWork: true })],
    ["shared start (16979)", other({ sharedWorkRun: {} }, { sharedWork: true })],
    ["wake (asker-wake.ts:508)", other({ askerWake: true, askerWakeId: "w1", routineWake: true, routineAuthority: { routineId: "r" } }, { inheritedRoutine: true })],
    ["project routine (project-routines.ts:24)", other({ projectCardRun: {}, automationSource: "schedule" }, { sharedWork: true, directThread: false })],
    // R2: card continuations, with a live routine and without
    ["card continuation, live routine (2113)", other({ cardContinuation: true, routineRunId: "r1" }, { routineLive: true, inheritedRoutine: true })],
    ["card continuation, no routine (20102)", other({ cardContinuation: true })],
    ["connector resume (20315)", other({ cardContinuation: true, continuationCardId: "c1", continuationPermissionMode: "ask" })],
    ["routine-card resume (6165)", other({ cardContinuation: true, routineRunId: "r1", continuationCardId: "c1" }, { routineLive: true })],
    ["held continuation (JSON copy drops the symbol)", other({ ...JSON.parse(JSON.stringify(ownerLine().opts)), heldContinuationId: "h1", cardContinuation: true })],
    // queued, answered, edited, unproven
    ["queued drain with queuedOwnerProof", other({ queuedOwnerProof: true, queuedDrain: true, excludeMessageIds: ["m1"] })],
    ["ask-card answer (7052: runIt with answer, no ticket)", other({ origin: "desktop", sendId: "s2" })],
    ["edit-and-rerun (29111)", other({ editedMessageId: "m1", origin: "desktop", sendId: "s3" })],
    ["unproven send", other({ origin: "unproven", unattended: true }, { ownerOrigin: false, unattended: true })],
    // forged and unknown
    ["forged string ticket", { ...ownerLine(), ticket: "highlevel owner ticket", opts: { ...ownerLine().opts, hlTicket: "highlevel owner ticket" } }],
    ["a look-alike symbol", { ...ownerLine(), ticket: Symbol("highlevel owner ticket") }],
    ["an unknown extra opts key", { ...ownerLine(), opts: { ...ownerLine().opts, someNewStartKind: true } }],
    ["a symbol-keyed extra opt", { ...ownerLine(), opts: { ...ownerLine().opts, [Symbol("x")]: 1 } as Record<string, unknown> }],
    ["the ticket plus a live routine on the thread", { ...ownerLine(), routineLive: true }],
    ["the ticket in a routine's own conversation", { ...ownerLine(), conversationMode: true }],
    ["the ticket on a room thread", { ...ownerLine(), directThread: false }],
    ["the ticket with a contact audience", { ...ownerLine(), directOwnerAudience: false }],
    ["the ticket at a non-owner full-access origin", { ...ownerLine(), fullAccessOrigin: "routine" }],
    ["no opts at all", { ...ownerLine(), opts: undefined }],
  ];
  it.each(rows)("false: %s", (_name, facts) => {
    expect(highlevelOwnerTurn(facts)).toBe(false);
  });

  it("an allowed key set to undefined is fine; any other key set to undefined is too, but not to false or 0", () => {
    const line = ownerLine();
    expect(highlevelOwnerTurn({ ...line, opts: { ...line.opts, cardContinuation: undefined, automationSource: undefined } })).toBe(true);
    expect(highlevelOwnerTurn({ ...line, opts: { ...line.opts, cardContinuation: false } })).toBe(false);
    expect(highlevelOwnerTurn({ ...line, opts: { ...line.opts, commsDepth: 0 } })).toBe(false);
  });

  it("the ALLOWED list is the design's, frozen", () => {
    expect([...HIGHLEVEL_OWNER_OPTS].sort()).toEqual(["excludeMessageIds", "hlTicket", "memoryRedispatch", "origin", "phoneTicket", "rebuildOf", "replyTo", "sendId", "threadId", "userMessage"]);
    expect(Object.isFrozen(HIGHLEVEL_OWNER_OPTS)).toBe(true);
  });

  it("the bot-facing line is the approved wording, plain words, no em dash", () => {
    expect(HIGHLEVEL_CLOSED_LINE).toBe("HighLevel isn't open on this turn. It opens only for a message the owner sends you directly in this chat. If they ask for something from HighLevel, ask them to send that request again here.");
    expect(HIGHLEVEL_CLOSED_LINE).not.toMatch(/—/u);
  });
});
