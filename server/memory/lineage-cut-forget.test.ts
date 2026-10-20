// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 lineage-cold, the privacy contract of a bounded check (the second review's 1,600 cut-and-forget comparisons, kept as a test): over
// random histories of captured replies, receipts, copies and root sets, a check whose allowance is CUT at a random point
//   - never throws out of a fail-closed replay (zero escaped limit exceptions),
//   - never shows a reply the unbounded cold check withholds (its exclusions are a superset of the reference's), and
//   - once given room again, converges to exactly the reference,
// whatever is forgotten, revised or revoked between its slices. 100 histories x 8 mutation steps x 2 comparisons = 1,600 comparisons.
// The warmer's slices are interleaved the same way, and "forgetting between warming slices withholds every affected reply" is pinned on a chain.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { chainStore } from "./schema.ts";
import { forgetKeptLineageForTest, replayExclusions, setReplayNodeBudgetForTest, warmReplies, type ReplayAudience, type ReplayMessage } from "./replay-lineage.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const thread = "cut-direct";
const key = (message: string) => `${thread}\u0000${message}`;
const messageSource = (message: string) => `message:${thread}:${message}`;
function reset(): void { closeDatabase(); forgetKeptLineageForTest(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); }
beforeEach(reset);
afterEach(() => setReplayNodeBudgetForTest(null));

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const reader = (revoked: (row: Record<string, unknown>) => boolean, cacheKey: string): ReplayAudience => ({ policyRevision: 0, deletionEpoch: 0, revoked, cacheKey });
let coldReaders = 0;

it("100 histories x 8 steps: a cut check withholds at least what the unbounded one does and throws nothing; given room it converges to it (1,600 comparisons)", () => {
  let comparisons = 0, cuts = 0, strict = 0;
  for (let seed = 1; seed <= 100; seed++) {
    reset();
    const random = prng(seed), pick = (n: number) => Math.floor(random() * n);
    setMemoryMode("active");
    reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
    const db = database(), scope = ensureScope("conversation", thread), write = chainStore(db);
    const docs = Array.from({ length: 3 }, (_, at) => `doc:s${at}`);
    for (const id of docs) db.prepare("INSERT INTO memory_sources VALUES(?,?,NULL,NULL,NULL,1,'hash','text','owner','recorded',NULL,'active')").run(id, scope);
    const replies = 8 + pick(8);
    const captured = Array.from({ length: replies }, (_, at) => `c${at}`);
    const receipts: string[] = [];
    captured.forEach((message, at) => {
      db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:b','settled',NULL,'active')").run(messageSource(message), scope, thread, message);
      const cites = [...docs.filter(() => random() < 0.25), ...captured.slice(0, at).filter(() => random() < (at ? 0.5 : 0)).map(messageSource)];
      const bundle = `rc${at}`; receipts.push(bundle);
      db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d','[]',?,?,0,0,0,'delivered',9)")
        .run(bundle, thread, JSON.stringify(cites.map(id => ({ id, revision: 1 }))), JSON.stringify([message]));
      const roots = captured.slice(0, at + 1).filter(() => random() < 0.5).map(key);
      if (roots.length) db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, message, write(null, 0, roots));
    });
    const window: ReplayMessage[] = captured.map(id => ({ id, role: "bot" }));
    for (let at = 0; at < 2; at++) window.push({ id: `cp${at}`, role: "bot", copyOf: { threadId: thread, messageIds: [captured[pick(captured.length)]!] } });
    const denied = new Set<string>();
    const revoked = (row: Record<string, unknown>) => (JSON.parse(String(row.bundles)) as string[]).some(id => denied.has(id));
    const warm = reader(revoked, `warm-${seed}`);
    const reference = (): string[] => {
      setReplayNodeBudgetForTest(1_000_000_000);
      try { return [...replayExclusions(LineageAllowance.tool(1_000_000_000), thread, window, reader(revoked, `cold-${coldReaders++}`), { failClosed: true })].sort(); } finally { setReplayNodeBudgetForTest(null); }
    };
    const stepCheck = (where: string) => {
      const truth = reference();
      // cut at a random point, twice: the second finds what the first kept and gets further
      for (let round = 0; round < 2; round++) {
        const cut = [0, 1, 2, 3, 5, 8, 13, 21, 55][pick(9)]!;
        let out: string[] = [];
        expect(() => { out = [...replayExclusions(LineageAllowance.turn(cut), thread, window, warm, { failClosed: true })].sort(); }, `${where}: nothing escapes a cut at ${cut}`).not.toThrow();
        cuts++;
        for (const id of truth) expect(out, `${where}: cut ${cut} still withholds ${id}`).toContain(id);
        if (out.length > truth.length) strict++;
      }
      comparisons++;
      // given room it converges to the reference
      expect([...replayExclusions(LineageAllowance.turn(1_000_000), thread, window, warm, { failClosed: true })].sort(), `${where}: with room it equals the unbounded check`).toEqual(truth);
      comparisons++;
    };
    stepCheck(`seed ${seed}`);
    const trace: string[] = [];
    for (let step = 0; step < 7; step++) {
      const op = pick(7);
      if (op === 0) { const id = docs[pick(docs.length)]!; db.prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(id); trace.push(`forget ${id}`); }
      else if (op === 1) { const id = docs[pick(docs.length)]!; db.prepare("UPDATE memory_sources SET revision=revision+1 WHERE id=?").run(id); trace.push(`revise ${id}`); }
      else if (op === 2) { const id = messageSource(captured[pick(captured.length)]!); db.prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(id); trace.push(`forget ${id}`); }
      else if (op === 3) { denied.add(receipts[pick(receipts.length)]!); db.prepare("DELETE FROM memory_scopes WHERE id=?").run(ensureScope("conversation", `bump-${seed}-${step}`)); trace.push("deny"); }
      else if (op === 4) { warmReplies(thread, captured, 8 + pick(40)); trace.push("warm"); }
      else if (op === 5) { denied.clear(); db.prepare("DELETE FROM memory_scopes WHERE id=?").run(ensureScope("conversation", `bump-${seed}-${step}`)); trace.push("permit"); }
      else { const id = docs[pick(docs.length)]!; db.prepare("UPDATE memory_sources SET revision=revision+1 WHERE id=?").run(id); trace.push(`revise ${id}`); }
      stepCheck(`seed ${seed} after ${trace.join(", ")}`);
    }
  }
  console.log(`CUT-AND-FORGET ${comparisons} comparisons, ${cuts} cut checks, ${strict} withheld more than the reference (unproven), none escaped`);
  expect(comparisons).toBe(1_600);
  expect(cuts).toBe(1_600);
  expect(strict, "the cuts really ran out of room somewhere").toBeGreaterThan(50);
}, 600_000);

