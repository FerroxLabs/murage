// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The 1.0.4 number scrub of earlier memory (PASTE-CAPTURE-FIX r2.5 to r2.11, D1 to D8). The fixture is a file as 1.0.3 left it: sources,
// chunks, a fact, a checkpoint, entities and a correction holding bank, card, account and id numbers, with the content hashes 1.0.3 wrote,
// and no scrub row.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { DatabaseBusyError } from "../db-busy.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { beginIntegrityPass, writeIntegrityPass } from "./integrity-state.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { SCRUB_PASS_TABLE, readScrubPass, scrubPassPending, setScrubLogClearer, setScrubRewriteFinisher, stepScrubPass, type ScrubStep } from "./scrub-pass.ts";
import type { MemorySearchBridge } from "./search.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { backgroundJobsPending } from "./upgrade-background.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

// the main file's log is cleared by the server's checkpointer, the way a deletion's is (wal-maintenance.test.ts: no TRUNCATE on the server thread)
const clearLog = vi.fn(async () => true);

const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] };
const keywordOnly: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0, degradedReason: "keyword-only" }) };
beforeEach(() => { clearLog.mockClear(); setScrubLogClearer(clearLog); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); setScrubRewriteFinisher(null); });
afterEach(() => { setScrubRewriteFinisher(null); setScrubLogClearer(null); });

const RAW = [
  "Bank: Frost Bank, deposits go to the account ending 4471, routing 021000021.", // secret-scan: fixture
  "Card 4111 1111 1111 1111 for travel, SSN 123-45-6789, iban de89 3704 0044 0532 0130 00.", // secret-scan: fixture
].join("\n");
const DIGITS = /4471|021000021|4111|6789|3704/;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const captureHash = (payload: Record<string, unknown>) => { const content = { ...payload }; delete content.origin; delete content.engine; delete content.actionCheck; return sha(JSON.stringify(content)); };

