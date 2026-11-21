// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: ctxrev-selfheal (selfheal-1021.ts). Producer side of the stuck data (tracked notebook re-import, import.ts): import / ctxrev-h1
// owners. Consumer side (retained fence refsLookup/fenceVerdict, sessionLookup, deny-read.ts): fence owners. Undo and the paced drain
// (revoke-commit.ts undoRevoke, memory-revocation.ts drainRevokeMarkerBounded): revoke-marker owners.
// 1.0.20 field: a routine appends to a notebook about once a minute; each tracked re-import supersedes every chunk, unchanged words
// included. A turn holding a receipt citing one of them is refused (MEMORY_CONTEXT_REVOKED fence=withheld/deny-memory), and write-time
// revokes of unchanged chunk versions hold resumed sessions at checking:pending. The data stays that way across an upgrade: 1.0.21 must
// heal it on its first start, without bringing back anything the owner deleted, forgot or changed.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { classifyDataDirEntry } from "../data-dir-inventory.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureWorkspace } from "../workspace.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { commitMemoryImport, previewMemoryImport, syncTrackedMemoryImports } from "./import.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { denyGeneration, fenceVerdict, refsLookup } from "./deny-read.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { bindMemoryDisclosureSession, deliverMemoryDisclosure, prepareMemoryDisclosure, receiptLineageRef } from "./disclosures.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { drainRevokeMarkerBounded, INLINE_REVOCATION, revokeRecordsBounded, runRevocationJobsNow } from "./memory-revocation.ts";
import { enqueueReceipts } from "./revoke-marker.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { proofModule, receipts as proofReceipts, setupProofFixture } from "./session-proof-fixture.ts";
import { MEMORY_REPAIRS_FILE } from "./keepall-unwedge.ts";
import { logReceiptRewrite, SELFHEAL_1021, SELFHEAL_SIDE_FILE, selfHealed1021, startSelfHeal1021, type SelfHealDeps } from "./selfheal-1021.ts";
import type { BuiltPrompt, LineageReader, LineageRef } from "./lineage-types.ts";

// The rename every memory-repairs write ends with, passed through to node:fs; a test arms `rename` to stop a start right there.
const fsHook = vi.hoisted(() => ({ rename: null as null | ((from: string, to: string) => void) }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const renameSync: typeof fs.renameSync = (from, to) => { fsHook.rename?.(String(from), String(to)); fs.renameSync(from, to); };
  return { ...fs, renameSync, default: { ...fs, renameSync } };
});
// The importer as 1.0.20 ran it: its re-import queued the receipt job by the notebook SOURCE too (revocation.ts viaSources). 1.0.21's ctxrev-h1
// (import.ts receiptsByRecordOnly) ends a receipt only by a withdrawn record it cites, so today's importer cannot build the field's stuck
// data on its own; `reimport` below runs it with that one h1 option off. Every reader (fence, heal, runner) is today's code.
const v1020 = vi.hoisted(() => ({ importer: false }));
vi.mock("./revocation.ts", async importOriginal => {
  const revocation = await importOriginal<typeof import("./revocation.ts")>();
  const revokeRecordDisclosures: typeof revocation.revokeRecordDisclosures = (db, cause, affected) => {
    if (!v1020.importer) return revocation.revokeRecordDisclosures(db, cause, affected);
    const { receiptsByRecordOnly: _h1, ...as1020 } = affected;
    return revocation.revokeRecordDisclosures(db, cause, as1020);
  };
  return { ...revocation, revokeRecordDisclosures };
});
const roster = { bots: [{ id: "a", threadId: "thread-a" }, { id: "b", threadId: "thread-b" }], groups: [] };
const CONTENT: LineageReader = { audience: null };
const quiet: SelfHealDeps = { log: () => {}, warn: () => {} };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster);
  database().exec("UPDATE memory_meta SET mode='active'");
});
afterEach(() => { fsHook.rename = null; vi.restoreAllMocks(); });
const line = (i: number) => `Line ${String(i).padStart(4, "0")}: durable owner context that a routine keeps.`;
const lines = Array.from({ length: 600 }, (_, i) => line(i));
let notebook = "";
function seed(text: string) {
  const root = ensureWorkspace("a"), ticket = ownerMemoryTicket();
  notebook = join(root, "MEMORY.md");
  writeFileSync(notebook, text);
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
}
/** The tracked sync a running 1.0.20 did every 10 s (import.ts syncTrackedMemoryImports), on new notebook text. Its receipt flips (import.ts
 * T5: the receipts citing the withdrawn chunks and the notebook source) are left to the durable job, as in the field, where the paced runner
 * was hours behind: the receipts stay live, still citing the old chunk versions and notebook revision. */
