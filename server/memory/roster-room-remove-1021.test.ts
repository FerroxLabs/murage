// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 ROSTER RESIDUAL 2 (O5). Owners: revoke2-1021 owns rosterDelta's room-member rule (server/memory/policy.ts); the recall view, the
// authority epoch and the receipt revoke helpers are unchanged. Removing a bot from a team room was an audience change ("rule=4-room-fact",
// "memory receipts revoked scope=global"): every running turn on the machine was refused, Sean's turn with Director in Director's own chat too.
// A non-dm room whose ONLY change is its members, in a roster with no partition and no live recall reader on the threads it narrows, now ends
// only: the room's threads and desked tasks, and every thread where the leaver reads (its own threads, its other rooms). A remaining member
// keeps its receipts. Anything else stays global (fail closed). Design: revoke2-1021/DESIGN.md r2 (Astra design read + fix-check).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { InternalCapabilities, liveTurnGenerationOn } from "../internal-capabilities.ts";
import { Store } from "../store.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { memoryAccess, revalidateMemoryAccess, type MemoryRoster } from "./policy.ts";
import { memoryState, setMemoryMode } from "./repository.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { recordMemorySettlement } from "./settlement.ts";
import { continuationMemoryRevoked, filterDirectReplay, resetSessionHolds } from "./disclosures.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { markSessionKnown } from "./testing/legacy-file-model.ts";
import { authorityParts, softChangedSince } from "./authority-epoch.ts";
import { prepareRecallContextSync, maintainRecallViewSlice, liveRecallReaderOn, retainRecallView } from "./recall-view.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { resetDataRootsForTest } from "../data-roots.ts";
import * as searchCompatibility from "../testing/search-index-compat.ts";

// 1.0.23 RR7 (ASTRA :5102): roomNarrowed's live-turn guard has three disjuncts (policy.ts: a live turn generation, a live recall reader,
// an open-turn row). In one process a turn's recall reader always rides on its live generation (the lease is released with it), so RR5
// is decided by either. RR5b isolates the reader disjunct: a reader registered on the room thread through the reader registry's own
// retainRecallView, with no generation on any narrowed thread (state no production turn reaches: the guard is a fail-closed backstop).
// The generation disjunct on the server's own dispatch is roster-room-dispatch-rr7-1023.test.ts; the open-turn row alone is RR6.
const openTurnRows = (threads: string[]) => Number(database().prepare("SELECT count(*) AS n FROM memory_open_turns WHERE thread_id IN (SELECT value FROM json_each(?))").get(JSON.stringify(threads))!.n);

beforeEach(async () => { closeDatabase(); await searchCompatibility.stopSearchIndex?.(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetDataRootsForTest(); thawRootSetWritesForTest(true); resetSessionHolds(); });
afterEach(() => { thawRootSetWritesForTest(false); vi.restoreAllMocks(); });

const receiptState = (bundleId: string) => database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundleId)?.state;
const bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
function drain() {
  for (let n = 0; n < 100; n++) {
    const work = claimMemoryJob("library-roster");
    if (!work) return;
    const result = captureWork(work);
    publishMemoryWork(work, "library-roster", result);
    if (result.status === "complete") refreshMemoryCheckpoint(work.id);
  }
}


