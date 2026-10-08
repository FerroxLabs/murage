// Output lineage in every memory mode (memory schema v6, round 3 item 3).
// A reply made with no receipt (memory off) rests on the replies its context
// carried. Its roots are the replies made under a receipt, copied flat into
// one deduplicated root set: a long conversation stays visible however many
// roots it gathers, and is withheld as a whole when a root's source is
// revoked. A retained session whose set nears the one hard ceiling resets.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { captureSource } from "./capture.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt, retainedSessionInvalid } from "./dispatch.ts";
import { outputRootsFor, recordOutputRoots, recordSessionRoots, replayExclusions, setRootSetCeilingForTest } from "./replay-lineage.ts";
import { roomTranscriptWithoutMemory } from "../room-transcript.ts";
import type { Message } from "../store.ts";
import { setMemoryMode } from "./repository.ts";

const roster: MemoryRoster = { bots: [{ id: "dax", threadId: "dax-direct" }], groups: [] };
const thread = "dax-direct";
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster); });
function access(): MemoryAccess {
  const registry = new InternalCapabilities(); registry.begin("dax", thread, "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "dax", threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
const empty = { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } };

/** X is disclosed while memory is active; the reply X' is made under that receipt. */
async function disclose(): Promise<MemoryDispatchReceipt> {
  const text = "The vault code is 7731.";
  captureSource(database(), { id: "src-x", threadId: thread, kind: "text", speaker: "owner", outcome: "recorded", text });
  const id = saveMemoryCandidate(text, [{ sourceId: "src-x", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k-x", access());
  database().prepare("UPDATE memory_records SET state='active', owner_pinned=1 WHERE id=?").run(id);
  const a = access();
  const bundle = await buildMemoryBundle("vault", a, empty);
  expect(bundle.recordVersions.map(record => record.id)).toContain(id);
  const receipt = new MemoryDispatchReceipt(bundle, a, "claude");
  receipt.sessionStarted("s-active");
  receipt.accepted();
  receipt.output("x-prime");
  return receipt;
}
const bot = (id: string) => ({ threadId: thread, id, role: "bot" as const });
const rootsOf = (id: string, threadId = thread) => database().prepare("SELECT m.root_thread_id,m.root_message_id FROM memory_output_roots o JOIN memory_root_set_members m ON m.set_id=o.set_id WHERE o.thread_id=? AND o.message_id=? ORDER BY m.root_message_id").all(threadId, id).map(row => `${row.root_thread_id}/${row.root_message_id}`);
const setOf = (id: string, threadId = thread) => database().prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id=?").get(threadId, id)?.set_id;
afterEach(() => setRootSetCeilingForTest(null));
const withheld = (ids: string[]) => replayExclusions(thread, ids.map(id => ({ id, role: "bot" })), null, { failClosed: true });

it("a 30-turn OFF conversation after one disclosure stays visible, flat, until X is revoked; then all of it is withheld", async () => {
  await disclose();
  setMemoryMode("off");
  // each OFF turn is shown the reply before it, and paraphrases it
  const chain = ["x-prime"];
  for (let turn = 1; turn <= 30; turn++) {
    const id = `off-${turn}`;
    recordOutputRoots(thread, id, outputRootsFor([bot(chain.at(-1)!)]));
    chain.push(id);
  }
  // flat: every OFF reply rests on X' alone, however far down the chain
  for (const id of chain.slice(1)) expect(rootsOf(id)).toEqual([`${thread}/x-prime`]);
  // an OFF reply made with nothing memory-derived in its context has no roots
  recordOutputRoots(thread, "plain", outputRootsFor([{ threadId: thread, id: "owner-ask", role: "user" }]));
  expect(rootsOf("plain")).toEqual([]);
  expect([...withheld([...chain, "plain"])]).toEqual([]);
  // X is revoked: the paraphrase and everything after it go with X'
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "src-x", revision: 1 });
  expect(new Set(withheld([...chain, "plain"]))).toEqual(new Set(chain));
});

it("a 600-reply ACTIVE chat with memory outputs keeps every reply visible until a revoke, then everything derived from the revoked root is withheld", async () => {
  const receipt = await disclose();
  // every reply is made under the receipt and is shown the reply before it:
  // reply k rests on the k replies before it (past the old 256 cap)
  const chain = ["x-prime"];
  // The chain is built in one transaction (each step nests in it): as one
  // commit apiece the 600 replies took 270 s on a GitHub Windows runner.
  transaction(() => {
    for (let turn = 1; turn < 600; turn++) {
      const id = `r-${turn}`;
      recordOutputRoots(thread, id, outputRootsFor([bot(chain.at(-1)!)]));
      receipt.output(id);
      chain.push(id);
    }
  });
  expect(rootsOf("r-599")).toHaveLength(599);
  expect(database().prepare("SELECT count(*) AS n FROM memory_output_roots WHERE set_id=''").get()?.n).toBe(0);
  // memory goes off and one more reply paraphrases the newest
  setMemoryMode("off");
  recordOutputRoots(thread, "off-1", outputRootsFor([bot("r-599")]));
  expect(rootsOf("off-1")).toHaveLength(600);
  expect([...withheld([...chain, "off-1"])]).toEqual([]);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "src-x", revision: 1 });
  expect(new Set(withheld([...chain, "off-1"]))).toEqual(new Set([...chain, "off-1"]));
}, 60_000);