function reimport(text: string, of: Parameters<typeof syncTrackedMemoryImports>[0] = roster) {
  writeFileSync(notebook, text);
  database().exec("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.checkedAt',0) WHERE subject_id='notebook-link'");
  const inline = { ...INLINE_REVOCATION };
  Object.assign(INLINE_REVOCATION, { rows: 0, ms: 0 });
  v1020.importer = true;
  try { syncTrackedMemoryImports(of); } finally { v1020.importer = false; Object.assign(INLINE_REVOCATION, inline); }
}
/** The notebook with one line inside each chunk in `changed` reworded (same length, so every chunk boundary stays where it was). */
function revised(changed: number[], extra: string[] = []) {
  const out = [...lines];
  for (const k of changed) {
    const text = String((database().prepare("SELECT text FROM memory_records WHERE id LIKE ? AND version=1").get(`%:chunk:${k}`) as { text: string }).text);
    const i = out.findIndex(l => text.includes(`${l}\n`) && !text.startsWith(l));
    out[i] = out[i]!.replace("durable", "revised");
  }
  return [...out, ...extra].join("\n");
}
/** The notebook source revisions the evidence of `records` names: what bundle.ts writes beside the chunks (sourceVersions). */
const evidenceOf = (records: Array<{ id: string; version: number }>) => [...new Map(records.flatMap(r => database()
  .prepare("SELECT source_id AS id,source_revision AS revision FROM memory_evidence WHERE record_id=? AND record_version=?").all(r.id, r.version) as Array<{ id: string; revision: number }>)
  .map(e => [`${e.id}\u0000${e.revision}`, { id: String(e.id), revision: Number(e.revision) }])).values()];
