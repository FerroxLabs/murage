// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lane 106 memory-changed-reset (designs/MEMORY-CHANGED-RESET-106.md): three memory updates withdraw nothing a session was shown, so they
// no longer end its receipts or commit a write-time revoke, and the warm engine session stays warm: pinning a memory, keeping a learned
// memory, remembering a brand-new one. The next frame carries the change on the same native session. Everything that can withdraw words
// (unpin, undo, correct, archive, forget) still resets. The world is continuation-churn.test.ts's real pipeline (Store messages,
// settlement, capture jobs, checkpoints, frame receipts on one native session) on a live write-time file, no legacy root-set thaw.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { Store } from "../store.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { ensureScope, memoryAccess, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { recordMemorySettlement } from "./settlement.ts";
import { continuationMemoryRevoked, readerWithheldMessage, resetSessionHolds } from "./disclosures.ts";
import { approveMemory, correctMemory, ownerMemoryTicket, pinMemory, rememberMemory } from "./authority.ts";
import { archiveMemoryRecord, restoreArchivedMemoryRecord } from "./retention.ts";
import { reviewEdit } from "./review.ts";
import { revokeRecordDisclosures } from "./revocation.ts";
import { insertMemoryRecord } from "./record-write.ts";
import { inheritEdges } from "./revoke-commit.ts";
import { capturedMessageWithheld, copyOriginUnavailable } from "./replay-lineage.ts";
import { changeLearningEvent } from "./learning-history.ts";
import { recordLearningEvent } from "./learning-ledger.ts";
import { forgetMemory } from "./forget.ts";
import { lineageLive } from "./deny-read.ts";
import { REVOCATION_JOB_SUBJECT } from "./memory-revocation.ts";
import { decorateMemoryInstance } from "../harness/memory-adapter.ts";
import type { MemoryBundle } from "../../shared/memory.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { markSessionKnown } from "./testing/legacy-file-model.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { access as xAccess, append as xAppend, bot as xBot, hits, person as xPerson, QUERY as X_QUERY, world as xWorld } from "./testing/xthread-world.ts";

const bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetSessionHolds(); });
afterEach(() => { vi.restoreAllMocks(); });

function drain() {
  for (let n = 0; n < 100; n++) {
    const work = claimMemoryJob("mcr106");
    if (!work) return;
    const result = captureWork(work);
    publishMemoryWork(work, "mcr106", result);
    if (result.status === "complete") refreshMemoryCheckpoint(work.id);
  }
}

function world() {
  const store = new Store(() => ({ instanceId: "claude", model: "fixture" }));
  const bot = store.createBot(); store.patchBot(bot.id, { name: "Sable" });
  setMemoryMode("active");
  const threadId = bot.threadId;
  const roster = (): MemoryRoster => ({ bots: store.bots, groups: store.groups } as unknown as MemoryRoster);
  const registry = new InternalCapabilities();
  const access = () => {
    const generation = registry.begin(bot.id, threadId);
    const token = registry.mint({ botId: bot.id, threadId, generation, depth: 0, kind: "memory", skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, roster);
  };
  let n = 0;
  /** One owner turn on `session`: the owner's message, the frame receipt, the reply, the worker's pass. */
  const turn = async (session = "S1"): Promise<MemoryBundle> => {
    n++;
    store.appendMessage(threadId, { role: "user", kind: "text", text: `Please note fact ${n}: the blue door code is ${1000 + n}.`, origin: "desktop" } as never);
    recordMemorySettlement(threadId, `t${n}`, "working");
    drain();
    const a = access();
    const bundle = await buildMemoryBundle(`blue door code ${n}`, a, bridge, { allowance: LineageAllowance.tool() });
    const receipt = new MemoryDispatchReceipt(bundle, a, "claude");
    receipt.sessionStarted(session); receipt.accepted();
    markSessionKnown(threadId, "claude", session, bot.id);
    const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: "", turnId: `t${n}`, from: { botId: bot.id, name: "Sable", color: "x" } } as never);
    receipt.output(reply.id);
    store.patchMessage(threadId, reply.id, { text: `Noted fact ${n}.` } as never);
    store.markTerminalAssistantMessage(threadId, `t${n}`, "completed");
    drain();
    return bundle;
  };
  const check = (session = "S1") => { const why: { reason?: string } = {}; const reset = continuationMemoryRevoked(LineageAllowance.tool(), threadId, "claude", session, access(), why); return { reset, why: why.reason }; };
  return { store, bot, threadId, roster, access, turn, check };
}