it("root sets are deduplicated: the same union is the same set id, stored once", async () => {
  const receipt = await disclose();
  receipt.output("x-second");
  recordOutputRoots(thread, "a", outputRootsFor([bot("x-prime"), bot("x-second")]));
  const sets = Number(database().prepare("SELECT count(*) AS n FROM memory_root_sets").get()?.n);
  // the same union, reached in another order and through another reply
  recordOutputRoots(thread, "b", outputRootsFor([bot("x-second"), bot("x-prime")]));
  recordOutputRoots(thread, "c", outputRootsFor([bot("a")]));
  expect(setOf("b")).toBe(setOf("a"));
  expect(setOf("c")).toBe(setOf("a"));
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_root_sets").get()?.n)).toBe(sets);
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_root_set_members WHERE set_id=?").get(String(setOf("a")))?.n)).toBe(2);
  // inheriting takes the union of the parents' sets
  recordOutputRoots(thread, "d", outputRootsFor([bot("x-prime")]));
  recordOutputRoots(thread, "e", outputRootsFor([bot("d"), bot("x-second")]));
  expect(setOf("e")).toBe(setOf("a"));
});

it("at the ceiling the retained session resets instead of withholding the reply", async () => {
  const receipt = await disclose();
  setRootSetCeilingForTest(20);
  for (let i = 0; i < 19; i++) receipt.output(`m-${i}`);
  const context = outputRootsFor(Array.from({ length: 19 }, (_, i) => bot(`m-${i}`)));
  expect(context.over).toBe(false);
  // the session has taken in 19 roots: within the headroom of the ceiling of 20
  recordSessionRoots(thread, "claude", "s-full", context);
  recordOutputRoots(thread, "reply", context);
  const why: { reason?: string } = {};
  expect(retainedSessionInvalid(thread, "claude", "s-full", why)).toBe(true);
  expect(why.reason).toBe("root-ceiling");
  // the reply itself is visible: it is not withheld for the ceiling
  expect([...withheld(["reply"])]).toEqual([]);
  // a fresh session starts small and holds
  recordSessionRoots(thread, "claude", "s-fresh", outputRootsFor([bot("m-0")]));
  expect(retainedSessionInvalid(thread, "claude", "s-fresh")).toBe(false);
  // only a reply whose own context alone passes the ceiling is unprovable
  for (let i = 19; i < 25; i++) receipt.output(`m-${i}`);
  const wide = outputRootsFor(Array.from({ length: 25 }, (_, i) => bot(`m-${i}`)));
  expect(wide.over).toBe(true);
  recordOutputRoots(thread, "wide", wide);
  expect(setOf("wide")).toBe("");
  expect([...withheld(["wide"])]).toEqual(["wide"]);
});

it("a pre-v6 session resets before its first v6 continuation whatever the counters say, then is not reset again", async () => {
  await disclose();
  // the receipt predates lineage, and no counter moved since
  database().prepare("UPDATE memory_lineage_meta SET since=? WHERE id=1").run(Date.now() + 60_000);
  const why: { reason?: string } = {};
  expect(retainedSessionInvalid(thread, "claude", "s-active", why)).toBe(true);
  expect(why.reason).toBe("pre-lineage");
  // the session v6 starts in its place gets its row (session.started), even with no roots
  recordSessionRoots(thread, "claude", "s-active", outputRootsFor([]));
  expect(retainedSessionInvalid(thread, "claude", "s-active")).toBe(false);
});

it("a thread with no receipt of its own still withholds a reply whose root elsewhere is revoked", async () => {
  await disclose();
  setMemoryMode("off");
  // a fresh OFF thread was shown X' through cross-thread working context
  const other = "moss-direct";
  recordOutputRoots(other, "y", outputRootsFor([bot("x-prime")]));
  const lines: Message[] = [{ id: "y", at: 1, role: "bot", kind: "text", text: "the code is 7731" } as Message];
  expect(roomTranscriptWithoutMemory(other, lines, true)?.withheld.size).toBe(0);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "src-x", revision: 1 });
  expect([...(roomTranscriptWithoutMemory(other, lines, true)?.withheld ?? [])]).toEqual(["y"]);
});

it("a large thread (2,000 replies over 500 roots) is checked in a bounded number of statements", async () => {
  const receipt = await disclose();
  const roots = Array.from({ length: 500 }, (_, i) => `root-${i}`);
  for (const id of roots) receipt.output(id);
  const big = "big-room";
  const db = database();
  db.exec("BEGIN");
  // reply i rests on the first 1 + i % 500 roots (500 distinct sets, reused)
  for (let i = 0; i < 2000; i++) recordOutputRoots(big, `b-${i}`, { roots: new Set(roots.slice(0, 1 + (i % 500)).map(id => `${thread}\u0000${id}`)), over: false });
  db.exec("COMMIT");
  const original = db.prepare.bind(db);
  let statements = 0;
  (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => { statements++; return original(sql); }) as typeof db.prepare;
  const started = performance.now();
  let out: Set<string>;
  try { out = replayExclusions(big, Array.from({ length: 2000 }, (_, i) => ({ id: `b-${i}`, role: "bot" })), null, { failClosed: true }); }
  finally { delete (db as { prepare?: unknown }).prepare; }
  const elapsed = performance.now() - started;
  expect(out.size).toBe(0);
  // one batch per thread, not one per message or per root (31 when written)
  expect(statements).toBeLessThan(200);
  expect(elapsed).toBeLessThan(10_000);
}, 120_000);

it("an OFF engine session that was shown a memory-derived reply is not resumed after X is revoked", async () => {
  await disclose();
  setMemoryMode("off");
  // a fresh OFF session replayed X'; it holds no receipt of its own
  recordSessionRoots(thread, "claude", "s-off", outputRootsFor([bot("x-prime")]));
  expect(retainedSessionInvalid(thread, "claude", "s-off")).toBe(false);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "src-x", revision: 1 });
  const why: { reason?: string } = {};
  expect(retainedSessionInvalid(thread, "claude", "s-off", why)).toBe(true);
  expect(why.reason).toBe("session-roots");
});