/** A receipt as production writes it (bundle.ts recordVersions + sourceVersions, disclosures.ts): the chunks and their notebook revision. */
function receipt(id: string, thread: string, records: Array<{ id: string; version: number }>, state = "delivered") {
  database().prepare("INSERT INTO memory_disclosures SELECT ?,?,'fixture','session-x',?,?,'[]',policy_revision,deletion_epoch,0,?,? FROM memory_meta WHERE id=1")
    .run(id, thread, JSON.stringify(records), JSON.stringify(evidenceOf(records)), state, Date.now());
  return receiptLineageRef(database(), id)!;
}
const chunks = () => database().prepare("SELECT id,version FROM memory_records WHERE id LIKE '%:chunk:%' AND state='active' ORDER BY CAST(substr(id, instr(id, ':chunk:') + 7) AS INTEGER)").all() as Array<{ id: string; version: number }>;
const OWNER_TURN: LineageRef = { kind: "none", reason: "owner-turn" };
const prompt = (refs: LineageRef[]): BuiltPrompt => ({ ...buildPrompt(undefined, [promptPart("words", refs)]), denyGeneration: denyGeneration(database()) }) as BuiltPrompt;
/** What the retained fence reads at every release of a turn holding `held` (send-fence.ts assertRetainedFence). */
const release = (held: BuiltPrompt) => refsLookup(database(), held.parts.flatMap(part => part.lineageOf), CONTENT, true);
const sourcesCited = (id: string) => JSON.parse(String((database().prepare("SELECT source_versions FROM memory_disclosures WHERE bundle_id=?").get(id) as { source_versions: string }).source_versions));
const notebookRevision = () => Number((database().prepare("SELECT s.revision FROM memory_sources s JOIN memory_evidence e ON e.source_id=s.id LIMIT 1").get() as { revision: number }).revision);
const cites = (id: string) => JSON.parse(String((database().prepare("SELECT record_versions FROM memory_disclosures WHERE bundle_id=?").get(id) as { record_versions: string }).record_versions));
const receiptState = (id: string) => (database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(id) as { state: string }).state;
const jobState = (id: number) => (database().prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(id) as { state: string } | undefined)?.state;
const pendingRows = (id: number) => Number((database().prepare("SELECT (SELECT count(*) FROM memory_deny_pending WHERE revoke_id=?1)+(SELECT count(*) FROM memory_deny_pending_scope WHERE revoke_id=?1) AS n").get(id) as { n: number }).n);
/** The pass is recorded complete (memory-repairs.json keeps a pass in progress under the same key, with done false). */
const flagged = () => existsSync(join(DATA_DIR, MEMORY_REPAIRS_FILE)) && JSON.parse(readFileSync(join(DATA_DIR, MEMORY_REPAIRS_FILE), "utf8"))[SELFHEAL_1021]?.done === true;
/** A revoke an earlier build's re-import committed for one chunk version (import.ts before reclaim-n6, or `cause` for an owner action). */
function oldRevoke(id: string, version: number, cause: "revise" | "archive" | "retire" = "revise"): number {
  // queued, not walked inline: the field's runner was hours behind a paced backlog
  const db = database(), inline = INLINE_REVOCATION.ms;
  INLINE_REVOCATION.ms = 0;
  db.exec("BEGIN IMMEDIATE");
  try { const r = commitRevoke(db, { kind: "memory", ref: { kind: "record", id, version }, cause }); db.exec("COMMIT"); return r; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { INLINE_REVOCATION.ms = inline; }
}
/** The existing runner's bounded drain, until it has nothing left (what the after-listen revoke runner does at its pace). */
function drain() { for (let i = 0; i < 200 && drainRevokeMarkerBounded(database(), { rows: 4096, ms: 250 }, { background: true }); i++) { /* runner */ } }

it("RED ctxrev-selfheal W1: a 1.0.20 data dir whose held receipt cites unchanged re-imported chunks refuses; after the heal it answers", async () => {
  seed(lines.join("\n"));
  const cited = chunks();
  const held = prompt([receipt("held", "thread-a", cited.slice(0, 2)), OWNER_TURN]);
  reimport([...lines, line(600)].join("\n"));
  reimport([...lines, line(600), line(601)].join("\n"));
  // the stuck state as 1.0.20 left it: the receipt still delivered, citing v1 of chunks that are now v3 with the same words
  expect(receiptState("held")).toBe("delivered");
  // still refused before the heal. On 1.0.20 the fence withheld it (deny-memory: a superseded version). On the 1.0.21 combine, ctxrev-h1's
  // re-import carry (deny-read.ts reimportCarry) reads the unchanged chunks at v3, and the re-imports' queued revokes hold it at pending
  expect(release(held)).toEqual({ state: "checking", reason: "pending" });

  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  expect(cites("held")).toEqual(cited.slice(0, 2).map(c => ({ id: c.id, version: 3 })));
  // the notebook revision the receipt names beside the chunks moves with them (deny-read.ts receipt walk: a stale revision is withheld)
  expect(sourcesCited("held")).toEqual([{ id: expect.any(String), revision: notebookRevision() }]);
  // the re-imports' own revokes of the chunk whose words did change (the appended lines) hold their windows until the runner walks them
  drain();
  expect(release(held)).toEqual({ state: "shown" });
  expect(fenceVerdict(database(), held, CONTENT)).toEqual({ state: "shown" });
  expect(receiptState("held")).toBe("delivered");
  // no record changed state: nothing was restored, only the receipt's pointer moved
  expect(database().prepare("SELECT version,state FROM memory_records WHERE id=? ORDER BY version").all(cited[0]!.id))
    .toEqual([{ version: 1, state: "superseded" }, { version: 2, state: "superseded" }, { version: 3, state: "active" }]);
  // a healed install is not scanned again; with the flag gone a second run finds nothing to do (idempotent)
  expect(flagged()).toBe(true);
  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("already");
  rmSync(join(DATA_DIR, MEMORY_REPAIRS_FILE));
  const log: string[] = [];
  expect(await startSelfHeal1021(database(), DATA_DIR, { ...quiet, log: l => log.push(l) })).toBe("healed");
  expect(log.join("\n")).toContain("receipts re-pointed=0 refs=0");
  expect(release(held)).toEqual({ state: "shown" });
  // the heal never cancels an end 1.0.20 queued: the re-imports' receipt job (import.ts T5, the notebook source) still ends it when it runs
  runRevocationJobsNow(database());
  expect(receiptState("held")).toBe("revoked");
});

it("RED ctxrev-selfheal W2: a queued no-op import revoke holds its pending windows open; the heal undoes it, the paced runner clears it, the receipt it held answers", async () => {
  seed(lines.join("\n"));
  const [c0] = chunks();
  receipt("held", "thread-a", [c0!]);
  reimport([...lines, line(600)].join("\n"));
  const R = oldRevoke(c0!.id, 1);
  // the stuck state: the revoke queued behind the paced backlog, its pending rows held open
  expect(jobState(R)).toBe("active");
  expect(pendingRows(R)).toBeGreaterThan(0);

  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  expect(jobState(R)).toBe("undoing");
  drain();
  expect(pendingRows(R)).toBe(0);
  expect(receiptState("held")).toBe("delivered");
  expect(release(prompt([receiptLineageRef(database(), "held")!, OWNER_TURN]))).toEqual({ state: "shown" });
});

it("never revives: revoked receipts, changed chunks, tombstoned or scope-denied chunks and real revokes are left as they are", async () => {
  seed(lines.join("\n"));
  const cited = chunks();
  const [c0, c1, c2, c3, c4] = cited;
  const revoked = receipt("revoked", "thread-a", [c1!], "revoked");
  const changed = prompt([receipt("changed", "thread-a", [c0!]), OWNER_TURN]);
  const tomb = prompt([receipt("tomb", "thread-a", [c2!]), OWNER_TURN]);
  const ok = prompt([receipt("ok", "thread-b", [c4!]), OWNER_TURN]);
  // v1 = v2 for every chunk, then chunk 0's words change (v3 differs): its v1 receipt must stay withdrawn
  reimport([...lines, line(600)].join("\n"));
  reimport([line(0).replace("durable", "revised"), ...lines.slice(1), line(600)].join("\n"));
  database().exec("UPDATE memory_disclosures SET state='delivered' WHERE bundle_id IN ('changed','tomb','ok')");
  database().prepare("INSERT INTO memory_tombstones VALUES('tomb-fixture','record',?,?,NULL,0,'fixture',0)").run(c2!.id, c2!.version);
  // a revoke that withdrew real words (chunk 0 changed) and an owner archive of an unchanged chunk: neither is undone
  const real = oldRevoke(c0!.id, 2);
  const archive = oldRevoke(c3!.id, 1, "archive");
  const before = { revoked: cites("revoked"), changed: cites("changed"), tomb: cites("tomb") };

  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  expect(receiptState("revoked")).toBe("revoked");
  expect(cites("revoked")).toEqual(before.revoked);
  expect(cites("changed")).toEqual(before.changed);
  expect(cites("tomb")).toEqual(before.tomb);
  expect(release(changed)).toEqual({ state: "withheld", reason: "deny-memory" });
  expect(release(tomb)).toEqual({ state: "withheld", reason: "deny-memory" });
  expect(jobState(real)).toBe("active");
  expect(jobState(archive)).toBe("active");
  // the control: an unchanged chunk nobody withdrew is re-pointed in the same run, and answers once the real revokes' windows close
  expect(cites("ok")).toEqual([{ id: c4!.id, version: 3 }]);
  drain();
  expect(release(changed)).toEqual({ state: "withheld", reason: "deny-memory" });
  expect(release(tomb)).toEqual({ state: "withheld", reason: "deny-memory" });
  expect(release(ok)).toEqual({ state: "shown" });
  void revoked;
});

it("never revives: a chunk whose scope the owner denied is not re-pointed and stays withheld", async () => {
  seed(lines.join("\n"));
  const [c0] = chunks();
  const denied = prompt([receipt("denied", "thread-a", [c0!]), OWNER_TURN]);
  reimport([...lines, line(600)].join("\n"));
  const scope = String((database().prepare("SELECT scope_id FROM memory_records WHERE id=? AND version=1").get(c0!.id) as { scope_id: string }).scope_id);
  database().prepare("INSERT INTO memory_deny VALUES('scope',?,0,0)").run(scope);
  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  expect(cites("denied")).toEqual([{ id: c0!.id, version: 1 }]);
  expect(release(denied)).toEqual({ state: "withheld", reason: "deny-memory" });
});

it("bounded per start and crash-safe: a cut-short run keeps nothing half-done, writes no flag, and the next start finishes", async () => {
  seed(lines.join("\n"));
  const cited = chunks();
  for (let i = 0; i < 5; i++) receipt(`r${i}`, "thread-a", [cited[i]!]);
  reimport([...lines, line(600)].join("\n"));
  // a crash inside the first slice: rolled back, no flag
  let crash = true;
  expect(await startSelfHeal1021(database(), DATA_DIR, { ...quiet, onSlice: () => { if (crash) { crash = false; throw new Error("crash"); } } })).toBe("gave-up");
  expect(flagged()).toBe(false);
  expect(cites("r0")).toEqual([{ id: cited[0]!.id, version: 1 }]);
  // a row bound: two receipts this start, no flag
  expect(await startSelfHeal1021(database(), DATA_DIR, { ...quiet, limits: { receipts: 2, sliceRows: 1 } })).toBe("bounded");
  expect(flagged()).toBe(false);
  const moved = [0, 1, 2, 3, 4].filter(i => cites(`r${i}`)[0].version === 2).length;
  expect(moved).toBe(2);
  // the next start carries on and finishes
  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  for (let i = 0; i < 5; i++) expect(cites(`r${i}`)).toEqual([{ id: cited[i]!.id, version: 2 }]);
  expect(flagged()).toBe(true);
});

/** One write transaction, as the field's writers ran theirs. */
function tx<T>(run: () => T): T {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try { const r = run(); db.exec("COMMIT"); return r; } catch (error) { db.exec("ROLLBACK"); throw error; }
}
const frontierNodes = (id: number) => (database().prepare("SELECT node FROM memory_revoke_frontier WHERE revoke_id=? AND seq>0 ORDER BY seq").all(id) as Array<{ node: string }>).map(r => JSON.parse(r.node));

it("H1 never undoes a revoke that carries more than its own unchanged chunk: another excerpt's receipts, walked marks or a pending receipt job", async () => {
  seed(lines.join("\n"));
  const [c0, c1, c2, c3, c4] = chunks();
  receipt("withdrawn", "thread-b", [c1!]);
  // chunk 1's words change; chunks 0, 2, 3 and 4 keep theirs
  reimport(revised([1], [line(600)]));
  // revocation.ts:92 keeps the batch's FIRST revoke id, and memory-revocation.ts:715 hands every receipt hit of the batch to it: the first
  // revoke (an unchanged chunk) carries the receipt that showed chunk 1's withdrawn words
  const first = oldRevoke(c0!.id, 1);
  oldRevoke(c1!.id, 1);
  tx(() => { database().exec("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='withdrawn'"); enqueueReceipts(database(), first, ["withdrawn"]); });
  expect(frontierNodes(first)).toContainEqual({ kind: "receipt", bundleId: "withdrawn" });
  // a revoke the marker already walked: its line marks cannot be told apart from the batch's
  const walked = oldRevoke(c3!.id, 1);
  database().prepare("INSERT INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES('thread-b',7,?,7,'receipt')").run(walked);
  // a revoke a deferred receipt job still names (revokeRecordsBounded with the batch's revoke id): it enqueues more receipts later
  const named = oldRevoke(c4!.id, 1);
  const inline = { ...INLINE_REVOCATION };
  Object.assign(INLINE_REVOCATION, { rows: 0, ms: 0 });
  try { tx(() => revokeRecordsBounded(database(), "import", [c1!.id], [], true, named)); } finally { Object.assign(INLINE_REVOCATION, inline); }
  expect(database().prepare("SELECT 1 AS x FROM memory_scope_bindings WHERE subject_id='memory-revocation' AND json_extract(intent,'$.revokeId')=?").get(named)).toBeTruthy();
  // the control: an unchanged chunk's revoke that carries nothing else
  const alone = oldRevoke(c2!.id, 1);

  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  expect(jobState(first)).toBe("active");
  expect(frontierNodes(first)).toContainEqual({ kind: "receipt", bundleId: "withdrawn" });
  expect(jobState(walked)).toBe("active");
  expect(Number((database().prepare("SELECT count(*) AS n FROM memory_deny_line WHERE revoke_id=?").get(walked) as { n: number }).n)).toBe(1);
  expect(jobState(named)).toBe("active");
  expect(jobState(alone)).toBe("undoing");
  expect(receiptState("withdrawn")).toBe("revoked");
});

it("H2 an import tombstone on the notebook's scope and contents (forget.ts: by scope and content hash) keeps its chunks withdrawn", async () => {
  seed(lines.join("\n"));
  const [c0] = chunks();
  const copied = prompt([receipt("copied", "thread-a", [c0!]), OWNER_TURN]);
  reimport([...lines, line(600)].join("\n"));
  // forget.ts:75 tombstones a forgotten source's contents by SCOPE and HASH; a copy of it imported meanwhile is still active until its
  // cleanup runs (memory-revocation.ts importWindowStep)
  const at = database().prepare(`SELECT s.scope_id,v.content_hash FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id
    JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision WHERE e.record_id=? AND e.record_version=1`).get(c0!.id) as { scope_id: string; content_hash: string };
  database().prepare("INSERT INTO memory_tombstones VALUES('import-fixture','import',?,NULL,?,0,'forgotten-original',0)").run(at.scope_id, at.content_hash);
  const copiedRevoke = oldRevoke(c0!.id, 1);

  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  expect(cites("copied")).toEqual([{ id: c0!.id, version: 1 }]);
  expect(jobState(copiedRevoke)).toBe("active");
  drain();
  expect(release(copied)).toEqual({ state: "withheld", reason: "deny-memory" });
});

it("H2 a deny mark the marker wrote on the cited version, by a revoke that still stands, keeps the receipt where it is", async () => {
  seed(lines.join("\n"));
  const [, c1] = chunks();
  const hidden = prompt([receipt("hidden", "thread-a", [c1!]), OWNER_TURN]);
  reimport([...lines, line(600)].join("\n"));
  // a removing revoke naming chunk 1's cited version (revoke-commit.ts REMOVING writes its memory_deny_memory mark at commit; deny-read.ts
  // memoryVerdict enforces it), still standing (active, not undone)
  oldRevoke(c1!.id, 1, "retire");
  expect(database().prepare("SELECT 1 AS x FROM memory_deny_memory WHERE kind='record' AND id=? AND version IN (0,1)").get(c1!.id)).toBeTruthy();

  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  expect(cites("hidden")).toEqual([{ id: c1!.id, version: 1 }]);
  expect(release(hidden)).toEqual({ state: "withheld", reason: "deny-memory" });
});

it("H4 every rewritten receipt is logged for the session proof: a retained session over it replays fresh, never resumes over the rewrite", async () => {
  seed(lines.join("\n"));
  const cited = chunks();
  receipt("held", "thread-a", cited.slice(0, 2));
  reimport([...lines, line(600)].join("\n"));
  const seq = () => Number((database().prepare("SELECT coalesce(max(seq),0) AS s FROM memory_session_change_log WHERE id='receipt:held'").get() as { s: number }).s);
  expect(seq()).toBe(0);
  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  expect(cites("held")[0].version).toBe(2);
  expect(seq()).toBeGreaterThan(0);
  // the rewrite itself revokes nothing (the proof's fresh replay is what it asks for)
  expect(receiptState("held")).toBe("delivered");
  // the heal never cancels an end 1.0.20 queued: the re-import's receipt job (import.ts T5, the notebook source) still ends it when it runs
  runRevocationJobsNow(database());
  expect(receiptState("held")).toBe("revoked");
  expect(release(prompt([receiptLineageRef(database(), "held")!, OWNER_TURN]))).toEqual({ state: "withheld", reason: "deny-memory" });
});

it("H4 consumer: the logged rewrite makes the real retained-session proof answer with an authorized fresh replay", async () => {
  const f = setupProofFixture("direct"), p = await proofModule();
  const [bundle] = await proofReceipts(f, 1);
  const prove = () => p.proveRetainedSession(LineageAllowance.tool(), f.key, { access: f.access, disclosed: true });
  expect(prove()).toEqual({ kind: "resume" });
  logReceiptRewrite(database(), bundle!);
  expect(prove()).toEqual({ kind: "fresh", reason: "changed:receipt", cause: "denied" });
});

it("H5 progress survives a restart: a prefix of receipts it cannot repair never starves a later one, and a reopened file carries on", async () => {
  seed(lines.join("\n"));
  const cited = chunks();
  // three receipts first whose chunk words change (never repairable), then one that is
  for (let i = 0; i < 3; i++) receipt(`bad${i}`, "thread-a", [cited[i]!]);
  receipt("late", "thread-a", [cited[10]!]);
  reimport(revised([0, 1, 2], [line(600)]));
  const outcomes: string[] = [];
  for (let start = 0; start < 4 && !flagged(); start++) {
    outcomes.push(await startSelfHeal1021(database(), DATA_DIR, { ...quiet, limits: { receipts: 2, sliceRows: 1 } }));
    closeDatabase(); // a restart between starts: nothing carried in memory
  }
  expect(outcomes[0]).toBe("bounded");
  expect(cites("late")).toEqual([{ id: cited[10]!.id, version: 2 }]);
  expect(flagged()).toBe(true);
  for (let i = 0; i < 3; i++) expect(cites(`bad${i}`)).toEqual([{ id: cited[i]!.id, version: 1 }]);
});

it("H5 a rollback to 1.0.20 and a second upgrade: data 1.0.20 left stuck after the flag is healed again, not skipped", async () => {
  seed(lines.join("\n"));
  const cited = chunks();
  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  expect(flagged()).toBe(true);
  // the same profile back on 1.0.20: a held receipt, then its tracked re-import supersedes the unchanged chunk again
  receipt("after", "thread-a", [cited[5]!]);
  reimport([...lines, line(600)].join("\n"));
  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  expect(cites("after")).toEqual([{ id: cited[5]!.id, version: 2 }]);
  // nothing new since: the next start skips
  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("already");
});

it("H5 a completion marker interrupted before its rename leaves no flag: the next start runs again and changes nothing", async () => {
  seed(lines.join("\n"));
  const cited = chunks();
  receipt("r", "thread-a", [cited[0]!]);
  receipt("r2", "thread-a", [cited[1]!]);
  reimport([...lines, line(600)].join("\n"));
  // the slice committed, the marker's temp file written, the process gone before the rename
  expect(await startSelfHeal1021(database(), DATA_DIR, { ...quiet, limits: { receipts: 1, sliceRows: 1 } })).toBe("bounded");
  writeFileSync(join(DATA_DIR, `${MEMORY_REPAIRS_FILE}.selfheal.tmp`), "{\"selfheal1021\":");
  closeDatabase();
  expect(flagged()).toBe(false);
  const log: string[] = [];
  expect(await startSelfHeal1021(database(), DATA_DIR, { ...quiet, log: l => log.push(l) })).toBe("healed");
  expect(cites("r")).toEqual([{ id: cited[0]!.id, version: 2 }]);
  expect(flagged()).toBe(true);
});

it("H6 the bound is on rows examined, not rows matched: a sparse receipt history is walked in bounded slices, never one long statement", async () => {
  seed(lines.join("\n"));
  const cited = chunks();
  reimport([...lines, line(600)].join("\n"));
  // 300 receipts none of which is stuck (they cite the active versions), then one that is (it cites a superseded unchanged version)
  const active = chunks();
  tx(() => { for (let i = 0; i < 300; i++) receipt(`live${i}`, "thread-b", [active[i % 10]!]); });
  receipt("stuck", "thread-a", [cited[12]!]);
  let slices = 0;
  expect(await startSelfHeal1021(database(), DATA_DIR, { ...quiet, limits: { receipts: 100, sliceRows: 10 }, onSlice: () => { slices++; } })).toBe("bounded");
  expect(slices).toBeLessThanOrEqual(11);
  expect(cites("stuck")[0].version).toBe(1);
  // the next starts carry on from where it stopped and reach the stuck receipt
  for (let start = 0; start < 4 && !flagged(); start++) await startSelfHeal1021(database(), DATA_DIR, { ...quiet, limits: { receipts: 100, sliceRows: 10 } });
  expect(cites("stuck")).toEqual([{ id: cited[12]!.id, version: 2 }]);
});

/** The notebook with its last chunk cut off (chunks are fixed 2048-byte windows, chunks.ts, so every earlier chunk keeps its words). */
function withoutLastChunk(text: string) {
  const last = chunks().at(-1)!;
  const start = Number((database().prepare("SELECT start_byte AS b FROM memory_evidence WHERE record_id=? AND record_version=?").get(last.id, last.version) as { b: number }).b);
  return text.slice(0, start);
}
const history = (id: string) => database().prepare("SELECT version,state,text FROM memory_records WHERE id=? ORDER BY version").all(id) as Array<{ version: number; state: string; text: string }>;

it("R3 removal gap: a chunk the notebook dropped at one revision and got back with the same words later is not re-pointed across the removal", async () => {
  const full = lines.join("\n");
  seed(full);
  const cited = chunks(), gap = cited.at(-1)!, kept = cited[0]!;
  receipt("gap", "thread-a", [gap]);
  receipt("kept", "thread-b", [kept]);
  reimport(withoutLastChunk(full));
  reimport(full);
  // the shape 1.0.20 leaves: the dropped chunk has versions 1 and 3 with the same words and no version 2; the kept one has 1, 2, 3
  expect(history(gap.id).map(h => [h.version, h.state])).toEqual([[1, "superseded"], [3, "active"]]);
  expect(history(gap.id)[1]!.text).toBe(history(gap.id)[0]!.text);
  expect(history(kept.id).map(h => h.version)).toEqual([1, 2, 3]);
  expect(receiptState("gap")).toBe("delivered");
  // nothing else withholds it: no deny mark on the chunk (the removing re-import's ends are left to the durable job, as in the field)
  expect(database().prepare("SELECT 1 FROM memory_deny_memory WHERE kind='record' AND id=?").all(gap.id)).toEqual([]);
  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  // the heal ran (the contiguous chunk moved) but the receipt on the removed chunk stays where 1.0.20 left it
  expect(cites("kept")).toEqual([{ id: kept.id, version: 3 }]);
  expect(cites("gap")).toEqual([{ id: gap.id, version: 1 }]);
});

it("R3 removal gap: a queued revoke of the dropped chunk's old version is not undone across the removal", async () => {
  const full = lines.join("\n");
  seed(full);
  const cited = chunks(), gap = cited.at(-1)!, kept = cited[0]!;
  reimport(withoutLastChunk(full));
  reimport(full);
  expect(history(gap.id).map(h => h.version)).toEqual([1, 3]);
  const gapRevoke = oldRevoke(gap.id, 1), keptRevoke = oldRevoke(kept.id, 1);
  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  // the contiguous chunk's no-op revoke is undone; the dropped chunk's stays for the paced runner
  expect(jobState(keptRevoke)).not.toBe("active");
  expect(jobState(gapRevoke)).toBe("active");
});

/** A retained session of the proof fixture's reader whose notebook was imported for real (import.ts), and its recall of one chunk version:
 * the bundle, receipt and session binding production writes (bundle.ts, disclosures.ts). */
async function retainedNotebookSession() {
  const f = setupProofFixture("direct"), p = await proofModule();
  const ticket = ownerMemoryTicket();
  notebook = join(ensureWorkspace("reader"), "MEMORY.md");
  writeFileSync(notebook, lines.join("\n"));
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "reader" }], f.roster).previewId, f.roster, true);
  await proofReceipts(f, 1);
  const access = f.issue();
  const recall = async (ref: { id: string; version: number }) => {
    const bundle = await buildMemoryBundle("durable owner context", access, { async search() { return { hits: [{ ...ref, score: 1, lexical: true }], vectorRows: 0 }; } }, { allowance: LineageAllowance.tool() });
    expect(bundle.recordVersions).toContainEqual(ref);
    prepareMemoryDisclosure(bundle, access, f.key.driverInstance);
    bindMemoryDisclosureSession(bundle.bundleId, f.key.nativeSession);
    deliverMemoryDisclosure(bundle.bundleId, access);
    return bundle.bundleId;
  };
  const prove = () => p.proveRetainedSession(LineageAllowance.tool(), f.key, { access, disclosed: true });
  return { f, recall, prove };
}