/** Everything a revocation writes, machine-wide: receipt states, write-time revoke roots, receipt-scan jobs, pending rows, deny marks. */
function revocationFootprint() {
  const db = database();
  const n = (sql: string, ...args: unknown[]) => Number(db.prepare(sql).get(...(args as never[]))?.n ?? 0);
  return {
    revokedReceipts: n("SELECT count(*) AS n FROM memory_disclosures WHERE state='revoked'"),
    revokeJobs: n("SELECT count(*) AS n FROM memory_revoke_jobs"),
    scanJobs: n("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=?", REVOCATION_JOB_SUBJECT),
    pending: n("SELECT count(*) AS n FROM memory_deny_pending") + n("SELECT count(*) AS n FROM memory_deny_pending_scope"),
    denySessions: n("SELECT count(*) AS n FROM memory_deny_session"),
    denyMemory: n("SELECT count(*) AS n FROM memory_deny_memory"),
  };
}

/** Two turns on S1 whose frames cite a captured fact; the third turn's check passes (the baseline every action starts from). */
async function warm() {
  const w = world();
  await w.turn(); await w.turn();
  const shown = (await w.turn()).recordVersions.filter(r => !r.id.startsWith("checkpoint:"));
  expect(shown.length).toBeGreaterThan(0);
  expect(lineageLive(database())).toBe(true);
  expect(w.check()).toEqual({ reset: false, why: undefined });
  return { w, record: shown[0]!, other: shown[1] ?? shown[0]! };
}

it("pin a memory the session was shown: no receipt ends, no revoke, the session stays warm (base: reset)", async () => {
  const { w, record } = await warm();
  const before = revocationFootprint();
  pinMemory(ownerMemoryTicket(), record.id, record.version, true);
  expect(revocationFootprint()).toEqual(before);
  expect(w.check()).toEqual({ reset: false, why: undefined });
});

it("keep a learned memory (an event naming a prior too): no receipt ends, no revoke, warm (base: reset and two roots)", async () => {
  const { w, record, other } = await warm();
  const db = database();
  const scope = String(db.prepare("SELECT scope_id FROM memory_records WHERE id=? AND version=?").get(record.id, record.version)!.scope_id);
  recordLearningEvent(db, { kind: "superseded", scopeId: scope, recordId: record.id, recordVersion: record.version, priorId: other.id, priorVersion: other.version });
  const eventId = String(db.prepare("SELECT id FROM memory_learning_events WHERE record_id=? ORDER BY created_at DESC LIMIT 1").get(record.id)!.id);
  const before = revocationFootprint();
  expect(changeLearningEvent(db, eventId, "keep")).toMatchObject({ kept: true });
  expect(revocationFootprint()).toEqual(before);
  expect(w.check()).toEqual({ reset: false, why: undefined });
});

it("remember a brand-new memory: no revoke root, no pending window, warm (base: a root and a pending window)", async () => {
  const { w } = await warm();
  const before = revocationFootprint();
  const outcome = rememberMemory(ownerMemoryTicket(), { actionId: "remember-106", text: "The owner's sister is called Maya." });
  expect(outcome).toMatchObject({ duplicate: false, fresh: true });
  expect(revocationFootprint()).toEqual(before);
  expect(w.check()).toEqual({ reset: false, why: undefined });
});

it("the reset rate: 9 owner turns on one session with pin, learning keep and remember between them", async () => {
  const { w, record, other } = await warm();
  const db = database();
  const scope = String(db.prepare("SELECT scope_id FROM memory_records WHERE id=? AND version=?").get(record.id, record.version)!.scope_id);
  const actions: Array<() => void> = [
    () => pinMemory(ownerMemoryTicket(), other.id, other.version, true),
    () => { recordLearningEvent(db, { kind: "activated", scopeId: scope, recordId: record.id, recordVersion: record.version }); changeLearningEvent(db, String(db.prepare("SELECT id FROM memory_learning_events WHERE record_id=? ORDER BY created_at DESC LIMIT 1").get(record.id)!.id), "keep"); },
    () => { rememberMemory(ownerMemoryTicket(), { actionId: `remember-106-a${remembered++}`, text: `The owner flies on Fridays, trip ${remembered}.` }); },
    () => { rememberMemory(ownerMemoryTicket(), { actionId: `remember-106-b${remembered++}`, text: `The owner prefers short replies, note ${remembered}.` }); },
  ];
  let remembered = 0; // every remember is a fresh insert (a new action id and new words), never the ledger's replay
  let resets = 0, session = "S1", sessions = 1;
  for (let turnNo = 0; turnNo < 9; turnNo++) {
    actions[turnNo % actions.length]!();
    const { reset } = w.check(session);
    if (reset) { resets++; session = `S${++sessions}`; }
    await w.turn(session);
  }
  // base 76a8b3b36 (measured): 7 resets in 9 turns, 8 sessions (the pin and the keep end receipts; a fresh remember's root reads `checking`); now none
  console.log(`[mcr106] resets=${resets} turns=9 sessions=${sessions}`);
  expect(resets).toBe(0);
});

