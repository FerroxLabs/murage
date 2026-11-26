// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: ctxrev-h1 (a re-imported notebook chunk with unchanged words: deny-read.ts contentReceiptVerdict/reimportedChunk, and the import's
// receipt ending, revocation.ts receiptsByRecordOnly as import.ts passes it). Producer side (tracked notebook re-import, reclaim-n6 unchanged
// chunks): import.ts owners. Consumer side (retained fence at every release, consuming response gate): send-fence.ts owners.
// 1.0.20 field: a routine appends to a notebook about once a minute and the tracked sync re-imports it. The re-import supersedes every chunk,
// its words unchanged included, and ended every receipt citing the notebook source ("memory receipts revoked scope=records cause=import"),
// so a running turn whose recall had cited ANY chunk of the notebook was refused at its next reply ("retained fence refused { refs:
// { receipt: 1, ... } }", MEMORY_CONTEXT_REVOKED fence=withheld/deny-memory), though nothing it was shown changed.
// Every receipt here is made by the real path: the turn's frame by buildMemoryBundle -> MemoryDispatchReceipt (prepare, join the running
// turn, deliver), its memory_search lookups by searchMemory -> MemoryDispatchReceipt.noteLookup. So each cites the chunk AND the notebook
// source at its revision, as production does. The import is the real tracked sync; every reply goes through the real consuming gate.
// Recall can place only a chunk that fits the remembered-words share (bundle.ts pinBudget: at most 2048 bytes above the frame), i.e. a
// notebook's last, partial chunk; a full 2048-byte chunk reaches a turn through memory_search. Both shapes are witnessed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { closeMessageDb } from "../message-db.ts";
import { ensureWorkspace } from "../workspace.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { resetDataRootsForTest } from "../data-roots.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { bindConsumingTurn, emitConsumingTurnResponse, registerConsumingDescriptor } from "../consuming-turn-response.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { commitMemoryImport, IMPORT_CHUNK_DIFF, previewMemoryImport, syncTrackedMemoryImports } from "./import.ts";
import { maintainRecallViewSlice, prepareRecallContextSync } from "./recall-view.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { searchMemory } from "./search.ts";
import { noteMemoryLookup, receiptLineageRef, resetSessionHolds } from "./disclosures.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { REVOKE_WRITE_BUDGET } from "./revoke-budget.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { writeMemory } from "./revoke-marker.ts";
import { denyGeneration, refsLookup } from "./deny-read.ts";
import { addTurnParents, checkedOpenTurns, closeTurnLineage, openTurnLineage, refuseRetainedTurn } from "./lineage-write.ts";
import { assertRetainedFence, prepareRetainedFence } from "./send-fence.ts";
import type { LineageReader, LineageRef, LineageVerdict } from "./lineage-types.ts";

const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: "a", threadId: "thread-a" }, { id: "b", threadId: "thread-b" }], groups: [] };
const OWNER: LineageReader = { audience: { owner: true, scopeIds: [] } };
const CONTENT: LineageReader = { audience: null };
const budget = REVOKE_WRITE_BUDGET.bytesPerMinute;
let warnings: string[] = [];
beforeEach(() => {
  closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetDataRootsForTest(); resetSessionHolds();
  reconcileMemoryRoster(roster);
  database().exec("UPDATE memory_meta SET mode='active'");
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")); });
});
// 1.0.21 cause10 (chunk-diff import, import.ts): a changed notebook no longer supersedes and rewrites a chunk whose words did not change. The
// chains this file is about (a cited version superseded by same-words versions) are still on every profile that ran 1.0.20 or 1.0.21, so
// these witnesses keep writing them: the import runs as it did then (IMPORT_CHUNK_DIFF.keep off), and every assertion stays as it was.
// The three "keeps replying" witnesses also run with the chunk-diff import (SHAPES), where the cited version simply stays the active one.
beforeEach(() => { IMPORT_CHUNK_DIFF.keep = false; });
afterEach(() => { IMPORT_CHUNK_DIFF.keep = true; REVOKE_WRITE_BUDGET.bytesPerMinute = budget; vi.restoreAllMocks(); closeMessageDb(); closeDatabase(); });
const SHAPES = [["as 1.0.20 wrote it (every chunk re-versioned)", false], ["chunk-diff import (unchanged chunks kept)", true]] as const;

