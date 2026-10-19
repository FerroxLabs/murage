// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 review round 5 of the per-turn lineage work (Astra BLOCK on 505f76b8c): a memo hit with no recorded dependency set (an entry made
// outside any scope: here the root set of a replayed captured reply) tainted the receipt check it happened in, but the verdict that check
// reached was reused through groupRests without the taint, and a proof of a later reply was kept without the ancestor the first one rests
// on. Revising that ancestor then showed what an unbounded cold check withholds. The rule now: once ANY memo hit in a check lacks its
// dependencies, nothing further in that check is kept and what it kept is discarded when it ends.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { chainStore } from "./schema.ts";
import { replayExclusions, setReplayNodeBudgetForTest, type ReplayAudience, type ReplayMessage } from "./replay-lineage.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const thread = "r3-direct";
const key = (message: string) => `${thread}\u0000${message}`;
const messageSource = (message: string) => `message:${thread}:${message}`;
function reset(): void { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); }
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


const unboundedCold = (window: ReplayMessage[], revoked: (row: Record<string, unknown>) => boolean = never): string[] => {
  setReplayNodeBudgetForTest(1_000_000_000);
  try { return [...replayExclusions(LineageAllowance.tool(1_000_000_000), thread, window, coldReader(revoked), { failClosed: true })].sort(); } finally { setReplayNodeBudgetForTest(null); }
};
const ask = (window: ReplayMessage[], audience: ReplayAudience | null) => [...replayExclusions(LineageAllowance.tool(1_000_000_000), thread, window, audience, { failClosed: true })].sort();

/** Replay X (a captured reply that is itself in the window, its roots made under a receipt that cites doc:anc) plus a copy of P;
 * P's receipt cites captured X; P and outB share a root (their sets are the same, or one holds the other, as `shape` says). */
const SHAPES = ["same", "outB-wider", "P-wider", "disjoint-extra", "outB-extends-P"] as const;
function replayXCopyP(shape: typeof SHAPES[number]): ReplayMessage[] {
  begin();
  for (const id of ["doc:anc", "doc:p", "doc:x"]) addDoc(id);
  addCaptured("X");
  addReceipt("rcX", ["X"], ["doc:x"]);
  addReceipt("rcY", ["rootY"], ["doc:anc"]);
  addReply("X", ["rootY"]);
  addReceipt("rcP", ["P", "rootB"], [messageSource("X"), "doc:p"]);
  addReceipt("rcO", ["outB", "rootO"], ["doc:p"]);
  if (shape === "outB-extends-P") {
    // outB's set is P's set plus one root: outB rests on the proof kept for P's set
    const db = database(), write = chainStore(db), setP = write(null, 0, [key("rootB")]), setB = write(setP, 1, [key("rootO")]);
    const insert = db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)");
    insert.run(thread, "P", setP); insert.run(thread, "outB", setB);
    return [{ id: "X", role: "bot" }, { id: "cP", role: "bot", copyOf: { threadId: thread, messageIds: ["P"] } }, { id: "outB", role: "bot" }];
  }
  addReply("P", shape === "P-wider" ? ["rootB", "rootP"] : shape === "disjoint-extra" ? ["rootB", "rootP"] : ["rootB"]);
  addReply("outB", shape === "outB-wider" ? ["rootB", "rootP"] : shape === "disjoint-extra" ? ["rootB", "rootO"] : ["rootB"]);
  return [{ id: "X", role: "bot" }, { id: "cP", role: "bot", copyOf: { threadId: thread, messageIds: ["P"] } }, { id: "outB", role: "bot" }];
}
for (const shape of SHAPES) for (const asked of [["X", "cP"], ["cP", "X"], ["X", "cP", "outB"], ["cP", "X", "outB"]]) for (const [name, audienceOf] of [["the owner", () => null], ["a reader", () => reader(never, `reader-r5-${shape}-${asked.join("")}`)]] as const) {
  it(`P1: an untracked memo hit taints the whole check, so no later proof is kept without the ancestor (${shape}, asking ${asked.join("+")}, ${name})`, () => {
    const base = replayXCopyP(shape), by = new Map(base.map(message => [message.id, message]));
    const first = asked.map(id => by.get(id)!), outB = [by.get("outB")!];
    const audience = audienceOf();
    expect(ask(first, audience)).toEqual(unboundedCold(first));
    expect(ask(first, audience)).toEqual(unboundedCold(first));
    database().prepare("UPDATE memory_sources SET revision=2 WHERE id='doc:anc'").run();
    const cold = unboundedCold(base), coldB = unboundedCold(outB);
    expect(ask(first, audience)).toEqual(unboundedCold(first));
    expect(ask(outB, audience), "outB on its own, the next turn").toEqual(coldB);
    expect(ask(base, audience)).toEqual(cold);
  });
}

// ---- the class: warm equals UNBOUNDED cold (budget disabled) over random shapes of that family ------------------------------------------------
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
let bumps = 0;
function bumpAuthority(): void { database().prepare("DELETE FROM memory_scopes WHERE id=?").run(ensureScope("conversation", `bump-${bumps++}`)); }