it("the change reaches the warm engine: the after-pin frame differs and the adapter re-sends it on the same native session", async () => {
  const { w, record } = await warm();
  const a = w.access();
  const query = "blue door code";
  const beforePin = await buildMemoryBundle(query, a, bridge, { allowance: LineageAllowance.tool() });
  pinMemory(ownerMemoryTicket(), record.id, record.version, true);
  const afterPin = await buildMemoryBundle(query, w.access(), bridge, { allowance: LineageAllowance.tool() });
  expect(afterPin.text).toContain("pinned by the owner");
  expect(beforePin.text).not.toContain("pinned by the owner");
  // the delivery contract (harness/memory-adapter.ts) over a minimal engine: one native session, two turns with the same resume cursor
  const listeners: Array<(event: RuntimeEvent) => void> = [];
  const sent: SendTurnInput[] = [];
  let session: string | null = null;
  const adapter = {
    capabilities: {}, onEvent: (listener: (event: RuntimeEvent) => void) => { listeners.push(listener); return () => {}; },
    hasSession: () => session !== null, sendTurn: async (turn: SendTurnInput) => { sent.push(turn); return { turnId: `turn-${sent.length}` }; }, stopAll: async () => {},
  };
  const live = decorateMemoryInstance({ instanceId: "claude", adapter, dispose: async () => {} } as unknown as ProviderInstance);
  const emit = (event: Partial<RuntimeEvent>) => { for (const listener of listeners) listener({ eventId: "e", provider: "claude", threadId: w.threadId, createdAt: new Date().toISOString(), ...event } as RuntimeEvent); };
  await live.adapter.sendTurn({ threadId: w.threadId, text: "first", memoryContext: beforePin });
  session = "native-1"; emit({ type: "session.started", sessionId: "native-1" });
  await live.adapter.sendTurn({ threadId: w.threadId, text: "second", memoryContext: afterPin, resumeCursor: "native-1" });
  expect(sent[1]!.text).toContain("pinned by the owner");
  expect(sent[1]!.text.endsWith("second")).toBe(true);
  expect(sent[1]!.resumeCursor).toBe("native-1");
});

it("the updates that can withdraw words still reset: unpin, learning undo, correct, archive, forget", async () => {
  type Case = (w: Awaited<ReturnType<typeof warm>>) => void;
  const cases: Record<string, Case> = {
    unpin: ({ record }) => { pinMemory(ownerMemoryTicket(), record.id, record.version, true); pinMemory(ownerMemoryTicket(), record.id, record.version, false); },
    undo: ({ record }) => {
      const db = database();
      const scope = String(db.prepare("SELECT scope_id FROM memory_records WHERE id=? AND version=?").get(record.id, record.version)!.scope_id);
      recordLearningEvent(db, { kind: "activated", scopeId: scope, recordId: record.id, recordVersion: record.version });
      changeLearningEvent(db, String(db.prepare("SELECT id FROM memory_learning_events WHERE record_id=? ORDER BY created_at DESC LIMIT 1").get(record.id)!.id), "undo");
    },
    correct: ({ record }) => { correctMemory(ownerMemoryTicket(), record.id, record.version, "The blue door code changed."); },
    archive: ({ record }) => { archiveMemoryRecord(ownerMemoryTicket(), record.id, record.version); },
    forget: ({ record }) => { forgetMemory(ownerMemoryTicket(), { kind: "record", id: record.id }); },
  };
  for (const [name, act] of Object.entries(cases)) {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetSessionHolds();
    const state = await warm();
    act(state);
    expect({ name, reset: state.w.check().reset }).toEqual({ name, reset: true });
  }
});

