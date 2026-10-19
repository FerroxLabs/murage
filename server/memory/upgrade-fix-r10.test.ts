// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fix round for the RC1 chat diagnosis (perfdiag/RC1-CHAT.md row 3b) and the two upgui items that went with it: the message walker keeps to its
// slice's time and carries its cursor across slices, every background job slice is a named holder for the stall line, the status reading says
// whether earlier memory is being checked in the background, and an output index found broken is rewritten in slices, never in one transaction.
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, memoryIntegrityStatus } from "../database.ts";
import { walkMessagesChunk } from "../message-walker.ts";
import { prioritizeThread, readIndexState } from "../transcript-backfill.ts";
import { activeTaskName } from "../observe.ts";
import { runBackgroundUpgradeWorkToEnd, upgradeOutside } from "./upgrade-background.ts";
import { stepIntegrityPass, REWRITE_PAGE_MAX } from "./integrity-pass.ts";
import { beginIntegrityPass, integrityHoldOf, readIntegrityPass } from "./integrity-state.ts";
import { memoryGate } from "./memory-gate.ts";
import { setMemoryCheckingSource } from "./integrity-flags.ts";
import { rootSetProofsPending } from "./replay-lineage.ts";
import { outputIndexDiffers, rebuildOutputIndexSlice } from "./schema.ts";
import { CONTRACT_KEYS, UPGRADE_CONTRACT_SOURCE, buildUpgradeState, parseUpgradeState, sampleState, unknownUpgradeState } from "../../shared/upgrade-contract.mjs";
import { removeTempDirSync } from "../testing/cleanup.ts";

const fresh = () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); };
beforeEach(fresh);
afterEach(() => { setMemoryCheckingSource(() => rootSetProofsPending()); });

function thread(db: DatabaseSync, id: string, rows: number, cardAt: number[]) {
  const put = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 1; i <= rows; i++) {
    const card = cardAt.includes(i);
    const message = { id: `${id}-${i}`, at: i, role: "bot", kind: card ? "options" : "text", text: "t", turnId: `${id}-turn-${Math.ceil(i / 10)}`, ...(card ? { card: { requestId: `req-${i}`, options: [] } } : {}) };
    put.run(id, message.id, i, "bot", message.kind, "t", JSON.stringify(message));
  }
  db.exec("COMMIT");
}
const unfinishedIndexes = (db: DatabaseSync) => db.exec("DELETE FROM open_card; DELETE FROM browser_check_pending; DELETE FROM turn_first; DELETE FROM transcript_index_state WHERE name IN ('open_card','browser_check','turn_first','walk_rows')");

// ── 1. the walker keeps to its slice ───────────────────────────────────────────────────────────────────────────────────────────
it("r10 #1: with a simulated 1 ms a row, no walker window runs past 50 ms plus one row, and the cursor only ever moves forward", () => {
  const db = database();
  thread(db, "w", 1_200, [7, 1_100]);
  unfinishedIndexes(db);
  let clock = 0;
  const spans: number[] = [], cursors: number[] = [];
  for (let guard = 0; guard < 2_000; guard++) {
    const began = clock;
    const step = walkMessagesChunk(db, { rows: 2_000, deadline: began + 50, now: () => clock, onRow: () => { clock += 1; } });
    spans.push(clock - began);
    cursors.push(readIndexState(db, "open_card").cursor);
    if (!step.more) break;
  }
  expect(Math.max(...spans)).toBeLessThanOrEqual(51);
  expect(spans.length).toBeGreaterThanOrEqual(24); // 1,200 rows at 50 a window, never 2,000 at once
  for (let i = 1; i < cursors.length; i++) expect(cursors[i]!).toBeGreaterThan(cursors[i - 1]!);
  for (const name of ["open_card", "browser_check", "turn_first"]) expect(readIndexState(db, name).done).toBe(1);
  expect(db.prepare("SELECT id FROM open_card ORDER BY id").all().map(row => String(row.id))).toEqual(["w-1100", "w-7"]);
  expect(Number(db.prepare("SELECT count(*) AS n FROM turn_first").get()!.n)).toBe(120);
  expect(readIndexState(db, "walk_rows").cursor).toBe(1_200); // every row walked once, none twice
});

