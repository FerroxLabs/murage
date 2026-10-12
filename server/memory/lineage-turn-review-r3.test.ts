// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 review round 3 of the per-turn lineage work (Astra BLOCK on e07568163):
//   P1. distinct receipts that cite the same captured reply: the memo of "replies already proven sound" skipped the reply's ancestry
//       while the second receipt's dependencies were collected, so a kept proof of the second output lost them. Every within-check
//       memo now hands what it consulted to whoever reads it (JudgeMemo), and a hit contributes exactly what a miss would have;
//   P2. a proof that ran into the budget left its finished parts kept, and the next check, charged nothing for them, got further
//       and showed what the first one withheld. A kept proof is now charged what judging it costs, the first time a check reads it.
// Plus the class: warm equals cold over random sequences with shared captured replies, memo hits and misses, and tight budgets.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { chainStore } from "./schema.ts";
import { forgetKeptLineageForTest, keptVerdictCount, replayExclusions, setReplayNodeBudgetForTest, type ReplayAudience } from "./replay-lineage.ts";

const thread = "r3-direct";
const key = (message: string) => `${thread}\u0000${message}`;
const messageSource = (message: string) => `message:${thread}:${message}`;
function reset(): void { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); }
beforeEach(reset);
afterEach(() => setReplayNodeBudgetForTest(null));

function begin(): void {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
}
function addDoc(id: string): void {
  database().prepare("INSERT INTO memory_sources VALUES(?,?,NULL,NULL,NULL,1,'hash','text','owner','recorded',NULL,'active')").run(id, ensureScope("conversation", thread));
}
/** A reply captured as a source (a bot's words, kept as evidence). */
function addCaptured(message: string): void {
  database().prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:b','settled',NULL,'active')").run(messageSource(message), ensureScope("conversation", thread), thread, message);
}
function addReceipt(bundle: string, outputs: string[], sources: string[]): void {
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d','[]',?,?,0,0,0,'delivered',9)")
    .run(bundle, thread, JSON.stringify(sources.map(id => ({ id, revision: 1 }))), JSON.stringify(outputs));
}
/** The reply `out`, whose output roots are `roots` (one set). */
function addReply(out: string, roots: string[]): void {
  const db = database(), set = chainStore(db)(null, 0, roots.map(key));
  db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, out, set);
}
const never = () => false;
let readers = 0;
const reader = (revoked: (row: Record<string, unknown>) => boolean, cacheKey: string): ReplayAudience => ({ policyRevision: 0, deletionEpoch: 0, revoked, cacheKey });
const coldReader = (revoked: (row: Record<string, unknown>) => boolean = never) => reader(revoked, `cold-${readers++}`);
const shown = (window: string[], audience: ReplayAudience | null) => [...replayExclusions(thread, window.map(id => ({ id, role: "bot" })), audience, { failClosed: true })].sort();

// ---- P1 ---------------------------------------------------------------------------------------------------------------------------

/** Two receipts, each citing the captured reply X (made under a receipt that cites doc:anc); two replies whose output roots are the
 * receipts' outputs, the second's a subset of the first's, so the second receipt is first judged inside the first reply's proof. */
function sharedCapturedReply(): string[] {
  begin();
  for (const id of ["doc:anc", "doc:a", "doc:b"]) addDoc(id);
  addCaptured("X");
  addReceipt("rcX", ["X"], ["doc:anc"]);
  addReceipt("rcA", ["rootA"], [messageSource("X"), "doc:a"]);
  addReceipt("rcB", ["rootB"], [messageSource("X"), "doc:b"]);
  addReply("outA", ["rootA", "rootB"]); addReply("outB", ["rootB"]);
  return ["outA", "outB"];
}
for (const [name, audienceOf] of [["the owner's check", () => null], ["a reader's check", () => reader(never, "reader-p1")]] as const) {
  it(`P1: two receipts sharing a captured reply both fall with the reply's ancestry (${name}; warm equals cold)`, () => {
    const window = sharedCapturedReply();
    const audience = audienceOf();
    expect(shown(window, audience)).toEqual([]);
    expect(shown(window, audience)).toEqual([]);
    expect(keptVerdictCount()).toBeGreaterThan(0);
    // the ancestor's source is revised (still active): the reply X was made from the old words
    database().prepare("UPDATE memory_sources SET revision=2 WHERE id='doc:anc'").run();
    expect(shown(window, coldReader())).toEqual(["outA", "outB"]);
    expect(shown(window, audience)).toEqual(["outA", "outB"]);
  });
}