// 64-byte lines, 32 to a 2048-byte chunk (chunks.ts), each chunk on its own subject: chunks 0-2 are full, chunk 3 (4 lines) is the last
const SUBJECTS = ["anchor", "harbor", "orchard", "granite"];
const line = (i: number) => `Line ${String(i).padStart(4, "0")}: ${SUBJECTS[Math.floor(i / 32)]} notes the owner keeps here`.padEnd(63, ".");
const lines = Array.from({ length: 100 }, (_, i) => line(i));
const LAST = 3;
/** A routine's same-length status rewrite of the notebook's first line: chunk 0 changes, no chunk boundary moves. */
const stamped = (day: number) => [`Line 0000: status checked 2026-11-${String(day).padStart(2, "0")} by the routine`.padEnd(63, "."), ...lines.slice(1)];
let path = "";
function seed(text: string) {
  const root = ensureWorkspace("a"), ticket = ownerMemoryTicket();
  path = join(root, "MEMORY.md");
  writeFileSync(path, text);
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
}
/** The routine writes the notebook; the tracked sync's next look (import.ts syncTrackedMemoryImports) re-imports it. */
function routineWrites(text: string) {
  writeFileSync(path, text);
  database().exec("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.checkedAt',0) WHERE subject_id='notebook-link'");
  syncTrackedMemoryImports(roster);
}
function access(bot = "a", thread = "thread-a") {
  const registry = new InternalCapabilities(), generation = registry.begin(bot, thread);
  const token = registry.mint({ botId: bot, threadId: thread, generation, depth: 0, kind: "memory", skillAuthoring: false });
  prepareRecallContextSync(bot, thread, roster);
  const a = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  while (!maintainRecallViewSlice(a.view)) { /* the recall view is built before the turn */ }
  return a;
}
const chunkOf = (index: number) => database().prepare("SELECT id,version,state FROM memory_records WHERE id LIKE ? ORDER BY version").all(`%:chunk:${index}`) as Array<{ id: string; version: number; state: string }>;
const active = (index: number) => chunkOf(index).find(row => row.state === "active")!;
const sourceOf = (index: number) => active(index).id.replace(/:chunk:\d+$/, "");
/** The search helper (the semantic index, a worker in production) answers with the chunk's current version. */
const helper = (index: number | null) => ({ search: async () => ({ hits: index === null ? [] : [{ id: active(index).id, version: active(index).version, score: 1, similarity: 0.9 }], vectorRows: 1, coverageComplete: true }) });
const receiptState = (bundleId: string) => (database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundleId) as { state: string }).state;
const undrainedFlip = (bundleId: string) => database().prepare("UPDATE memory_disclosures SET state='delivered' WHERE bundle_id=?").run(bundleId);
const release = (ref: LineageRef) => refsLookup(database(), [ref], CONTENT, true);
const refused = () => warnings.filter(text => text.startsWith("[memory] retained fence refused"));

/** The owner's running turn: its frame recall (the chunk `frame` brings, or none) is delivered and joined to the turn; every engine reply
 * is released only through the consuming response gate, which runs the retained fence (send-fence.ts) over everything the turn holds. */