it("forgetting between warming slices withholds every reply that rests on what was forgotten (a 40-reply chain, 20 above the forgotten one)", () => {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database(), scope = ensureScope("conversation", thread), write = chainStore(db);
  const n = 40;
  db.exec("BEGIN");
  for (let index = 0; index < n; index++) {
    db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:b','settled',NULL,'active')").run(messageSource(`r${index}`), scope, thread, `r${index}`);
    db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(thread, `r${index}`, index, "bot", "text", `reply ${index}`, "{}");
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d','[]',?,?,0,0,0,'delivered',9)")
      .run(`rc${index}`, thread, JSON.stringify(index ? [{ id: messageSource(`r${index - 1}`), revision: 1 }] : []), JSON.stringify([`r${index}`]));
  }
  let parent: string | null = null;
  for (let index = 0; index < n; index++) { parent = write(parent, index, [key(`r${index}`)]); db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, `r${index}`, parent); }
  db.exec("COMMIT");
  closeDatabase(); forgetKeptLineageForTest(); database();
  const ids = Array.from({ length: n }, (_, index) => `r${index}`);
  const requested = ids.slice(20).map(id => ({ id, role: "bot" }));
  // warm a little at a time, forgetting r19 in the middle of it
  let slices = 0;
  for (; slices < 60; slices++) {
    if (slices === 2) database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(messageSource("r19"));
    const slice = warmReplies(thread, ids, 40);
    if (slice.done && slices > 2) break;
  }
  // r20..r39 each rest on r19 (through the chain of cited replies and of root sets): all 20 requested replies are withheld, warm or not
  const warm = replayExclusions(LineageAllowance.turn(1_000_000), thread, requested, null, { failClosed: true });
  expect([...warm].sort()).toEqual(requested.map(line => line.id).sort());
  forgetKeptLineageForTest();
  setReplayNodeBudgetForTest(1_000_000_000);
  const cold = replayExclusions(LineageAllowance.tool(1_000_000_000), thread, requested, null, { failClosed: true });
  setReplayNodeBudgetForTest(null);
  expect([...cold].sort()).toEqual([...warm].sort());
  console.log(`FORGET-BETWEEN-SLICES ${slices} warming slices, ${warm.size} of ${requested.length} requested replies withheld`);
}, 300_000);