it("r10 #1: through the background queue (a prepared thread first), every message-index slice keeps to 50 ms plus one row, carries its cursor, and is named while it runs", () => {
  const db = database();
  thread(db, "a", 900, [5]);
  thread(db, "b", 900, [800]);
  unfinishedIndexes(db);
  prioritizeThread(db, "b");
  let clock = 0, began = 0;
  const spans: number[] = [], cursors: number[] = [], names = new Set<string | undefined>(), integrityNames = new Set<string | undefined>();
  runBackgroundUpgradeWorkToEnd(db, {
    sliceMs: 50, now: () => clock,
    walkRow: () => { clock += 1; names.add(activeTaskName()); },
    onIntegrity: () => { integrityNames.add(activeTaskName()); },
    afterSlice: job => { if (job === "message-index") { spans.push(clock - began); cursors.push(readIndexState(db, "turn_first").cursor); } began = clock; },
  });
  expect(spans.length).toBeGreaterThanOrEqual(36); // 1,800 rows at 50 a slice
  expect(Math.max(...spans)).toBeLessThanOrEqual(51);
  for (let i = 1; i < cursors.length; i++) expect(cursors[i]!).toBeGreaterThanOrEqual(cursors[i - 1]!);
  expect(new Set(cursors).size).toBeGreaterThanOrEqual(36); // it moved on every walking slice and never went back to the start
  expect(names).toEqual(new Set(["upgrade.message-index.walk"]));
  expect(activeTaskName()).toBeUndefined(); // every name is put back when its step ends
  expect(db.prepare("SELECT id FROM open_card ORDER BY id").all().map(row => String(row.id))).toEqual(["a-5", "b-800"]);
  // the integrity job's slice is named too (its hook runs inside the slice)
  fresh();
  const db2 = database();
  db2.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('b1','t1','d','[]','[]','[\"m1\"]',0,0,0,'delivered',1)").run();
  beginIntegrityPass(db2);
  runBackgroundUpgradeWorkToEnd(db2, { onIntegrity: () => { integrityNames.add(activeTaskName()); } });
  expect(integrityNames).toEqual(new Set(["upgrade.integrity"]));
});

// ── 2. the "checking" field ────────────────────────────────────────────────────────────────────────────────────────────────────
it("r10 #2: the checking field is part of the contract, round-trips through every parser, and the server says it while a large set's proof waits", () => {
  expect(CONTRACT_KEYS).toContain("checking");
  for (const checking of [true, false, "unknown"] as const) {
    const state = sampleState({ checking });
    const parsed = parseUpgradeState(JSON.parse(JSON.stringify(state)));
    expect(parsed).toMatchObject({ ok: true, state: { checking } });
    // the worker threads' copy of the kit (made from the same source text) reads it the same way
    const kit = new Function(`${UPGRADE_CONTRACT_SOURCE}; return { parseUpgradeState, buildUpgradeState };`)() as { parseUpgradeState: typeof parseUpgradeState; buildUpgradeState: typeof buildUpgradeState };
    expect(kit.parseUpgradeState(JSON.parse(JSON.stringify(state)))).toEqual(parsed);
  }
  const missing: Record<string, unknown> = { ...sampleState() };
  delete missing.checking;
  expect(parseUpgradeState(missing)).toEqual({ ok: false, reason: "missing:checking" });
  expect(parseUpgradeState({ ...sampleState(), checking: "yes" })).toEqual({ ok: false, reason: "checking" });
  expect(() => buildUpgradeState({ ...sampleState(), checking: 1 })).toThrow(/checking/);
  expect(unknownUpgradeState().checking).toBe("unknown");

  const db = database();
  setMemoryCheckingSource(() => 2);
  expect(upgradeOutside(db).checking).toBe(true);
  expect(memoryIntegrityStatus().upgrade.checking).toBe(true);
  setMemoryCheckingSource(() => 0);
  expect(memoryIntegrityStatus().upgrade.checking).toBe(false);
  setMemoryCheckingSource(() => { throw new Error("unreadable"); });
  expect(memoryIntegrityStatus().upgrade.checking).toBe("unknown");
  // the real source is the replay's own count of proofs waiting
  setMemoryCheckingSource(() => rootSetProofsPending());
  expect(memoryIntegrityStatus().upgrade.checking).toBe(rootSetProofsPending() > 0);
});

// ── 3. a broken index is rewritten in slices ───────────────────────────────────────────────────────────────────────────────────
const RECEIPT = "INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'t1','d','[]','[]',?,0,0,0,'delivered',1)";
const reply = (i: number) => `reply-${String(i).padStart(7, "0")}`;