for (let seed = 1; seed <= 200; seed++) it(`replayed captured replies and copies: a kept answer equals an unbounded cold one (seed ${seed})`, () => {
  reset();
  const random = prng(seed), pick = (n: number) => Math.floor(random() * n);
  begin();
  const docs = Array.from({ length: 3 }, (_, at) => `doc:s${at}`);
  for (const id of docs) addDoc(id);
  const captured = Array.from({ length: 3 }, (_, at) => `c${at}`);
  captured.forEach((message, at) => {
    addCaptured(message);
    addReceipt(`rcc${at}`, [message], [...docs.filter(() => random() < 0.4), ...captured.slice(0, at).filter(() => random() < 0.4).map(messageSource)]);
  });
  const rootCount = 5, rootsOf = () => { const r = Array.from({ length: rootCount }, (_, i) => i).filter(() => random() < 0.4).map(i => `root${i}`); return r.length ? r : [`root${pick(rootCount)}`]; };
  const receiptCount = 6;
  for (let at = 0; at < receiptCount; at++) {
    const outs = [...rootsOf(), ...(random() < 0.6 ? [`p${pick(3)}`] : [])];
    addReceipt(`rc${at}`, [...new Set(outs)], [...docs.filter(() => random() < 0.3), ...captured.filter(() => random() < 0.5).map(messageSource)]);
  }
  // the replayed captured replies themselves carry root sets; plain replies and copies of the p-lines too
  const window: ReplayMessage[] = [];
  for (const message of captured) if (random() < 0.7) { addReply(message, rootsOf()); window.push({ id: message, role: "bot" }); }
  const pSets: Array<{ id: string; size: number }> = [];
  for (let at = 0; at < 3; at++) if (random() < 0.8) {
    const roots = rootsOf(), id = chainStore(database())(null, 0, roots.map(key));
    database().prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, `p${at}`, id);
    pSets.push({ id, size: new Set(roots).size });
  }
  for (let at = 0; at < 4; at++) {
    // a reply whose set is a p-line's set plus a root, so its proof rests on the one kept for the p-line (the reviewer's shape), or a set of its own
    if (pSets.length && random() < 0.5) {
      const parent = pSets[pick(pSets.length)]!, id = chainStore(database())(parent.id, parent.size, [key(`extra${at}`)]);
      database().prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, `out${at}`, id);
    } else addReply(`out${at}`, rootsOf());
    window.push({ id: `out${at}`, role: "bot" });
  }
  for (let at = 0; at < 3; at++) if (random() < 0.7) window.splice(pick(window.length + 1), 0, { id: `cp${at}`, role: "bot", copyOf: { threadId: thread, messageIds: [`p${at}`] } });
  const denied = new Set<string>();
  const revoked = (row: Record<string, unknown>) => (JSON.parse(String(row.bundles)) as string[]).some(id => denied.has(id));
  const warm = reader(revoked, `warm-${seed}`);
  const trace: string[] = [];
  const check = () => {
    const where = `seed ${seed} after ${trace.join(", ")}`;
    // the turns before: parts of the window asked on their own (a copy and its neighbours), as the next turns ask them
    for (const part of [window.filter(() => random() < 0.5), window.filter(message => !message.id.startsWith("out")), window.filter(message => message.id.startsWith("out"))]) {
      expect(ask(part, warm), `reader part ${part.map(m => m.id)}, ${where}`).toEqual(unboundedCold(part, revoked));
    }
    const cold = unboundedCold(window, revoked);
    expect(ask(window, warm), `reader, ${where}`).toEqual(cold);
    expect(ask(window, warm), `reader again, ${where}`).toEqual(cold);
    expect(ask(window, null), `owner, ${where}`).toEqual(unboundedCold(window));
    expect(ask(window, null), `owner again, ${where}`).toEqual(unboundedCold(window));
    // single lines asked on their own, as another turn would
    for (const one of window) expect(ask([one], warm), `reader alone ${one.id}, ${where}`).toEqual(unboundedCold([one], revoked));
  };
  check();
  for (let step = 0; step < 8; step++) {
    const op = pick(6);
    if (op === 0 || op === 1) { const id = docs[pick(docs.length)]!; database().prepare("UPDATE memory_sources SET revision=revision+1 WHERE id=?").run(id); trace.push(`revise ${id}`); }
    else if (op === 2) { const id = messageSource(captured[pick(captured.length)]!); database().prepare("UPDATE memory_sources SET revision=revision+1 WHERE id=?").run(id); trace.push(`revise ${id}`); }
    else if (op === 3) { const id = docs[pick(docs.length)]!; database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(id); trace.push(`forget ${id}`); }
    else if (op === 4) { denied.add(`rc${pick(receiptCount)}`); bumpAuthority(); trace.push(`deny ${[...denied]}`); }
    else { denied.clear(); bumpAuthority(); trace.push("permit all"); }
    check();
  }
}, 120_000);