/** Every "memory receipts revoked" line the code under test logs (roster-scoped-revokes.test.ts revokeLines). */
function revokeLines() {
  const lines: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { const line = args.map(String).join(" "); if (line.includes("memory receipts revoked")) lines.push(line); });
  return lines;
}
const receiptStates = (bundleIds: readonly string[]) => bundleIds.map(id => String(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(id)?.state));
/** A record row written the way the writers write one: the row, its evidence copied from `evidenceOf`, its derivations, and its write-time
 * edges (inheritEdges, as saveWaitingVersion and correctMemory do). */
function seedRecord(row: Parameters<typeof insertMemoryRecord>[1], evidenceOf: { id: string; version: number }, parents: ReadonlyArray<{ id: string; version: number }> = []) {
  transaction(db => {
    insertMemoryRecord(db, row);
    db.prepare("INSERT INTO memory_evidence SELECT ?,?,source_id,source_revision,start_byte,end_byte FROM memory_evidence WHERE record_id=? AND record_version=?").run(row.id, row.version, evidenceOf.id, evidenceOf.version);
    for (const parent of parents) db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,?)").run(parent.id, parent.version, row.id, row.version);
    inheritEdges(db, { id: row.id, version: row.version });
  });
}
/** A frame of `records` (through the recall bridge) accepted on `session` of the warm thread, the way world().turn makes one. */
async function frameOn(w: ReturnType<typeof world>, records: ReadonlyArray<{ id: string; version: number }>, session = "S1") {
  const a = w.access();
  const bundle = await buildMemoryBundle("blue door code", a, hits(records), { allowance: LineageAllowance.tool() });
  for (const record of records) expect(bundle.recordVersions.map(r => r.id)).toContain(record.id);
  const receipt = new MemoryDispatchReceipt(bundle, a, "claude");
  receipt.sessionStarted(session); receipt.accepted();
  return bundle.bundleId;
}

// F3 + F8. Head: keep adds nothing to the footprint and the check is the same. Base 76a8b3b36: the keep commits a write-time root for each of
// the three ids (record, prior, supersedes), so the footprint assertion fails there.
it("keep on a record with a prior AND a supersedes id, after an earlier revoke of the prior: keep adds nothing, the earlier revoke still decides (base: three roots)", async () => {
  const { w, record: prior } = await warm();
  const db = database();
  const shownRow = db.prepare("SELECT scope_id FROM memory_records WHERE id=? AND version=?").get(prior.id, prior.version)!;
  const scope = String(shownRow.scope_id);
  // three distinct ids: the learned record, its prior (shown to S1) and the record it superseded (warm() may give other===record). A
  // synthetic history: production supersede writers give the event's prior and the record's supersedes the same id; distinct ids exercise
  // every argument position of the keep call.
  seedRecord({ id: "mcr106-replaced", version: 1, scopeId: scope, kind: "fact", text: "The blue door code was 0000 last year.", assertion: "assistant-inference", state: "superseded", validFrom: Date.now(), createdAt: Date.now() }, prior);
  seedRecord({ id: "mcr106-learned", version: 1, scopeId: scope, kind: "fact", text: "The blue door code is the one the owner gave last.", assertion: "assistant-inference", state: "active", validFrom: Date.now(), supersedesId: "mcr106-replaced", createdAt: Date.now() }, prior, [{ id: "mcr106-replaced", version: 1 }]);
  const ids = new Set([prior.id, "mcr106-learned", "mcr106-replaced"]);
  expect(ids.size).toBe(3);
  recordLearningEvent(db, { kind: "superseded", scopeId: scope, recordId: "mcr106-learned", recordVersion: 1, priorId: prior.id, priorVersion: prior.version });
  const eventId = String(db.prepare("SELECT id FROM memory_learning_events WHERE record_id='mcr106-learned' AND kind='superseded'").get()!.id);
  // the earlier revoke of the prior: whatever it left (a pending window, a queued job, receipts it already ended) is what F8 keeps
  transaction(tx => revokeRecordDisclosures(tx, "correct", { recordIds: [prior.id] }));
  const before = revocationFootprint();
  expect(before.pending + before.revokeJobs + before.revokedReceipts).toBeGreaterThan(0);
  const decided = w.check();
  expect(decided.reset).toBe(true); // the earlier revoke decides S1's next check
  const lines = revokeLines();
  expect(changeLearningEvent(db, eventId, "keep")).toMatchObject({ kept: true });
  expect(lines.some(line => /cause=learning-keep count=0$/.test(line))).toBe(true);
  expect(revocationFootprint()).toEqual(before);
  expect(w.check()).toEqual(decided);
});