it("r10 #3: a receipt of 200,000 members whose index is broken is rewritten across slices, no slice runs past its 50 ms, readers stay fail-closed, and a restart finishes what is left", { timeout: 600_000 }, () => {
  const n = 200_000, perRow = 0.02;
  let db = database();
  db.exec("BEGIN");
  db.prepare(RECEIPT).run("b-long", JSON.stringify(Array.from({ length: n }, (_, i) => reply(i))));
  db.prepare(RECEIPT).run("a-short", '["s1","s2"]');
  db.exec("COMMIT");
  db.exec("BEGIN"); rebuildOutputIndexSlice(db, { lo: null, hi: null }); db.exec("COMMIT");
  // broken three ways: 100 rows gone, 50 rows the receipt does not name, one row under another thread
  db.exec("BEGIN");
  for (let i = 0; i < 100; i++) db.prepare("DELETE FROM memory_disclosure_outputs WHERE bundle_id='b-long' AND message_id=?").run(reply(i * 1_999 + 7));
  for (let i = 0; i < 50; i++) db.prepare("INSERT INTO memory_disclosure_outputs(bundle_id,thread_id,message_id) VALUES('b-long','t1',?)").run(`zz-not-named-${i}`);
  db.prepare("UPDATE memory_disclosure_outputs SET thread_id='t-other' WHERE bundle_id='b-long' AND message_id=?").run(reply(123_456));
  db.exec("COMMIT");
  beginIntegrityPass(db);
  closeDatabase(); db = database(); // the open reads the pass row: readers are held from the first moment

  let clock = 0, rewritten = 0, pageMax = 0, restarted = false, rewriteSlices = 0;
  const spans: number[] = [];
  const options = { budgetMs: 50, now: () => clock, onRewriteRows: (rows: number) => { clock += rows * perRow; rewritten += rows; pageMax = Math.max(pageMax, rows); } };
  for (let guard = 0; guard < 20_000 && readIntegrityPass(db)!.phase === "output-index" && readIntegrityPass(db)!.finishedAt === null; guard++) {
    const began = clock, before = rewritten;
    stepIntegrityPass(db, options);
    spans.push(clock - began);
    if (rewritten > before) rewriteSlices++;
    expect(memoryGate(db, "replay")).toBe("pending"); // fail-closed while the rewrite is under way
    // stop the server once the rewrite is past its first half (the rows the receipt does not name are gone; the missing ones are going back)
    if (!restarted && rewritten > n + 1_000) {
      restarted = true;
      closeDatabase(); db = database();
      expect(memoryGate(db, "replay")).toBe("pending"); // and after the restart, before anything has been proven again
    }
  }
  const row = readIntegrityPass(db)!;
  expect(integrityHoldOf(row)).toBeNull();
  expect(restarted).toBe(true);
  expect(Math.max(...spans)).toBeLessThanOrEqual(50);
  expect(rewriteSlices).toBeGreaterThan(50); // spread over many slices, never one transaction
  expect(pageMax).toBeLessThanOrEqual(REWRITE_PAGE_MAX);
  // the index now equals the receipt's list exactly
  expect(outputIndexDiffers(db, { lo: null, hi: null })).toBe(false);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_disclosure_outputs WHERE bundle_id='b-long'").get()!.n)).toBe(n);
  expect(db.prepare("SELECT 1 FROM memory_disclosure_outputs WHERE message_id LIKE 'zz-not-named-%'").get()).toBeUndefined();
  expect(db.prepare("SELECT thread_id FROM memory_disclosure_outputs WHERE bundle_id='b-long' AND message_id=?").get(reply(123_456))).toEqual({ thread_id: "t1" });
  // the run after the restart did only what was left: the 51 rows removed before it were not counted again
  expect(row.repaired).toBeGreaterThan(0);
  expect(row.repaired).toBeLessThanOrEqual(101);
  console.log(`R10-REWRITE slices=${spans.length} rewrite_slices=${rewriteSlices} max_virtual_ms=${Math.max(...spans).toFixed(2)} page_max=${pageMax} repaired=${row.repaired}`);
});

it("r10 #3: a slice of ordinary receipts whose index differs is rewritten a few receipts at a time, each its own transaction, and proven again", () => {
  const db = database();
  db.exec("BEGIN");
  for (let r = 0; r < 40; r++) db.prepare(RECEIPT).run(`b-${String(r).padStart(3, "0")}`, JSON.stringify(Array.from({ length: 500 }, (_, i) => `m-${r}-${i}`)));
  db.exec("COMMIT");
  db.exec("BEGIN"); rebuildOutputIndexSlice(db, { lo: null, hi: null }); db.exec("COMMIT");
  for (const r of [3, 17, 38]) db.prepare("DELETE FROM memory_disclosure_outputs WHERE bundle_id=? AND message_id=?").run(`b-${String(r).padStart(3, "0")}`, `m-${r}-9`);
  db.prepare("INSERT INTO memory_disclosure_outputs(bundle_id,thread_id,message_id) VALUES('b-020','t1','not-named')").run();
  beginIntegrityPass(db);
  const transactions: number[] = [];
  const realExec = db.exec.bind(db);
  (db as unknown as { exec: (sql: string) => void }).exec = (sql: string) => { if (sql === "BEGIN IMMEDIATE") transactions.push(1); realExec(sql); };
  let calls = 0;
  try {
    for (; calls < 1_000 && readIntegrityPass(db)!.phase === "output-index" && readIntegrityPass(db)!.finishedAt === null; calls++) stepIntegrityPass(db, { budgetMs: 0, receiptSlice: 40 });
  } finally { (db as unknown as { exec: unknown }).exec = realExec; }
  expect(integrityHoldOf(readIntegrityPass(db))).toBeNull();
  expect(transactions.length).toBeGreaterThanOrEqual(40); // one receipt a step at a budget of nothing: forty steps, not one
  expect(calls).toBeGreaterThan(40);
  expect(outputIndexDiffers(db, { lo: null, hi: null })).toBe(false);
  expect(readIntegrityPass(db)!.repaired).toBeGreaterThan(0);
});