async function runningTurn(frame: number | null, session = "session-a") {
  const db = database(), turnId = `turn-${session}`, a = access();
  const turn = openTurnLineage(db, { threadId: "thread-a", turnId });
  const refusedWith: LineageVerdict[] = [];
  prepareRetainedFence(turn, OWNER, verdict => { refusedWith.push(verdict); }, db);
  addTurnParents(turn, [{ kind: "none", reason: "owner-text" as never }]);
  const query = frame === null ? "anything new today" : `what are my ${SUBJECTS[frame]} notes`;
  const dispatch = new MemoryDispatchReceipt(await buildMemoryBundle(query, a, helper(frame), { allowance: LineageAllowance.tool() }), a, "fixture", turn);
  dispatch.sessionStarted(session); dispatch.accepted();
  const bundle = dispatch.bundle, ref = receiptLineageRef(db, bundle.bundleId)!;
  expect(() => assertRetainedFence(turn, db)).not.toThrow();
  const members = checkedOpenTurns(turn);
  const binding = bindConsumingTurn({
    identity: { botId: "a", threadId: "thread-a", dispatchGeneration: turnId, lineageTurnIds: members.map(m => m.turnId), adapterLeaseId: turnId },
    turn, db, isCurrent: () => true,
    onLedgerRefused: verdict => { for (const member of members) refuseRetainedTurn(member, verdict); },
  });
  const reply = () => { const write = vi.fn(() => "written"); emitConsumingTurnResponse(binding, registerConsumingDescriptor("native:openai:tool-append", "native"), { bytes: 8, refs: [], write }); return write; };
  /** The engine calls memory_search mid-turn: the hits join the turn on its lookup companion receipt. */
  const lookup = async (index: number) => {
    const found = await searchMemory(`what are my ${SUBJECTS[index]} notes`, a, helper(index), { allowance: LineageAllowance.tool() });
    expect(found.hits.map(hit => hit.id)).toContain(active(index).id);
    dispatch.noteLookup(found.hits.map(hit => ({ id: hit.id, version: hit.version, evidence: hit.evidence.map(handle => ({ sourceId: String(handle.sourceId), revision: Number(handle.revision) })) })), a);
    return { id: `${bundle.bundleId}:lookup`, ref: receiptLineageRef(db, `${bundle.bundleId}:lookup`)! };
  };
  /** A Flux/HTTP engine's next tool round: its adapter accepts the frame again before it submits (openai-chat.ts beforeWrite ->
   * MemoryDispatchReceipt.accepted -> dispatch.ts validateAcceptance -> disclosures.ts assertMemoryDisclosureCurrent). */
  const submit = () => dispatch.accepted();
  return { turn, bundle, ref, refusedWith, reply, lookup, submit, close: () => closeTurnLineage(turn) };
}
const replies = (w: { reply: () => ReturnType<typeof vi.fn> }) => { let write: ReturnType<typeof vi.fn> | undefined; expect(() => { write = w.reply(); }).not.toThrow(); expect(write).toHaveBeenCalledTimes(1); };

it.each(SHAPES)("RED ctxrev-h1: a running turn whose frame recall cited the notebook's last chunk keeps replying when a routine rewrites a status line [%s]", async (_shape, keep) => {
  IMPORT_CHUNK_DIFF.keep = keep;
  seed(lines.join("\n"));
  const w = await runningTurn(LAST);
  try {
    // the receipt production writes: the chunk at its version AND the notebook source at its revision
    expect(w.bundle.recordVersions).toEqual([{ id: active(LAST).id, version: 1 }]);
    expect(w.bundle.sourceVersions).toEqual([{ id: sourceOf(LAST), revision: 1 }]);
    replies(w);
    routineWrites(stamped(19).join("\n"));
    expect(chunkOf(0).map(row => row.state)).toEqual(["superseded", "active"]);
    expect(chunkOf(LAST).map(row => [row.version, row.state])).toEqual(keep ? [[1, "active"]] : [[1, "superseded"], [2, "active"]]);
    // v1.0.20: the import ended the receipt by the notebook source and the next reply was refused MEMORY_CONTEXT_REVOKED
    expect(receiptState(w.bundle.bundleId)).toBe("delivered");
    expect(release(w.ref)).toEqual({ state: "shown" });
    replies(w);
    routineWrites(stamped(20).join("\n"));
    expect(receiptState(w.bundle.bundleId)).toBe("delivered");
    replies(w);
    expect(w.refusedWith).toEqual([]);
    expect(refused()).toEqual([]);
  } finally { w.close(); }
  // the next turn's recall cites the replacement, and is released too
  const next = await runningTurn(LAST, "session-b");
  try { expect(next.bundle.recordVersions).toEqual([{ id: active(LAST).id, version: keep ? 1 : 3 }]); replies(next); } finally { next.close(); }
});