// F7 hard paths (regression guards: pass on base 76a8b3b36 and on the head, neither changes them).
it("hard path: an approved copy resting on a candidate that reviewEdit then supersedes still has its receipts revoked", async () => {
  const { w, record } = await warm();
  const db = database();
  const scope = String(db.prepare("SELECT scope_id FROM memory_records WHERE id=? AND version=?").get(record.id, record.version)!.scope_id);
  seedRecord({ id: "mcr106-candidate", version: 1, scopeId: scope, kind: "fact", text: "The blue door code opens the shed too.", assertion: "assistant-inference", state: "candidate", validFrom: Date.now(), createdAt: Date.now() }, record);
  // approval into another scope the session reads writes an active copy whose derivation parent is the waiting candidate (authority.ts approveMemory)
  const copy = approveMemory(ownerMemoryTicket(), "mcr106-candidate", 1, { scopeId: ensureScope("bot", w.bot.id) });
  expect(copy).not.toBe("mcr106-candidate");
  expect(db.prepare("SELECT state FROM memory_records WHERE id='mcr106-candidate' AND version=1").get()!.state).toBe("candidate");
  const shown = await frameOn(w, [{ id: copy, version: 1 }]);
  expect(receiptStates([shown])).toEqual(["delivered"]);
  expect(w.check().reset).toBe(false);
  const lines = revokeLines();
  const kept = reviewEdit(ownerMemoryTicket(), w.roster(), { actionId: "mcr106-edit-keep", id: "mcr106-candidate", version: 1, text: "The blue door code opens the shed and the gate.", keep: true });
  expect(kept.result).toMatchObject({ status: "kept", version: 2 });
  expect(db.prepare("SELECT state FROM memory_records WHERE id='mcr106-candidate' AND version=1").get()!.state).toBe("superseded");
  expect(lines.some(line => /cause=review-keep(-deferred)? count=[1-9]/.test(line))).toBe(true);
  expect(receiptStates([shown])).toEqual(["revoked"]);
  expect(w.check().reset).toBe(true);
});

it("hard path: restoring an archived correction still runs approveCorrection's revoke of the record it replaces", async () => {
  const { w, record } = await warm();
  const db = database();
  const target = db.prepare("SELECT scope_id,kind FROM memory_records WHERE id=? AND version=?").get(record.id, record.version)!;
  // an archived correction of the shown record (supersedes_id plus its one derivation, retention.ts readCorrectionTarget), its target still current
  seedRecord({ id: "mcr106-correction", version: 1, scopeId: String(target.scope_id), kind: String(target.kind), text: "The blue door code changed to 4242.", assertion: "owner-statement", state: "archived", validFrom: Date.now(), supersedesId: record.id, createdAt: Date.now() }, record, [record]);
  const cited = (db.prepare("SELECT bundle_id FROM memory_disclosures WHERE thread_id=? AND state='delivered' AND record_versions LIKE ?").all(w.threadId, `%${record.id}%`) as Array<{ bundle_id: string }>).map(row => row.bundle_id);
  expect(cited.length).toBeGreaterThan(0);
  expect(w.check().reset).toBe(false);
  const lines = revokeLines();
  restoreArchivedMemoryRecord(ownerMemoryTicket(), "mcr106-correction", 1);
  expect(db.prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(record.id, record.version)!.state).toBe("superseded");
  expect(lines.some(line => /cause=approve-correction(-deferred)? count=[1-9]/.test(line))).toBe(true);
  expect(receiptStates(cited).every(state => state === "revoked")).toBe(true);
  expect(w.check().reset).toBe(true);
});