it("P1: the second receipt judged on its own after the first (another reply asks only about it)", () => {
  const window = sharedCapturedReply();
  addReply("outC", ["rootB"]);
  const audience = reader(never, "reader-p1c");
  expect(shown(["outA"], audience)).toEqual([]);
  expect(shown(["outB", "outC"], audience)).toEqual([]);
  expect(shown([...window, "outC"], audience)).toEqual([]);
  database().prepare("UPDATE memory_sources SET revision=2 WHERE id='doc:anc'").run();
  expect(shown([...window, "outC"], coldReader())).toEqual(["outA", "outB", "outC"]);
  expect(shown([...window, "outC"], audience)).toEqual(["outA", "outB", "outC"]);
  expect(shown(["outC"], audience)).toEqual(["outC"]);
});

it("P1: a receipt judged right after another that proved the shared reply sound still rests on the reply's ancestry (kept set verdict of its root)", () => {
  begin();
  for (const id of ["doc:anc", "doc:q"]) addDoc(id);
  addCaptured("X");
  addReceipt("rcX", ["X"], ["doc:anc"]);
  // rcP is the newer receipt and is judged first; rcQ cites the same reply X and lists the line outR directly, and rootQ for outQ's set
  addReceipt("rcQ", ["outR", "rootQ"], [messageSource("X"), "doc:q"]);
  addReceipt("rcP", ["outP"], [messageSource("X")]);
  addReply("outQ", ["rootQ"]);
  const window = ["outP", "outR", "outQ"], audience = reader(never, "reader-p1d");
  expect(shown(window, audience)).toEqual([]);
  expect(shown(window, audience)).toEqual([]);
  database().prepare("UPDATE memory_sources SET revision=2 WHERE id='doc:anc'").run();
  expect(shown(window, coldReader())).toEqual(["outP", "outQ", "outR"]);
  expect(shown(window, audience)).toEqual(["outP", "outQ", "outR"]);
});

// ---- P2 ---------------------------------------------------------------------------------------------------------------------------

/** `roots` receipt-bearing roots, each its own group (it cites two sources, written differently), in a chain of sets of 600 roots. */
function receiptRoots(roots: number): string[] {
  const db = database(), write = chainStore(db);
  begin();
  for (const id of ["doc:p", "doc:q"]) addDoc(id);
  const keys = Array.from({ length: roots }, (_, at) => key(`q${at}`));
  let set: string | null = null, end = 0;
  for (let at = 0; at < keys.length; at += 600) { set = write(set, end, keys.slice(at, at + 600)); end = Math.min(keys.length, at + 600); }
  db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, "answer", set);
  const insert = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d',?,?,?,0,0,0,'delivered',9)");
  db.exec("BEGIN");
  for (let at = 0; at < roots; at++) insert.run(`rc${at}`, thread, `[${" ".repeat(at % 97)}${"\t".repeat(Math.floor(at / 97))}]`, JSON.stringify([{ id: "doc:p", revision: 1 }, { id: "doc:q", revision: 1 }]), JSON.stringify([`q${at}`]));
  db.exec("COMMIT");
  return ["answer"];
}
for (const [name, mk] of [["the owner", () => null], ["a reader", () => reader(never, "reader-p2")]] as const) {
  it(`P2: a check that ran out of budget is not made cheaper by what it kept (${name}: withheld cold, withheld warm, withheld fresh)`, () => {
    const window = receiptRoots(6_000);
    setReplayNodeBudgetForTest(12_000);      // 6,000 groups of five nodes: the budget runs out part of the way
    const audience = mk();
    const first = shown(window, audience);
    expect(first).toEqual(["answer"]);
    for (let again = 0; again < 3; again++) expect(shown(window, audience)).toEqual(first);
    expect(shown(window, coldReader())).toEqual(first);
    forgetKeptLineageForTest();
    expect(shown(window, mk())).toEqual(first);
    // with room it is shown, warm and cold
    setReplayNodeBudgetForTest(null);
    expect(shown(window, mk())).toEqual([]);
    expect(shown(window, mk())).toEqual([]);
  }, 300_000);
}

it("P2: a proof that fits is shown warm (the charge is the cost of judging it, not more)", () => {
  const window = receiptRoots(1_500);
  setReplayNodeBudgetForTest(12_000);
  const audience = reader(never, "reader-p2fit");
  for (let again = 0; again < 3; again++) expect(shown(window, audience)).toEqual([]);
  expect(shown(window, null)).toEqual([]);
  expect(shown(window, null)).toEqual([]);
});

// ---- the class: warm equals cold over random sequences ---------------------------------------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
let bumps = 0;
function bumpAuthority(): void { database().prepare("DELETE FROM memory_scopes WHERE id=?").run(ensureScope("conversation", `bump-${bumps++}`)); }