it.each(SHAPES)("RED ctxrev-h1: a running turn whose memory_search looked up a full notebook chunk keeps replying across a routine's appends [%s]", async (_shape, keep) => {
  IMPORT_CHUNK_DIFF.keep = keep;
  seed(lines.join("\n"));
  const w = await runningTurn(null);
  try {
    expect(w.bundle.recordVersions).toEqual([]);
    const found = await w.lookup(1);
    expect(JSON.parse(String(database().prepare("SELECT source_versions FROM memory_disclosures WHERE bundle_id=?").get(found.id)!.source_versions))).toEqual([{ id: sourceOf(1), revision: 1 }]);
    replies(w);
    routineWrites([...lines, line(100)].join("\n"));
    expect(chunkOf(1).map(row => row.state)).toEqual(keep ? ["active"] : ["superseded", "active"]);
    expect(chunkOf(LAST).map(row => row.state)).toEqual(["superseded", "active"]);
    expect(receiptState(found.id)).toBe("delivered");
    expect(release(found.ref)).toEqual({ state: "shown" });
    replies(w);
    routineWrites([...lines, line(100), line(101)].join("\n"));
    expect(release(found.ref)).toEqual({ state: "shown" });
    replies(w);
    expect(refused()).toEqual([]);
  } finally { w.close(); }
});

it("fail closed: a running turn shown the chunk an append changed is refused, and is withheld even before its receipt flips", async () => {
  seed(lines.join("\n"));
  const w = await runningTurn(LAST);
  try {
    expect(w.bundle.recordVersions.map(row => row.id)).toEqual([active(LAST).id]);
    routineWrites([...lines, line(100)].join("\n"));
    expect(receiptState(w.bundle.bundleId)).toBe("revoked");
    expect(() => w.reply()).toThrow(/MEMORY_CONTEXT_REVOKED/);
    expect(refused().length).toBeGreaterThan(0);
  } finally { w.close(); }
  // the field's undrained revoke backlog: the flip has not landed, so the fence must deny by content alone
  undrainedFlip(w.bundle.bundleId);
  expect(release(w.ref)).toEqual({ state: "withheld", reason: "deny-memory" });
});

it("fail closed: words changed then restored (A, B, A) withhold the lookup that was shown A", async () => {
  seed(lines.join("\n"));
  const w = await runningTurn(null);
  try {
    const found = await w.lookup(1);
    routineWrites(lines.map((text, i) => i === 40 ? text.replace("harbor", "Harbor") : text).join("\n"));
    routineWrites(lines.join("\n"));
    expect(chunkOf(1).map(row => row.state)).toEqual(["superseded", "superseded", "active"]);
    undrainedFlip(found.id);
    expect(release(found.ref)).toEqual({ state: "withheld", reason: "deny-memory" });
  } finally { w.close(); }
});