// F10 + F11, readers. The xthread world (testing/xthread-world.ts): record X is the bot's reply in a channel person's conversation t1, read
// by the owner's direct chat, the owner room crew-chat, the person's other conversation t2 (an audience reader) and the bot's owner task
// thread finch-group. Each reader is shown X on its own native session; finch-group also holds a copy of the owner direct reply (the copy's
// origin). Head: nothing of any reader changes. Base 76a8b3b36: pin and keep flip every receipt citing X and remember commits a root with a
// pending window, so the "exactly as they were" assertion fails there for each action.
interface Reader { thread: string; session: string; access: () => MemoryAccess; bundleId: string }
async function readers() {
  const { person: who, x } = xWorld({ flipFirst: false });
  const defs: Array<[string, string, () => MemoryAccess]> = [
    ["ownerDirect", "finch-direct", () => xAccess("finch", "finch-direct")],
    ["ownerRoom", "crew-chat", () => xAccess("finch", "crew-chat")],
    ["audience", "t2", () => xAccess("finch", "t2", { human: who, notOwnerAudience: true })],
    ["crossThread", "finch-group", () => xAccess("finch", "finch-group")],
  ];
  const list: Record<string, Reader> = {};
  for (const [name, thread, access] of defs) {
    const a = access(), session = `R-${name}`;
    const bundle = await buildMemoryBundle(X_QUERY, a, hits([x]), { allowance: LineageAllowance.tool(), withheldMessage: readerWithheldMessage(a) });
    expect({ name, cites: bundle.recordVersions.some(v => v.id === x.id) }).toEqual({ name, cites: true });
    const receipt = new MemoryDispatchReceipt(bundle, a, "claude");
    receipt.sessionStarted(session); receipt.accepted();
    markSessionKnown(thread, "claude", session, "finch");
    xAppend(thread, xPerson(`ask-${name}`, "what is the side gate code?"));
    xAppend(thread, xBot(`reply-${name}`, { text: "The side gate code is GATE-7731." }));
    receipt.output(`reply-${name}`);
    list[name] = { thread, session, access, bundleId: bundle.bundleId };
  }
  // the copy (a delegation result's shape): a line of finch-group that copies the owner direct reply made with X
  xAppend("finch-group", xBot("copy-1", { text: "The side gate code is GATE-7731.", copyOf: { threadId: "finch-direct", messageIds: ["reply-ownerDirect"] } }));
  const big = LineageAllowance.tool(1_000_000_000);
  /** Each reader's receipt state and continuation check, the copy's origin and content verdicts, and the machine-wide revocation footprint. */
  const snapshot = () => ({
    readers: Object.fromEntries(Object.entries(list).map(([name, r]) => {
      const why: { reason?: string } = {};
      const reset = continuationMemoryRevoked(LineageAllowance.tool(), r.thread, "claude", r.session, r.access(), why);
      return [name, { receipt: receiptStates([r.bundleId])[0], reset, why: why.reason }];
    })),
    copy: { originUnavailable: copyOriginUnavailable("finch-direct", "reply-ownerDirect"), withheld: capturedMessageWithheld(big, "finch-group", "copy-1") },
    footprint: revocationFootprint(),
  });
  return { x, snapshot };
}

const readerActions: Record<string, (x: { id: string; version: number }) => () => void> = {
  pin: x => () => pinMemory(ownerMemoryTicket(), x.id, x.version, true),
  keep: x => {
    const db = database();
    const scope = String(db.prepare("SELECT scope_id FROM memory_records WHERE id=? AND version=?").get(x.id, x.version)!.scope_id);
    recordLearningEvent(db, { kind: "activated", scopeId: scope, recordId: x.id, recordVersion: x.version });
    const eventId = String(db.prepare("SELECT id FROM memory_learning_events WHERE record_id=? AND kind='activated' ORDER BY created_at DESC LIMIT 1").get(x.id)!.id);
    return () => { expect(changeLearningEvent(db, eventId, "keep")).toMatchObject({ kept: true }); };
  },
  remember: () => () => { expect(rememberMemory(ownerMemoryTicket(), { actionId: "remember-106-readers", text: "The owner's sister is called Maya." })).toMatchObject({ fresh: true }); },
};

it.each(Object.keys(readerActions))("readers: %s leaves an owner room, a channel person's thread, a second owner thread and a copy origin exactly as they were (base: pin and keep flip their receipts)", async name => {
  const { x, snapshot } = await readers();
  const act = readerActions[name]!(x);
  const before = snapshot();
  // every reader holds a delivered receipt citing X and its session passes before the action
  for (const [reader, state] of Object.entries(before.readers)) expect({ reader, ...state }).toEqual({ reader, receipt: "delivered", reset: false, why: undefined });
  expect(before.copy).toEqual({ originUnavailable: false, withheld: false });
  act();
  expect(snapshot()).toEqual(before);
});