for (let seed = 1; seed <= 100; seed++) it(`a kept answer equals a cold one over random sequences: shared captured replies, memo hits and misses, tight budgets (seed ${seed})`, () => {
  {
    reset();
    const random = prng(seed), pick = (n: number) => Math.floor(random() * n);
    begin();
    const docs = Array.from({ length: 4 }, (_, at) => `doc:s${at}`);
    for (const id of docs) addDoc(id);
    // captured replies, each made under a receipt that cites docs and sometimes an earlier captured reply (an ancestry)
    const captured = Array.from({ length: 3 }, (_, at) => `c${at}`);
    captured.forEach((message, at) => {
      addCaptured(message);
      const cited = [...docs.filter(() => random() < 0.4), ...captured.slice(0, at).filter(() => random() < 0.5).map(messageSource)];
      addReceipt(`rcc${at}`, [message], cited);
    });
    // receipts: several cite the same captured replies (distinct frames), some the same docs, some nothing
    const rootCount = 8, receiptCount = 7;
    for (let at = 0; at < receiptCount; at++) {
      const outputs = Array.from({ length: rootCount }, (_, r) => r).filter(() => random() < 0.35).map(r => `root${r}`);
      if (!outputs.length) outputs.push(`root${at}`);
      const cited = [...docs.filter(() => random() < 0.3), ...captured.filter(() => random() < 0.5).map(messageSource)];
      addReceipt(`rc${at}`, outputs, cited);
    }
    const outs: string[] = [];
    for (let at = 0; at < 6; at++) {
      const roots = Array.from({ length: rootCount }, (_, r) => r).filter(() => random() < 0.35).map(r => `root${r}`);
      if (!roots.length) roots.push(`root${at}`);
      addReply(`out${at}`, roots); outs.push(`out${at}`);
    }
    const denied = new Set<string>();
    const revoked = (row: Record<string, unknown>) => (JSON.parse(String(row.bundles)) as string[]).some(id => denied.has(id));
    const readerWarm = reader(revoked, `warm-${seed}`);
    const trace: string[] = [];
    let tight = false;
    const check = () => {
      const where = `seed ${seed} after ${trace.join(", ")}`;
      if (tight) {
        // Under a budget that runs out, what kept work makes cheaper is by design (a session grown a turn at a time is judged a turn at a
        // time); what must hold is that no check is made easier by a partial proof, so the same ask gives the same answer however often it
        // is asked, and a fresh reader gives it too.
        forgetKeptLineageForTest();
        const first = shown(outs, null);
        for (let again = 0; again < 2; again++) expect(shown(outs, null), `owner repeats, ${where}`).toEqual(first);
        forgetKeptLineageForTest();
        const reading = shown(outs, readerWarm);
        for (let again = 0; again < 2; again++) expect(shown(outs, readerWarm), `reader repeats, ${where}`).toEqual(reading);
        expect(shown(outs, coldReader(revoked)), `fresh reader, ${where}`).toEqual(reading);
        return;
      }
      // a reader's kept answers against a fresh reader's
      expect(shown(outs, readerWarm), `reader, ${where}`).toEqual(shown(outs, coldReader(revoked)));
      // the owner's kept answers against the same check with nothing kept (the check run cold also leaves its proofs kept for the next)
      const warm = shown(outs, null);
      forgetKeptLineageForTest();
      expect(warm, `owner, ${where}`).toEqual(shown(outs, null));
    };
    check(); check();
    for (let step = 0; step < 12; step++) {
      const op = pick(9);
      if (op === 0) { const id = docs[pick(docs.length)]!; database().prepare("UPDATE memory_sources SET revision=revision+1 WHERE id=?").run(id); trace.push(`revise ${id}`); }
      else if (op === 1) { const id = docs[pick(docs.length)]!; database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(id); trace.push(`forget ${id}`); }
      else if (op === 2) { const id = messageSource(captured[pick(captured.length)]!); database().prepare("UPDATE memory_sources SET revision=revision+1 WHERE id=?").run(id); trace.push(`revise ${id}`); }
      else if (op === 3) { denied.add(`rc${pick(receiptCount)}`); bumpAuthority(); trace.push(`deny ${[...denied]}`); }
      else if (op === 4) { denied.clear(); bumpAuthority(); trace.push("permit all"); }
      else if (op === 5) { bumpAuthority(); trace.push("permission change"); }
      // the budget is a constant in the app; a change of it is a new start, as a verdict kept as unproven was reached under the old one
      else if (op === 6) { setReplayNodeBudgetForTest(20 + pick(80)); forgetKeptLineageForTest(); tight = true; trace.push("tight budget"); }
      else if (op === 7) { setReplayNodeBudgetForTest(null); forgetKeptLineageForTest(); tight = false; trace.push("room"); }
      else {
        // growth: a new receipt on the shared captured replies and a reply resting on it
        const at = outs.length;
        addReceipt(`rcn${at}`, [`rootn${at}`], captured.filter(() => random() < 0.6).map(messageSource));
        addReply(`out${at}`, [`rootn${at}`, ...(random() < 0.5 ? [`root${pick(rootCount)}`] : [])]); outs.push(`out${at}`);
        trace.push(`grow out${at}`);
      }
      check();
    }
  }
}, 120_000);