it("H3 end to end, a session judged before the re-import: import, heal, resume replays fresh and the receipt ends as 1.0.20 ended it", async () => {
  const { f, recall, prove } = await retainedNotebookSession();
  // the notebook's last chunk (831 bytes: a full 2048-byte window is over the bundle's recall share), unchanged by the re-import below
  const c0 = chunks().at(-1);
  const held = await recall(c0!);
  // the session's checkpoint judged the receipt (its cite of chunk 0 v1 recorded)
  expect(prove()).toEqual({ kind: "resume" });
  reimport(revised([0]), f.roster);
  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  expect(cites(held)).toEqual([{ id: c0!.id, version: 2 }]);
  // the change log holds the re-import's record change before the heal's receipt entry: the proof meets the cited record first
  // (session-proof.ts:236-243), ends the receipt and replays fresh. Never a resume over the rewrite.
  const log = (database().prepare("SELECT id FROM memory_session_change_log WHERE id IN (?,?) ORDER BY seq").all(`record:${c0!.id}`, `receipt:${held}`) as Array<{ id: string }>).map(r => r.id);
  expect(log.indexOf(`record:${c0!.id}`)).toBeGreaterThanOrEqual(0);
  expect(log.indexOf(`record:${c0!.id}`)).toBeLessThan(log.lastIndexOf(`receipt:${held}`));
  expect(prove()).toEqual({ kind: "fresh", reason: "changed:record", cause: "denied" });
  expect(receiptState(held)).toBe("revoked");
});