function world(engine = "claude") {
  const store = new Store(() => ({ instanceId: engine, model: "fixture" }));
  const lead = store.createBot({ name: "Director", section: "Agency" });
  setMemoryMode("active");
  const roster = (): MemoryRoster => store;
  const registry = new InternalCapabilities();
  const access = (botId: string, threadId: string) => {
    const generation = registry.begin(botId, threadId);
    const token = registry.mint({ botId, threadId, generation, depth: 0, kind: "memory", skillAuthoring: false });
    prepareRecallContextSync(botId, threadId, store);
    const a = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, roster);
    while (!maintainRecallViewSlice(a.view)) { /* fixture preparation */ }
    return a;
  };
  const receipts = new Map<string, string[]>();
  /** One owner turn in a bot's own thread that is shown memory and answers (a delivered receipt). */
  const turn = async (botId: string, n: number) => {
    const bot = store.bot(botId)!, threadId = bot.threadId, session = `S-${botId}`;
    const allowance = LineageAllowance.turn();
    store.appendMessage(threadId, { role: "user", kind: "text", text: `Plan pitch ${n} please.`, origin: "desktop" } as never);
    recordMemorySettlement(threadId, `t${botId}${n}`, "working");
    drain();
    const a = access(botId, threadId);
    filterDirectReplay(allowance, threadId, store.activePath(threadId) as never, a, new Set());
    const bundle = await buildMemoryBundle(`pitch ${n}`, a, bridge, { allowance });
    const receipt = new MemoryDispatchReceipt(bundle, a, engine);
    receipt.sessionStarted(session); receipt.accepted();
    receipts.set(botId, [...receipts.get(botId) ?? [], bundle.bundleId]);
    markSessionKnown(threadId, engine, session, botId);
    const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: "", turnId: `t${botId}${n}`, from: { botId, name: bot.name, color: "x" } } as never);
    receipt.output(reply.id);
    store.patchMessage(threadId, reply.id, { text: `Pitch ${n} is ready.` } as never);
    store.markTerminalAssistantMessage(threadId, `t${botId}${n}`, "completed");
    drain();
    // the turn is over: the server settles it and ends its generation, so neither its open-turn row nor its recall reader is live
    recordMemorySettlement(threadId, `t${botId}${n}`, "completed");
    registry.revokeGeneration(threadId, registry.activeGeneration(threadId)!);
    return a;
  };
  /** What the Library's "add this assistant" does: the create route's createBot (with its opening lines), then the PATCH that files it. */
  const libraryCreates = (name: string, patch: Parameters<Store["patchBot"]>[1]) => {
    const created = store.createBot({ name, title: "Specialist", description: "From the Library." });
    store.patchBot(created.id, patch);
    return created;
  };
  return { store, lead, turn, receipts, access, libraryCreates };
}
function lines() {
  const out: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { const line = args.map(String).join(" "); if (/memory receipts revoked|roster audience change/.test(line)) out.push(line); });
  return out;
}

const disclose = (bundleId: string, threadId: string) => database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'engine','S','[]','[]','[]',(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',1000)").run(bundleId, threadId);

/** Director and Alita share the Pitch room; both have delivered receipts in their own chats and the room has one in its thread. */
async function pitch() {
  const w = world(), log = lines();
  await w.turn(w.lead.id, 1);
  const alita = w.libraryCreates("Alita", { section: "Agency" });
  const room = w.store.createGroup("Pitch room", [w.lead.id, alita.id], false, "Agency");
  await w.turn(alita.id, 1);
  await w.turn(w.lead.id, 2);
  disclose("room-receipt", room.threadId);
  return { w, log, alita, room };
}

it("RR1: removing a bot from a team room while an owner turn runs in a remaining member's chat keeps that turn's receipts; nothing is global", async () => {
  const { w, log, alita, room } = await pitch();
  // Sean's turn with Director is running (a live recall reader in Director's own chat) while Alita is removed from the room
  const live = w.access(w.lead.id, w.lead.threadId);
  const before = memoryState().policyRevision, hard = authorityParts()?.hard;
  w.store.patchGroup(room.id, { memberIds: [w.lead.id] });
  expect(w.store.group(room.id)?.memberIds).toEqual([w.lead.id]);
  expect(log.filter(line => line.includes("scope=global"))).toEqual([]);
  expect(log.filter(line => line.includes("roster audience change"))).toEqual([]);
  expect(memoryState().policyRevision).toBe(before);
  expect(authorityParts()?.hard).toBe(hard);
  for (const id of w.receipts.get(w.lead.id)!) expect(receiptState(id)).toBe("delivered");
  // the running turn's handle still holds: re-checked on the live roster, it keeps what it had (its thread and scopes did not move)
  expect(() => revalidateMemoryAccess(live)).not.toThrow();
  // the running owner turn goes on: its next turn is shown memory and answers
  await w.turn(w.lead.id, 3);
  for (const id of w.receipts.get(w.lead.id)!) expect(receiptState(id)).toBe("delivered");
  void alita;
});

it("RR2+RR3: the room's receipts and every receipt where the leaver reads end, with their epochs; the remaining member's do not", async () => {
  const { w, alita, room } = await pitch();
  const seq = authorityParts()!.seq;
  w.store.patchGroup(room.id, { memberIds: [w.lead.id] });
  expect(receiptState("room-receipt")).toBe("revoked");
  for (const id of w.receipts.get(alita.id)!) expect(receiptState(id)).toBe("revoked");
  for (const id of w.receipts.get(w.lead.id)!) expect(receiptState(id)).toBe("delivered");
  const moved = softChangedSince(seq);
  expect(moved && [...moved]).toEqual(expect.arrayContaining([`thread:${room.threadId}`, `thread:${alita.threadId}`]));
  expect(moved!.has(`thread:${w.lead.threadId}`)).toBe(false);
  // the leaver's stale session is refused at its next continuation
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.turn(), alita.threadId, "claude", `S-${alita.id}`, w.access(alita.id, alita.threadId), why)).toBe(true);
});

