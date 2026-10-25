// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SL-E (lanes/release104/designs/SL-E.md): a linked person DMs the paired Chief, the Chief hands the work to a teammate, and the teammate's
// result now reaches the person. The gate releases it only when both conversations are positively that one person's own unshared ones, read
// live (E2); every message-level rule still judges it for a not-owner reader (step 3), and a withheld or checking answer takes ONE neutral path
// for a person's conversation (E3 with section 8): no withheld, checking or no-answer words reach the person, the receipt, its replay or the
// channel mirror. Owner conversations keep today's words (their own suites).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundaryStore } from "./boundary-ports.ts";
import { doorEgress } from "./bot-read.ts";
import { RowSink } from "./bot-egress.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { _loadPending, findDelegationReceipt, FINALIZER_WRITES, onDelegationReceipt, onOwedHandoffReply, settleReceipted } from "./delegations.ts";
import { isOwnUnsharedThread, isSamePersonUnsharedPair } from "./execution-audience.ts";
import { ownUnsharedWorkCheck } from "./handoff-binding.ts";
import { runFinalizeDelegationWatch, type FinalizeDelegationWatchPorts } from "./handoff-boundary.ts";
import { handoffReplyId, owedReplyOf, replayOwedReply } from "./handoff-reply.ts";
import { humanTask, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding, revokeHumanConnection, threadHumanPrincipal, type HumanPrincipal } from "./human-principals.ts";
import { closeMessageDb } from "./message-db.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { closeTurnLineage, openTurnLineage } from "./memory/lineage-write.ts";
import { personReadableScopes } from "./memory/policy.ts";
import { configureStatusRoster, outboundWords, type Outbound } from "./murage-status.ts";
import { configureResultEgress, releaseStoredResult, writetimeLinesShown, type ResultEgressDeps } from "./result-egress.ts";
import { WorkerText } from "./released-text.ts";
import { plain } from "./testing/released.ts";
import { Store, type BotRecord } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

/** Every line a person must never see in place of a teammate's words (lee-phantom-scenario.test.ts flow f). */
const BAD = /Reply withheld|deleted or changed|Reply left out|still being checked|no answer|Checking this reply/i;
const WORDS = "The venue holds 120 people and is free on the 14th (HELPER_WORDS)";
const NEUTRAL = "Delegation to @Helper completed without a text reply";

beforeEach(() => {
  closeMessageDb(); closeDatabase();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  _loadPending();
});
afterEach(() => {
  onOwedHandoffReply(undefined); onDelegationReceipt(undefined);
  configureResultEgress(undefined); configureStatusRoster(undefined);
  closeMessageDb(); closeDatabase(); vi.restoreAllMocks();
});

let contacts = 0;
/** A verified channel account, linked by the owner as a person (or as the owner). */
function linked(as: "person" | "owner" = "person", platform: "slack" | "whatsapp" = "slack", userId = `contact-${++contacts}`) {
  const connectionId = `conn-${contacts}`;
  const bindingId = observeVerifiedHuman({ platform, connectionId, authorityId: "authority", userId });
  if (!userId.endsWith("@g.us")) linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as });
  return { bindingId, connectionId, principal: resolveHumanBinding(bindingId) };
}