it("fail closed: the owner forgets the replacement revision, a revoke marks only the replacement, or the notebook is forgotten at its new revision", async () => {
  seed(lines.join("\n"));
  const w = await runningTurn(null);
  try {
    const found = await w.lookup(1);
    routineWrites([...lines, line(100)].join("\n"));
    expect(release(found.ref)).toEqual({ state: "shown" });
    const replacement = active(1);
    // forget.ts: a record tombstone names the revision forgotten (its delete job has not drained, so that version is still active)
    database().prepare("INSERT INTO memory_tombstones VALUES('tomb-record','record',?,?,NULL,0,'fixture',0)").run(replacement.id, replacement.version);
    expect(release(found.ref)).toEqual({ state: "withheld", reason: "deny-memory" });
    database().exec("DELETE FROM memory_tombstones WHERE id='tomb-record'");
    expect(release(found.ref)).toEqual({ state: "shown" });
    // the notebook source forgotten at its new revision
    database().prepare("INSERT INTO memory_tombstones VALUES('tomb-source','source',?,2,NULL,0,'fixture',0)").run(sourceOf(1));
    expect(release(found.ref)).toEqual({ state: "withheld", reason: "deny-memory" });
    database().exec("DELETE FROM memory_tombstones WHERE id='tomb-source'");
    expect(release(found.ref)).toEqual({ state: "shown" });
    // a deny mark on the replacement version only (revoke-marker.ts writeMemory, as a marker writes it for a record-scoped revoke): the held
    // receipt reads what a receipt citing the replacement itself reads
    const revokeId = commitRevoke(database(), { kind: "memory", ref: { kind: "record", id: replacement.id, version: replacement.version }, cause: "revise" });
    writeMemory(database(), revokeId, "record", replacement.id, replacement.version);
    expect(refsLookup(database(), [{ kind: "memory", ref: { kind: "record", id: replacement.id, version: replacement.version } }], CONTENT, true)).toEqual({ state: "withheld", reason: "deny-memory" });
    undrainedFlip(found.id);
    expect(release(found.ref)).toEqual({ state: "withheld", reason: "deny-memory" });
  } finally { w.close(); }
});

it("fail closed: a same-words replacement with other provenance (an owner statement), and a notebook source cited on its own, withhold", async () => {
  seed(lines.join("\n"));
  const w = await runningTurn(null);
  try {
    const found = await w.lookup(1);
    // a second turn's lookup companion cites the notebook source on its own (no chunk of it), at revision 1
    const other = await runningTurn(null, "session-b");
    expect(noteMemoryLookup(other.bundle.bundleId, `${other.bundle.bundleId}:lookup`, [], [{ sourceId: sourceOf(1), revision: 1 }])).toBe(true);
    const alone = receiptLineageRef(database(), `${other.bundle.bundleId}:lookup`)!;
    expect(release(alone)).toEqual({ state: "shown" });
    routineWrites([...lines, line(100)].join("\n"));
    expect(release(found.ref)).toEqual({ state: "shown" });
    undrainedFlip(`${other.bundle.bundleId}:lookup`);
    expect(release(alone)).toEqual({ state: "withheld", reason: "deny-memory" });
    other.close();
    // authority.ts: an owner correction keeps the id and can keep the words, but it is not the notebook's import
    database().prepare("UPDATE memory_records SET assertion='owner-statement' WHERE id=? AND state='active'").run(active(1).id);
    expect(release(found.ref)).toEqual({ state: "withheld", reason: "deny-memory" });
  } finally { w.close(); }
});

it("upgrade from 1.0.20 with the bad state present: a receipt its import already ended stays ended, and the next turn answers with no user action", async () => {
  seed(lines.join("\n"));
  const old = await runningTurn(LAST);
  routineWrites(stamped(19).join("\n"));
  old.close();
  // what 1.0.20's import left on disk: the receipt ended by the notebook source
  database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(old.bundle.bundleId);
  expect(release(old.ref)).toEqual({ state: "withheld", reason: "deny-memory" });
  // first start on the fix: the routine keeps writing, and the next turn (its own recall of the same chunk) answers
  routineWrites(stamped(20).join("\n"));
  const next = await runningTurn(LAST, "session-b");
  try {
    expect(next.bundle.recordVersions).toEqual([{ id: active(LAST).id, version: 3 }]);
    replies(next);
    routineWrites(stamped(21).join("\n"));
    replies(next);
    expect(refused()).toEqual([]);
  } finally { next.close(); }
});