function access() {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(), generation = registry.begin("bot", "thread");
  const token = registry.mint({ botId: "bot", threadId: "thread", generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}

/** A file as 1.0.3 left it: every cell holds the digits, the hashes are of the raw content, and there is no scrub row. */
function legacyFile(extraText?: string) {
  const db = database();
  captureSource(db, { id: "legacy", threadId: "thread", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: RAW });
  let job = "";
  for (let work = claimMemoryJob("fixture"); work; work = claimMemoryJob("fixture")) { job = work.id; publishMemoryWork(work, "fixture", captureWork(work)); }
  refreshMemoryCheckpoint(job);
  if (extraText !== undefined) captureSource(db, { id: "big", threadId: "thread", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: extraText });
  // back to the raw words (the same byte length), and the hash 1.0.3 wrote beside them
  for (const row of db.prepare("SELECT rowid AS rid,source_id,payload FROM memory_source_versions").all()) {
    const payload = JSON.parse(String(row.payload)); payload.text = row.source_id === "legacy" ? RAW : extraText;
    const hash = captureHash(payload);
    db.prepare("UPDATE memory_source_versions SET payload=?,content_hash=? WHERE rowid=?").run(JSON.stringify(payload), hash, Number(row.rid));
    db.prepare("UPDATE memory_sources SET content_hash=? WHERE id=?").run(hash, String(row.source_id));
  }
  db.prepare("UPDATE memory_records SET text=? WHERE kind='source'").run(RAW);
  db.prepare("UPDATE memory_records SET text=? WHERE kind='checkpoint'").run(`Earlier in this chat:\n${RAW}`);
  db.prepare("INSERT INTO memory_records VALUES('fact',1,(SELECT scope_id FROM memory_records LIMIT 1),'fact','Pays rent from the account ending 4471','owner-statement','active',0,1,NULL,NULL,1)").run(); // secret-scan: fixture
  db.prepare("INSERT INTO memory_projection_receipts VALUES('fact',1,0,'indexed','indexed',NULL)").run();
  db.prepare("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='indexed'").run();
  db.prepare("UPDATE memory_record_details SET entities=json_array('Frost Bank','account ending 4471') WHERE record_id='fact'").run();
  db.prepare(`DELETE FROM ${SCRUB_PASS_TABLE}`).run();
  return db;
}

/** Slices until `stop`, settle (which waits on the projection worker: see settle below) or the end. */
function runUntil(db: DatabaseSync, stop: (step: ScrubStep) => boolean, options: { rows?: number } = {}): ScrubStep {
  for (let n = 0; n < 10_000; n++) { const step = stepScrubPass(db, { budgetMs: 1_000, ...options }); if (stop(step) || step.phase === "settle" || !step.more) return step; }
  throw new Error("the scrub did not end");
}
/** The rest of the pass with the helper standing in for the projection worker: receipts drained, the rewrite finished. */
async function settle(db: DatabaseSync) {
  db.prepare("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='indexed' WHERE lexical_status IN ('pending','pending-archive')").run();
  let asked = 0;
  setScrubRewriteFinisher(async () => { asked++; return true; });
  for (let n = 0; n < 20; n++) { const step = stepScrubPass(db); if (!step.more) return asked; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error("settle did not end");
}
const cells = (db: DatabaseSync) => [
  ...db.prepare("SELECT payload FROM memory_source_versions").all().map(row => String(JSON.parse(String(row.payload)).text)),
  ...db.prepare("SELECT text FROM memory_records").all().map(row => String(row.text)),
  ...db.prepare("SELECT entities FROM memory_record_details").all().map(row => String(row.entities)),
];

it("a new file owes no scrub; a file 1.0.3 left owes it, as a background job after the proofs", () => {
  const db = database();
  expect(scrubPassPending(db)).toBe(false);
  expect(backgroundJobsPending(db)).not.toContain("scrub");
  legacyFile();
  expect(scrubPassPending(db)).toBe(true);
  expect(backgroundJobsPending(db)).toContain("scrub");
});

it("D1: runs to done: every cell masked at its byte length, hashes of the masked content, receipts owed, quotes masked, no journal", async () => {
  const db = legacyFile();
  const before = cells(db);
  expect(before.some(text => DIGITS.test(text))).toBe(true);
  const oldHash = String(db.prepare("SELECT content_hash FROM memory_source_versions WHERE source_id='legacy'").get()!.content_hash);
  runUntil(db, step => step.phase === "settle");
  const after = cells(db);
  for (const text of after) expect(text).not.toMatch(DIGITS);
  expect(after.map(text => Buffer.byteLength(text))).toEqual(before.map(text => Buffer.byteLength(text)));
  expect(after.join("\n")).toContain("account ending ****");
  expect(after.join("\n")).toContain("de** **** **** **** **** **");
  // Grok r2 H5: the hash beside the masked payload is the hash of the masked content, on the version and on its source
  const version = db.prepare("SELECT content_hash,payload FROM memory_source_versions WHERE source_id='legacy'").get()!;
  expect(version.content_hash).not.toBe(oldHash);
  expect(version.content_hash).toBe(captureHash(JSON.parse(String(version.payload))));
  expect(db.prepare("SELECT content_hash FROM memory_sources WHERE id='legacy'").get()!.content_hash).toBe(version.content_hash);
  // every changed record owes its projection again
  expect(db.prepare("SELECT lexical_status FROM memory_projection_receipts WHERE record_id='fact'").get()!.lexical_status).toBe("pending");
  const ticket = ownerMemoryTicket();
  const source = db.prepare("SELECT id,version FROM memory_records WHERE kind='source'").get()!;
  const inspected = await memoryOwnerRoute("/api/memory/action", { action: "inspect", id: String(source.id), version: Number(source.version) }, ticket, roster) as { evidence: Array<{ text: string }> };
  expect(inspected.evidence.length).toBeGreaterThan(0);
  for (const quote of inspected.evidence) { expect(quote.text).not.toMatch(DIGITS); expect(quote.text.length).toBeGreaterThan(0); }
  expect(await settle(db)).toBe(1);
  expect(readScrubPass(db)).toMatchObject({ phase: "done" });
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name LIKE '%scrub_journal%'").get()).toBeUndefined();
  // the main file's log is cleared at the end (r2.6), by the checkpointer, once
  expect(clearLog).toHaveBeenCalledTimes(1);
});

it("D2: a second run changes nothing", async () => {
  const db = legacyFile();
  runUntil(db, () => false); await settle(db);
  const once = cells(db);
  db.prepare(`UPDATE ${SCRUB_PASS_TABLE} SET rule_version=0`).run();
  expect(scrubPassPending(db)).toBe(true);
  runUntil(db, step => step.phase === "settle");
  expect(readScrubPass(db)).toMatchObject({ changed: 0, phase: "settle" });
  expect(cells(db)).toEqual(once);
  // nothing changed: settle has nothing to finish
  expect(stepScrubPass(db)).toMatchObject({ more: false, phase: "done" });
});

it("D3: stopped after the second slice and opened again, it ends in the same state", async () => {
  const straight = legacyFile();
  runUntil(straight, () => false); await settle(straight);
  const expected = cells(straight);
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster);
  const db = legacyFile();
  stepScrubPass(db, { rows: 1 }); stepScrubPass(db, { rows: 1 });
  const between = readScrubPass(db)!;
  expect(["versions", "records"]).toContain(between.phase);
  expect(between.changed).toBeGreaterThan(0);
  closeDatabase();
  const reopened = database();
  expect(readScrubPass(reopened)).toMatchObject({ phase: between.phase, cursor: between.cursor });
  runUntil(reopened, () => false, { rows: 1 }); await settle(reopened);
  expect(cells(reopened)).toEqual(expected);
});

it("D4: a busy file: the slice says so, nothing changes, and the pass completes later", async () => {
  const db = legacyFile();
  const before = cells(db);
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  other.exec("BEGIN IMMEDIATE");
  try { expect(() => stepScrubPass(db)).toThrow(DatabaseBusyError); }
  finally { other.exec("ROLLBACK"); other.close(); }
  expect(cells(db)).toEqual(before);
  runUntil(db, () => false); await settle(db);
  for (const text of cells(db)) expect(text).not.toMatch(DIGITS);
});

it("D5: before the scrub reaches a row the engine's bundle reads it masked", async () => {
  legacyFile();
  const bundle = await buildMemoryBundle("Frost Bank deposits rent", access(), keywordOnly, { allowance: LineageAllowance.tool() });
  expect(bundle.text).not.toMatch(DIGITS);
});

it("D6: a newer rule version runs the pass again", async () => {
  const db = legacyFile();
  runUntil(db, () => false); await settle(db);
  expect(scrubPassPending(db)).toBe(false);
  db.prepare(`UPDATE ${SCRUB_PASS_TABLE} SET rule_version=rule_version-1`).run();
  expect(scrubPassPending(db)).toBe(true);
  expect(stepScrubPass(db)).toMatchObject({ more: true, phase: "versions" });
});

it("D7: a row written after the walk passed its place is masked, and the phase ends only on a slice that reads none", async () => {
  const db = legacyFile();
  runUntil(db, step => step.phase === "records");
  stepScrubPass(db, { rows: 1 });
  // a raw row the way 1.0.3 code wrote it, after the walk's place: no snapshot, so the walk still reaches it
  db.prepare("INSERT INTO memory_records VALUES('late',1,(SELECT scope_id FROM memory_records LIMIT 1),'fact','Routing 021000021 for payroll','owner-statement','active',0,1,NULL,NULL,1)").run(); // secret-scan: fixture
  runUntil(db, () => false); await settle(db);
  expect(db.prepare("SELECT text FROM memory_records WHERE id='late'").get()!.text).toBe("Routing ********* for payroll");
});

it("D7 (integrity): nothing is rewritten while the integrity pass runs or holds", () => {
  const db = legacyFile();
  const before = cells(db);
  beginIntegrityPass(db);
  expect(stepScrubPass(db)).toMatchObject({ more: true, retryMs: expect.any(Number) });
  writeIntegrityPass(db, { phase: "done", finishedAt: Date.now(), result: "held:shape" });
  expect(stepScrubPass(db)).toMatchObject({ more: true, retryMs: expect.any(Number) });
  expect(cells(db)).toEqual(before);
});

it("D8: memory off, the scrub still runs; a large tool output is masked and keeps its length", async () => {
  // about 2 MiB of tool output, an account number on every line (r2.11 asks 32 MiB; the mask is linear and redact.test.ts times 1 MiB)
  const digits = "Tool output: account ending 4471.\n".repeat(60_000); // secret-scan: fixture
  const db = legacyFile(digits);
  db.prepare("UPDATE memory_meta SET mode='off' WHERE id=1").run();
  runUntil(db, () => false); await settle(db);
  const big = String(JSON.parse(String(db.prepare("SELECT payload FROM memory_source_versions WHERE source_id='big'").get()!.payload)).text);
  expect(Buffer.byteLength(big)).toBe(Buffer.byteLength(digits));
  for (const text of cells(db)) expect(text).not.toMatch(DIGITS);
});

it("D16: settle waits for the projection worker, then ends on its own after an hour", () => {
  const db = legacyFile();
  runUntil(db, step => step.phase === "settle");
  const start = readScrubPass(db)!.cursor;
  // receipts still pending and no helper: settle waits
  expect(stepScrubPass(db, { clock: () => start + 1_000 })).toMatchObject({ more: true, phase: "settle" });
  expect(stepScrubPass(db, { clock: () => start + 61 * 60_000 })).toMatchObject({ more: false, phase: "done" });
});