function world() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const chief = store.createBot({ name: "Chief", section: "Front" }, { seedMessages: false });
  const helper = store.createBot({ name: "Helper", section: "Front" }, { seedMessages: false });
  const memoryMade = new Set<string>();
  const control = { checking: false };
  const deps: ResultEgressDeps = {
    message: (thread, id) => store.messageById(thread, id), authorize: () => ({ ok: true }),
    copyOriginWithheld: () => false, capturedMessageWithheld: () => false, messageSourceForgotten: () => false,
    messageMadeWithMemory: (_thread, id) => memoryMade.has(id),
    partitionAllowed: () => control.checking ? "checking" : true,
    // as index.ts wires it: the owner case and the same-person case, both read live
    ownUnsharedWork: ownUnsharedWorkCheck({ bot: id => store.bot(id) ?? undefined, isOwnUnsharedThread, isSamePersonUnsharedPair, principal: threadHumanPrincipal, message: (thread, id) => store.messageById(thread, id) }),
    personScopes: principal => personReadableScopes(database(), principal),
    linesShown: writetimeLinesShown(database), doorShown: doorEgress(database),
  };
  configureResultEgress(deps);
  configureStatusRoster(name => store.bots.some(bot => bot.name === name));
  /** The person's DM thread on the Chief and the helper's thread for the same person (audienceTask -> humanTask), as the dispatch makes them. */
  const threads = (principal: HumanPrincipal) => ({ dm: humanTask(store, chief.id, principal)!.threadId, work: humanTask(store, helper.id, principal)!.threadId });
  /** The helper's turn for a hand-off the person's DM started: its prompt records the hand-off, its reply follows it, written inside the turn. */
  const answer = (work: string, handoffFrom: string, text = WORDS) => {
    const prompt = store.appendMessage(work, { role: "user", kind: "text", text: "find a venue", handoffFrom });
    const turn = openTurnLineage(database(), { threadId: work, turnId: `turn-${Math.random().toString(36).slice(2)}` });
    const reply = store.appendMessage(work, { role: "bot", kind: "text", text, parentId: prompt.id });
    closeTurnLineage(turn);
    return reply;
  };
  /** The gate as the watch path asks it for a person's hand-off (E1 sets peerTurnNotOwner). */
  const gate = (dm: string, work: string, messageId: string, text = WORDS, ref: { peerTurnNotOwner?: true } = { peerTurnNotOwner: true }, fromBotId = chief.id) =>
    plain(releaseStoredResult({ origin: { threadId: work, messageIds: [messageId] }, ...ref }, helper.id, dm, { fromBotId }, true, new WorkerText(text), deps));
  return { store, chief, helper, deps, memoryMade, control, threads, answer, gate };
}

describe("E2: the result gate releases a person's own hand-off result, and nothing else", () => {
  it("clean: the helper's words for the person are released as text", () => {
    const w = world(); const { principal } = linked(); const t = w.threads(principal);
    const reply = w.answer(t.work, t.dm);
    expect(w.gate(t.dm, t.work, reply.id)).toMatchObject({ kind: "text", text: WORDS });
  });
  it("memory-made: step 3 still withholds it for the person", () => {
    const w = world(); const { principal } = linked(); const t = w.threads(principal);
    const reply = w.answer(t.work, t.dm); w.memoryMade.add(reply.id);
    expect(w.gate(t.dm, t.work, reply.id).kind).toBe("withheld");
  });
  it("binding moved (relinked mid hand-off): origin_unconfirmed", () => {
    const w = world(); const { principal, bindingId } = linked(); const t = w.threads(principal);
    const reply = w.answer(t.work, t.dm);
    linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: principal.revision, as: "person" });
    expect(w.gate(t.dm, t.work, reply.id)).toMatchObject({ kind: "refused", code: "origin_unconfirmed" });
  });
  it("inactive binding (person removed during the turn): refused", () => {
    const w = world(); const { principal, connectionId } = linked(); const t = w.threads(principal);
    const reply = w.answer(t.work, t.dm);
    revokeHumanConnection("slack", connectionId);
    expect(w.gate(t.dm, t.work, reply.id)).toMatchObject({ kind: "refused", code: "origin_unconfirmed" });
  });
  it("group principal (a WhatsApp group): refused", () => {
    const w = world(); const { principal } = linked("person", "whatsapp", "120363000000000000@g.us"); const t = w.threads(principal);
    const reply = w.answer(t.work, t.dm);
    expect(w.gate(t.dm, t.work, reply.id)).toMatchObject({ kind: "refused", code: "origin_unconfirmed" });
  });
  it("a reply whose prompt's handoffFrom is not the source conversation: refused", () => {
    const w = world(); const { principal } = linked(); const t = w.threads(principal);
    const reply = w.answer(t.work, "some-other-thread");
    expect(w.gate(t.dm, t.work, reply.id)).toMatchObject({ kind: "refused", code: "origin_unconfirmed" });
  });
  it("two different people on the two threads: refused", () => {
    const w = world(); const p = linked().principal, q = linked().principal;
    const dm = w.threads(p).dm, work = w.threads(q).work;
    const reply = w.answer(work, dm);
    expect(w.gate(dm, work, reply.id)).toMatchObject({ kind: "refused", code: "origin_unconfirmed" });
  });
  it("shared work, a non-home partition, or a thread that is not a task of its bot: refused", () => {
    const shared = world(); { const { principal } = linked(); const t = shared.threads(principal); const reply = shared.answer(t.work, t.dm);
      shared.helper.tasks!.find(task => task.threadId === t.work)!.sharedWork = { teamId: "team-x" } as never;
      expect(shared.gate(t.dm, t.work, reply.id)).toMatchObject({ kind: "refused", code: "origin_unconfirmed" }); }
    closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const partitioned = world(); { const { principal } = linked(); const t = partitioned.threads(principal); const reply = partitioned.answer(t.work, t.dm);
      partitioned.helper.partitionedAt = 1;
      partitioned.helper.tasks!.find(task => task.threadId === t.work)!.channelProjectDesk = { groupId: "no-such-project" } as never;
      expect(partitioned.gate(t.dm, t.work, reply.id)).toMatchObject({ kind: "refused", code: "origin_unconfirmed" }); }
    closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const elsewhere = world(); { const { principal } = linked(); const t = elsewhere.threads(principal); const reply = elsewhere.answer(t.work, t.dm);
      // the source thread named as another bot's: not a task of that bot
      expect(elsewhere.gate(t.dm, t.work, reply.id, WORDS, { peerTurnNotOwner: true }, elsewhere.helper.id)).toMatchObject({ kind: "refused", code: "origin_unconfirmed" }); }
  });
  it("a channel account linked as the owner keeps today's refusal exactly", () => {
    const w = world(); const { principal } = linked("owner"); const t = w.threads(principal);
    const reply = w.answer(t.work, t.dm);
    expect(w.gate(t.dm, t.work, reply.id)).toMatchObject({ kind: "refused", code: "origin_unconfirmed" });
  });
  it("without peerTurnNotOwner (any other path for a not-owner reader) the person's result stays refused", () => {
    const w = world(); const { principal } = linked(); const t = w.threads(principal);
    const reply = w.answer(t.work, t.dm);
    expect(w.gate(t.dm, t.work, reply.id, WORDS, {})).toMatchObject({ kind: "refused", code: "origin_unconfirmed" });
  });
});