it("H3 end to end, a receipt the session had not judged yet: import, heal, resume replays fresh on the heal's own log entry", async () => {
  const { f, recall, prove } = await retainedNotebookSession();
  const c1 = chunks().at(-1);
  expect(prove()).toEqual({ kind: "resume" });
  // delivered after the checkpoint: the re-import's change to its chunk is logged with no cite of this session naming it
  const late = await recall(c1!);
  reimport(revised([0]), f.roster);
  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  expect(cites(late)).toEqual([{ id: c1!.id, version: 2 }]);
  // the rewritten receipt is judged only through the heal's receipt entry (selfheal-1021.ts logReceiptRewrite): it replays fresh, the
  // repaired receipt itself is left delivered
  expect(prove()).toEqual({ kind: "fresh", reason: "changed:receipt", cause: "denied" });
  expect(receiptState(late)).toBe("delivered");
});

const repairsFile = () => join(DATA_DIR, MEMORY_REPAIRS_FILE);
/** Every name the repairs left in the data folder (the note, its side file, temps): each must be one a backup classifies. */
const unclassifiedRepairNames = () => readdirSync(DATA_DIR).filter(name => name.startsWith("memory-repairs") && !classifyDataDirEntry(name));

it("H4 an unreadable memory-repairs.json: the cursors go to the side file, a restart carries on and the pass ends; the file is never rewritten", async () => {
  seed(lines.join("\n"));
  const cited = chunks();
  for (let i = 0; i < 6; i++) receipt(`r${i}`, "thread-a", [cited[i]!]);
  reimport([...lines, line(600)].join("\n"));
  // another repair's note, cut off mid-write: it cannot be read
  const damaged = "{\"keepallUnwedge103\":{\"installationId\":";
  writeFileSync(repairsFile(), damaged);
  const outcomes: string[] = [];
  for (let start = 0; start < 8 && outcomes.at(-1) !== "healed"; start++) {
    outcomes.push(await startSelfHeal1021(database(), DATA_DIR, { ...quiet, limits: { receipts: 2, sliceRows: 1 } }));
    closeDatabase(); // a restart between starts: nothing carried in memory
  }
  expect(outcomes[0]).toBe("bounded");
  expect(outcomes.at(-1)).toBe("healed");
  for (let i = 0; i < 6; i++) expect(cites(`r${i}`)).toEqual([{ id: cited[i]!.id, version: 2 }]);
  expect(readFileSync(repairsFile(), "utf8")).toBe(damaged);
  expect(JSON.parse(readFileSync(join(DATA_DIR, SELFHEAL_SIDE_FILE), "utf8"))[SELFHEAL_1021]?.done).toBe(true);
  expect(selfHealed1021(database(), DATA_DIR)).toBe(true);
  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("already");
  expect(unclassifiedRepairNames()).toEqual([]);
});