it("H1 guard: a fresh chat is released across import ticks, also when a tick commits a write-time revoke (deny_generation moves)", async () => {
  seed(lines.join("\n"));
  const w = await runningTurn(null);
  try {
    expect(w.bundle.recordVersions).toEqual([]);
    routineWrites([...lines, line(100)].join("\n"));
    expect(release(w.ref)).toEqual({ state: "shown" });
    replies(w);
    // a queued receipt flip defeats the checkwin probe (revocation.ts importShownProbe): each changed chunk then takes a write-time revoke
    REVOKE_WRITE_BUDGET.bytesPerMinute = 1;
    database().exec("INSERT INTO memory_receipt_flips VALUES(999999,1,'queued-flip')");
    const g0 = denyGeneration(database());
    routineWrites([...lines, line(100), line(101)].join("\n"));
    expect(denyGeneration(database())).toBeGreaterThan(g0);
    expect(release(w.ref)).toEqual({ state: "shown" });
    replies(w);
  } finally { w.close(); }
});

it.each(SHAPES)("RED ctxrev-h1 RS1: a Flux/HTTP turn whose frame recall cited the notebook's last chunk submits its next tool round after a status rewrite [%s]", async (_shape, keep) => {
  IMPORT_CHUNK_DIFF.keep = keep;
  seed(lines.join("\n"));
  const w = await runningTurn(LAST);
  try {
    expect(w.bundle.sourceVersions).toEqual([{ id: sourceOf(LAST), revision: 1 }]);
    expect(() => w.submit()).not.toThrow();
    routineWrites(stamped(19).join("\n"));
    expect(chunkOf(LAST).map(row => [row.version, row.state])).toEqual(keep ? [[1, "active"]] : [[1, "superseded"], [2, "active"]]);
    // v1.0.20 and 13eafce821: disclosures.ts revokedReason read "source <notebook>@1 now@2" and the round was refused MEMORY_CONTEXT_REVOKED
    expect(() => w.submit()).not.toThrow();
    routineWrites(stamped(20).join("\n"));
    expect(() => w.submit()).not.toThrow();
    replies(w);
    expect(refused()).toEqual([]);
  } finally { w.close(); }
});

it("fail closed RS1: the HTTP tool round is refused when the frame's chunk changed, was removed, or is forgotten at a later revision", async () => {
  seed(lines.join("\n"));
  const changed = await runningTurn(LAST);
  try {
    routineWrites([...lines, line(100)].join("\n"));
    expect(() => changed.submit()).toThrow(/MEMORY_CONTEXT_REVOKED/);
  } finally { changed.close(); }
  const forgotten = await runningTurn(LAST, "session-b");
  try {
    // the notebook now ends with line 100 (the append above): only chunk 0 changes
    routineWrites([...stamped(19), line(100)].join("\n"));
    expect(() => forgotten.submit()).not.toThrow();
    database().prepare("INSERT INTO memory_tombstones VALUES('tomb-later','record',?,?,NULL,0,'fixture',0)").run(active(LAST).id, active(LAST).version);
    expect(() => forgotten.submit()).toThrow(/MEMORY_CONTEXT_REVOKED/);
    database().exec("DELETE FROM memory_tombstones WHERE id='tomb-later'");
    database().prepare("INSERT INTO memory_tombstones VALUES('tomb-src','source',?,?,NULL,0,'fixture',0)").run(sourceOf(LAST), active(LAST).version);
    expect(() => forgotten.submit()).toThrow(/MEMORY_CONTEXT_REVOKED/);
    database().exec("DELETE FROM memory_tombstones WHERE id='tomb-src'");
    expect(() => forgotten.submit()).not.toThrow();
    // a forget of the chunk at an in-between revision only (cited v2, forgotten v3, newest v4): the replacement itself reads clean, so only
    // the retained content verdict (deny-read.ts contentReceiptVerdict) refuses it, and the HTTP round must refuse with it
    routineWrites([...stamped(20), line(100)].join("\n"));
    expect(chunkOf(LAST).map(row => row.version)).toEqual([1, 2, 3, 4]);
    database().prepare("INSERT INTO memory_tombstones VALUES('tomb-mid','record',?,3,NULL,0,'fixture',0)").run(active(LAST).id);
    expect(release(forgotten.ref)).toEqual({ state: "withheld", reason: "deny-memory" });
    expect(() => forgotten.submit()).toThrow(/MEMORY_CONTEXT_REVOKED/);
  } finally { forgotten.close(); }
});