it("RR2b: a leaver's OTHER room ends too (it read Pitch there); a room it never shared stays", async () => {
  const { w, alita, room } = await pitch();
  const side = w.store.createGroup("Side room", [alita.id, w.lead.id], false, "Agency");
  const quiet = w.libraryCreates("Wren", { section: "Agency" });
  const elsewhere = w.store.createGroup("Elsewhere", [w.lead.id, quiet.id], false, "Agency");
  disclose("side-receipt", side.threadId); disclose("elsewhere-receipt", elsewhere.threadId);
  w.store.patchGroup(room.id, { memberIds: [w.lead.id] });
  expect(receiptState("side-receipt")).toBe("revoked");
  expect(receiptState("elsewhere-receipt")).toBe("delivered");
});

it("RR4a (fail closed): a room's section change (another room fact) stays an audience change", async () => {
  const { w, log, room } = await pitch();
  w.store.patchGroup(room.id, { section: "Research" } as never);
  expect(log.some(line => line.includes("rule=4-room-fact"))).toBe(true);
  for (const id of w.receipts.get(w.lead.id)!) expect(receiptState(id)).toBe("revoked");
});

it("RR4b (fail closed): a member change in a roster with a partitioned bot stays an audience change", async () => {
  const p = await pitch();
  const sharer = p.w.libraryCreates("Wren", { section: "Agency" });
  p.w.store.patchBot(sharer.id, { partitionedAt: Date.now() } as never);
  await p.w.turn(p.w.lead.id, 9);
  p.w.store.patchGroup(p.room.id, { memberIds: [p.w.lead.id] });
  expect(p.log.some(line => /rule=4-room-/.test(line))).toBe(true);
  expect(p.log.some(line => line.includes("scope=global"))).toBe(true);
  for (const id of p.w.receipts.get(p.w.lead.id)!) expect(receiptState(id)).toBe("revoked");
});

it("RR5 (fail closed, Astra #2): with a live recall reader on a thread the removal narrows, it stays an audience change", async () => {
  const { w, log, alita, room } = await pitch();
  const live = w.access(alita.id, alita.threadId);
  const before = memoryState().policyRevision;
  w.store.patchGroup(room.id, { memberIds: [w.lead.id] });
  expect(log.some(line => /rule=4-room-/.test(line))).toBe(true);
  expect(memoryState().policyRevision).toBeGreaterThan(before);
  for (const id of w.receipts.get(w.lead.id)!) expect(receiptState(id)).toBe("revoked");
  void live;
});