it("H4 an unreadable memory-repairs.json, bounded runs in one process: each run carries on from the last, never from zero", async () => {
  seed(lines.join("\n"));
  const cited = chunks();
  for (let i = 0; i < 6; i++) receipt(`r${i}`, "thread-a", [cited[i]!]);
  reimport([...lines, line(600)].join("\n"));
  writeFileSync(repairsFile(), "not json");
  let slices = 0;
  // a pass that restarted from zero each run would rescan the same two receipts until the slice budget ran out ("stopped")
  const outcome = await startSelfHeal1021(database(), DATA_DIR, { ...quiet, limits: { receipts: 2, sliceRows: 1 }, restMs: 0, yieldSlice: async () => ++slices < 200 });
  expect(outcome).toBe("healed");
  for (let i = 0; i < 6; i++) expect(cites(`r${i}`)).toEqual([{ id: cited[i]!.id, version: 2 }]);
  expect(readFileSync(repairsFile(), "utf8")).toBe("not json");
});

it("H4 a start stopped inside the note's rename: the note keeps its last whole state, the leftover temp is classified, the next start carries on", async () => {
  seed(lines.join("\n"));
  const cited = chunks();
  receipt("r", "thread-a", [cited[0]!]);
  receipt("r2", "thread-a", [cited[1]!]);
  reimport([...lines, line(600)].join("\n"));
  writeFileSync(repairsFile(), JSON.stringify({ keepallUnwedge103: { installationId: "other-repair-note" } }));
  expect(await startSelfHeal1021(database(), DATA_DIR, { ...quiet, limits: { receipts: 1, sliceRows: 1 } })).toBe("bounded");
  const kept = readFileSync(repairsFile(), "utf8");
  expect(JSON.parse(kept)[SELFHEAL_1021]?.receipts).toBeGreaterThan(0);
  // the next start's slice commits, its note's temp is written, and the process is gone at writeState's rename: nothing after it runs
  const renames: string[] = [];
  fsHook.rename = (from, to) => { if (to === repairsFile()) { renames.push(from); throw Object.assign(new Error("process gone"), { code: "EINTR" }); } };
  expect(await startSelfHeal1021(database(), DATA_DIR, { ...quiet, limits: { receipts: 1, sliceRows: 1 } })).toBe("gave-up");
  fsHook.rename = null;
  expect(renames.length).toBeGreaterThan(0);
  expect(existsSync(renames[0]!)).toBe(true);
  // the note is the last whole one (the other repair's flag with it), never a partial write; the temp left beside it stops no backup
  expect(readFileSync(repairsFile(), "utf8")).toBe(kept);
  expect(unclassifiedRepairNames()).toEqual([]);
  closeDatabase();
  expect(await startSelfHeal1021(database(), DATA_DIR, quiet)).toBe("healed");
  expect(cites("r")).toEqual([{ id: cited[0]!.id, version: 2 }]);
  expect(cites("r2")).toEqual([{ id: cited[1]!.id, version: 2 }]);
  expect(flagged()).toBe(true);
  expect(JSON.parse(readFileSync(repairsFile(), "utf8")).keepallUnwedge103).toEqual({ installationId: "other-repair-note" });
});