it("fail closed (round 0, restored): a chunk the notebook no longer has (a shorter notebook) withholds the lookup that was shown it", async () => {
  seed(lines.join("\n"));
  const w = await runningTurn(null);
  try {
    const found = await w.lookup(2);
    routineWrites(lines.slice(0, 64).join("\n"));
    expect(chunkOf(2).map(row => row.state)).toEqual(["superseded"]);
    undrainedFlip(found.id);
    expect(release(found.ref)).toEqual({ state: "withheld", reason: "deny-memory" });
    // restored with the same words at a later revision (versions 1 and 3, no 2): still the removed chunk for the holder of version 1
    routineWrites(lines.join("\n"));
    expect(chunkOf(2).map(row => [row.version, row.state])).toEqual([[1, "superseded"], [3, "active"]]);
    undrainedFlip(found.id);
    expect(release(found.ref)).toEqual({ state: "withheld", reason: "deny-memory" });
  } finally { w.close(); }
});

it("fail closed (round 0, restored): identical words then a change (A, A, B) withholds the lookup that was shown A", async () => {
  seed(lines.join("\n"));
  const w = await runningTurn(null);
  try {
    const found = await w.lookup(1);
    routineWrites([...lines, line(100)].join("\n"));
    expect(release(found.ref)).toEqual({ state: "shown" });
    routineWrites([...lines.map((text, i) => i === 40 ? text.replace("harbor", "Harbor") : text), line(100)].join("\n"));
    expect(chunkOf(1).map(row => row.state)).toEqual(["superseded", "superseded", "active"]);
    undrainedFlip(found.id);
    expect(release(found.ref)).toEqual({ state: "withheld", reason: "deny-memory" });
  } finally { w.close(); }
});

it("fail closed RJ4a: a forget of an in-between revision (v2 of v1..v3), with no other mark, withholds the lookup that was shown v1", async () => {
  seed(lines.join("\n"));
  const w = await runningTurn(null);
  try {
    const found = await w.lookup(1);
    routineWrites([...lines, line(100)].join("\n"));
    routineWrites([...lines, line(100), line(101)].join("\n"));
    expect(chunkOf(1).map(row => [row.version, row.state])).toEqual([[1, "superseded"], [2, "superseded"], [3, "active"]]);
    expect(release(found.ref)).toEqual({ state: "shown" });
    // forget.ts names the revision forgotten; only version 2 carries it (neither the cited v1 nor the newest v3 is marked or tombstoned)
    database().prepare("INSERT INTO memory_tombstones VALUES('tomb-mid','record',?,2,NULL,0,'fixture',0)").run(active(1).id);
    expect(release(found.ref)).toEqual({ state: "withheld", reason: "deny-memory" });
    database().exec("DELETE FROM memory_tombstones WHERE id='tomb-mid'");
    // the notebook forgotten at the in-between revision only
    database().prepare("INSERT INTO memory_tombstones VALUES('tomb-mid-src','source',?,2,NULL,0,'fixture',0)").run(sourceOf(1));
    expect(release(found.ref)).toEqual({ state: "withheld", reason: "deny-memory" });
  } finally { w.close(); }
});