it("RR5b (fail closed, the recall reader disjunct alone): a live recall reader on the room thread, with no turn generation there, keeps the removal global", async () => {
  const { w, log, alita, room } = await pitch();
  // a recall view issued to Director's own turn (its generation is on Director's thread, which this removal does not narrow) ...
  const lead = w.access(w.lead.id, w.lead.threadId);
  // ... read on the room thread by a reader with no turn generation there
  const release = retainRecallView(lead.view, { botId: w.lead.id, threadId: room.threadId, humanPrincipal: lead.humanPrincipal, notOwnerAudience: false }, () => true);
  const narrowed = [room.threadId, alita.threadId];
  expect(liveTurnGenerationOn(narrowed), "no live generation on a narrowed thread").toBe(false);
  const readerLive = liveRecallReaderOn(new Set([room.threadId]));
  expect(openTurnRows(narrowed), "no open-turn row on a narrowed thread").toBe(0);
  w.store.patchGroup(room.id, { memberIds: [w.lead.id] });
  expect(log.filter(line => line.includes("rule=4-room-live")), "the reader alone keeps the room change an audience change").toHaveLength(1);
  expect(readerLive, "the room thread's recall reader was live").toBe(true);
  expect(liveTurnGenerationOn(narrowed), "still no live generation on a narrowed thread").toBe(false);
  expect(openTurnRows(narrowed), "still no open-turn row on a narrowed thread").toBe(0);
  release();
});

it("RR6 (fail closed, Astra code read #2): a turn still working in the room thread, its recall lease ended, keeps the removal global", async () => {
  const { w, log, alita, room } = await pitch();
  recordMemorySettlement(room.threadId, "t-room-1", "working");
  // the open-turn row is the only liveness input (as for a turn of another process sharing the file)
  const narrowed = [room.threadId, alita.threadId];
  expect(liveTurnGenerationOn(narrowed), "no live generation on a narrowed thread").toBe(false);
  expect(liveRecallReaderOn(new Set(narrowed)), "no recall reader on a narrowed thread").toBe(false);
  const rowLive = openTurnRows([room.threadId]);
  const before = memoryState().policyRevision;
  w.store.patchGroup(room.id, { memberIds: [w.lead.id] });
  expect(log.filter(line => line.includes("rule=4-room-live")), "the open-turn row alone keeps the room change an audience change").toHaveLength(1);
  expect(rowLive, "the room turn's open-turn row").toBe(1);
  expect(liveTurnGenerationOn(narrowed), "still no live generation on a narrowed thread").toBe(false);
  expect(liveRecallReaderOn(new Set(narrowed)), "still no recall reader on a narrowed thread").toBe(false);
  expect(memoryState().policyRevision).toBeGreaterThan(before);
  for (const id of w.receipts.get(w.lead.id)!) expect(receiptState(id)).toBe("revoked");
});

it("RR7 (fail closed, Astra code read #2): a room turn that has begun but not reached turn.started (live generation, no lease, no open-turn row) keeps the removal global", async () => {
  const { w, log, room } = await pitch();
  // the server's registry (a different instance from the fixture's) dispatches Director in the room: recall-held, still preparing
  const server = new InternalCapabilities();
  server.begin(w.lead.id, room.threadId);
  const before = memoryState().policyRevision;
  w.store.patchGroup(room.id, { memberIds: [w.lead.id] });
  expect(log.some(line => /rule=4-room-/.test(line))).toBe(true);
  expect(memoryState().policyRevision).toBeGreaterThan(before);
  for (const id of w.receipts.get(w.lead.id)!) expect(receiptState(id)).toBe("revoked");
  server.revokeAll();
  expect(liveTurnGenerationOn([room.threadId])).toBe(false);
});