describe("E1 + E3: the watch settle of a person's hand-off", () => {
  function settle() {
    const w = world(); const { principal } = linked(); const t = w.threads(principal);
    const channel = w.store.createGroup("pair", [w.chief.id, w.helper.id], true);
    const delegationWatch: FinalizeDelegationWatchPorts["delegationWatch"] = new Map();
    const finalizing = new Set<string>();
    onOwedHandoffReply(receipt => finalizing.has(receipt.id) ? FINALIZER_WRITES : replayOwedReply(w.store, receipt));
    const comms = { reply: vi.fn(() => undefined), activity: vi.fn(), clearFinishing: vi.fn(), murageLine: vi.fn() };
    const chiefBot = (): BotRecord => w.store.bot(w.chief.id)!;
    const ports: FinalizeDelegationWatchPorts = {
      comms: comms as never, delegationSource: threadId => threadId === t.dm ? { kind: "bot", bot: chiefBot() } : null, delegationWatch,
      finalizingDelegations: finalizing, handoffRequestId: () => undefined, markTaskContextExternallyUpdated: vi.fn(), completeRoomAsk: vi.fn(() => undefined),
      afterRoomCompletion: () => undefined,
      owedReply: input => owedReplyOf({ ok: input.ok, reply: input.reply ? outboundWords(input.reply) : "", targetName: input.targetName, failureName: outboundWords(input.failureName), stopped: input.stopped }),
      store: boundaryStore(w.store), rows: new RowSink(w.store),
    };
    const finish = (taskId: string, reply: { id: string; text?: string }) => {
      delegationWatch.set(t.work, { toBotId: w.helper.id, toBotName: w.helper.name, taskId, sourceThreadId: t.dm, notOwnerAudience: true, channelId: channel.id });
      return runFinalizeDelegationWatch(ports, t.work, true, { text: new WorkerText(reply.text ?? ""), present: true }, undefined, false, { threadId: t.work, messageIds: [reply.id] });
    };
    const mirrored = () => [...(comms.reply.mock.calls as unknown[][]).map(call => outboundWords(call[1] as Outbound)),
      ...(comms.activity.mock.calls as unknown[][]).map(call => outboundWords(call[2] as Outbound))];
    const row = (taskId: string) => w.store.messageById(t.dm, handoffReplyId(taskId));
    const rowText = (taskId: string) => { const m = row(taskId); return String(m?.text || m?.tool?.name || ""); };
    const everything = (taskId: string) => [JSON.stringify(w.store.messagesFor(t.dm)), JSON.stringify(findDelegationReceipt(taskId) ?? {}), ...mirrored()].join("\n");
    return { ...w, t, ports, comms, finish, mirrored, row, rowText, everything };
  }

  it("a not-owner watch settle passes peerTurnNotOwner: the person's clean result lands as words in the DM, the receipt's owed line and the mirror", () => {
    const s = settle();
    const reply = s.answer(s.t.work, s.t.dm);
    expect(s.finish("task-clean", reply)).toBe(true);
    expect(s.rowText("task-clean")).toContain("HELPER_WORDS");
    expect(findDelegationReceipt("task-clean")).toMatchObject({ status: "done" });
    expect(s.mirrored().join("\n")).toContain("HELPER_WORDS");
    expect(s.everything("task-clean")).not.toMatch(BAD);
  });

  it("withheld (memory-made): the neutral line in the source row, the receipt's owed line and the mirror, no BAD words anywhere", () => {
    const s = settle();
    const reply = s.answer(s.t.work, s.t.dm); s.memoryMade.add(reply.id);
    expect(s.finish("task-withheld", reply)).toBe(true);
    expect(s.rowText("task-withheld")).toBe(NEUTRAL);
    expect(s.mirrored()).toEqual(["Delegated turn completed"]);
    expect(s.everything("task-withheld")).not.toMatch(BAD);
    expect(s.everything("task-withheld")).not.toContain("HELPER_WORDS");
  });

  it("checking (section 8, with a channel): the same neutral path, no checking or no-answer words in the row, receipt or mirror", () => {
    const s = settle();
    const reply = s.answer(s.t.work, s.t.dm); s.control.checking = true;
    expect(s.finish("task-checking", reply)).toBe(true);
    expect(s.rowText("task-checking")).toBe(NEUTRAL);
    expect(s.comms.reply).not.toHaveBeenCalled();
    expect(s.mirrored()).toEqual(["Delegated turn completed"]);
    expect(s.everything("task-checking")).not.toMatch(BAD);
    expect(s.everything("task-checking")).not.toContain("HELPER_WORDS");
  });

  it("gone (r3 section 12: the original was deleted): the neutral line in the row, the receipt's owed line and the mirror, never \"withheld\" words", () => {
    const s = settle();
    const reply = s.answer(s.t.work, s.t.dm);
    // the original is gone as the gate's walk reads it (deleted between the hand-off's binding proof and the walk); a person's original that is
    // already gone when the proof is read is refused at step 1 (origin_unconfirmed), as before
    const read = s.deps.message;
    s.deps.message = (thread, id) => id === reply.id ? undefined : read(thread, id);
    expect(s.finish("task-gone", reply)).toBe(true);
    expect(s.rowText("task-gone")).toBe(NEUTRAL);
    expect(s.mirrored()).toEqual(["Delegated turn completed"]);
    expect(s.everything("task-gone")).not.toMatch(BAD);
    expect(s.everything("task-gone")).not.toContain("HELPER_WORDS");
  });

  for (const kind of ["clean", "neutral"] as const) {
    it(`crash window (${kind}): a receipt saved with its owed line and no row commit is replayed once with exactly that payload, never re-gated`, () => {
      const s = settle();
      const reply = s.answer(s.t.work, s.t.dm);
      if (kind === "neutral") s.memoryMade.add(reply.id);
      const taskId = `task-crash-${kind}`;
      // the final commit fails at the row write: nothing commits, the receipt with its owed line is kept on disk
      const append = vi.spyOn(s.store, "appendMessage").mockImplementationOnce(() => { throw new Error("database is busy"); });
      expect(() => s.finish(taskId, reply)).toThrow("database is busy");
      append.mockRestore();
      expect(s.row(taskId)).toBeUndefined();
      const receipt = findDelegationReceipt(taskId)!;
      expect(receipt.reply).toEqual(kind === "clean" ? { text: WORDS } : { line: NEUTRAL, ok: true });
      // the gate would now answer differently (memory-made flips, a check stalls): the replay does not ask it again
      if (kind === "clean") s.memoryMade.add(reply.id); else { s.memoryMade.delete(reply.id); }
      s.control.checking = true;
      expect(settleReceipted(receipt)).toBe(true);
      expect(settleReceipted(findDelegationReceipt(taskId) ?? receipt)).toBe(true);
      const rows = s.store.messagesFor(s.t.dm).filter(m => m.id === handoffReplyId(taskId));
      expect(rows).toHaveLength(1);
      if (kind === "clean") expect(s.rowText(taskId)).toBe(`@Helper replied to the delegated task:\n\n${WORDS}`); else expect(s.rowText(taskId)).toBe(NEUTRAL);
      expect(JSON.stringify(s.store.messagesFor(s.t.dm))).not.toMatch(BAD);
    });
  }
});
