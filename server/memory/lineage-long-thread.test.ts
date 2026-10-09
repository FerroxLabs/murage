// A real long thread has thousands of receipts: a frame and a lookup receipt
// per turn, over many resumed sessions. Past the receipt limit the check
// counted the thread's reply-to-receipt pairs up to 20,000 for every check
// (24,880 rows to read 24 lines on 2,500 receipts, against 22,831 before the
// whole-thread shortcut and 6,900 now), and one owner turn read 31,469 rows.
// Pinned by rows read, which do not depend on the machine.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { captureSource } from "./capture.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { filterDirectReplay } from "./disclosures.ts";
import { replayRowsRead, setReplayNodeBudgetForTest } from "./replay-lineage.ts";
import type { MemorySearchBridge } from "./search.ts";
import type { Message } from "../store.ts";

const roster: MemoryRoster = {
  bots: [
    { id: "dax", threadId: "dax-direct", section: "Operations" },
    { id: "kessler", threadId: "kessler-direct", section: "Operations" },
  ],
  groups: [],
};
/** What a direct turn may replay or quote (filterDirectReplay). */
const directAllowed = (t: string, m: Message[], a: MemoryAccess, s: Set<string>) => filterDirectReplay(t, m, a, s).allowed;
const empty: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
afterEach(() => setReplayNodeBudgetForTest(null));
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

function access(botId: string, thread: string): MemoryAccess {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin(botId, thread, "g");
  const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const version = (id: string) => (database().prepare("SELECT max(version) AS version FROM memory_records WHERE id=?").get(id) as { version: number }).version;

/** A memory of the owner's words in `thread`, active and owner-pinned, so
 * every turn's frame carries it (Dax's standing notes). */
function memory(thread: string, botId: string, key: string, text: string, pinned = true) {
  reconcileMemoryRoster(roster);
  captureSource(database(), { id: `src-${key}`, threadId: thread, kind: "text", speaker: "owner", outcome: "recorded", text });
  const id = saveMemoryCandidate(text, [{ sourceId: `src-${key}`, revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], `k-${key}`, access(botId, thread));
  database().prepare("UPDATE memory_records SET state='active', owner_pinned=? WHERE id=?").run(pinned ? 1 : 0, id);
  return id;
}
const handle = (id: string, key: string) => ({ id, version: version(id), evidence: [{ sourceId: `src-${key}`, revision: 1 }] });

const owner = (id: string, at: number): Message => ({ id, role: "user", kind: "text", text: `ask ${id}`, at });
const reply = (id: string, at: number, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: `answer ${id}`, at, from: { botId: "dax", name: "Dax", color: "#000" }, ...extra });


const rowsFor = (messages: Message[], a: MemoryAccess) => { const before = replayRowsRead(); const kept = directAllowed("dax-direct", messages, a, new Set()); return { kept, rows: replayRowsRead() - before }; };
/** Rows read before the whole-thread shortcut (033e6de8d^) on this same thread. */
const BASE_HEALTHY = 22_831, BASE_FORGOTTEN = 82_874;

async function longThread(turns: number, receipts: number) {
  memory("dax-direct", "dax", "pin", "Rebel Wealth Accelerator launches in March.");
  const a = access("dax", "dax-direct");
  const records: string[] = [];
  const messages: Message[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const id = memory("dax-direct", "dax", `r${turn}`, `Fact number ${turn} about the offer.`, false);
    records.push(id);
    messages.push(owner(`ask-${turn}`, turn * 10));
    const bundle = await buildMemoryBundle("what is the plan", a, empty);
    const receipt = new MemoryDispatchReceipt(bundle, a, "fuigo");
    receipt.sessionStarted("native-1");
    receipt.accepted();
    receipt.noteLookup([handle(id, `r${turn}`)], a);
    receipt.output(`tool-${turn}`);
    receipt.output(`reply-${turn}`);
    messages.push({ id: `tool-${turn}`, role: "bot", kind: "activity", at: turn * 10 + 1, tool: { name: "memory_search", ok: true } });
    messages.push(reply(`reply-${turn}`, turn * 10 + 2));
  }
  // the thread's earlier sessions: receipts that list the same lines, in bulk
  const ids = JSON.stringify(messages.filter(m => m.role !== "user").map(m => m.id));
  database().exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${receipts})
    INSERT INTO memory_disclosures SELECT 'clone'||i, thread_id, driver_instance, native_session, record_versions, source_versions, '${ids}', policy_revision, deletion_epoch, token_count, state, created_at
    FROM n, (SELECT * FROM memory_disclosures WHERE bundle_id NOT LIKE '%:lookup' LIMIT 1)`);
  return { a, messages, records };
}

it("a thread of 2,500 receipts reads rows in proportion to its receipts, not 20,000 for counting pairs, with the same verdicts", async () => {
  const { a, messages, records } = await longThread(12, 2500);
  const healthy = rowsFor(messages, a);
  expect(healthy.rows).toBeLessThan(BASE_HEALTHY / 2);
  expect(healthy.kept.filter(m => m.role !== "user" && m.kind === "text").length).toBeGreaterThanOrEqual(10);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: records[3]! });
  const after = rowsFor(messages, access("dax", "dax-direct"));
  expect(after.rows).toBeLessThan(BASE_FORGOTTEN / 4);
  // a forgotten recall withholds every reply made on it (turn 4 on, each
  // reply of the session rests on every receipt before it), the replies made
  // before it stay: the owner's direct chat withholds on content (1.0.1)
  expect(after.kept.filter(m => m.role !== "user").map(m => m.id)).toEqual(["reply-1", "reply-2", "reply-3"]);
  expect(after.kept.filter(m => m.role === "user").length).toBeGreaterThanOrEqual(10);
}, 240_000);

// A thread of more receipts than the receipt limit, with between 2,048 and
// 20,000 reply-to-receipt pairs. The whole-thread read is tried first and runs
// out of the node budget; the pairs are then listed exactly, as before the
// change, so every verdict is the base verdict and nothing extra is withheld.
it("more receipts than the limit and 2,048 to 20,000 pairs: the fallback lists the pairs, with the base verdicts", async () => {
  const { a, messages } = await longThread(12, 300);
  const pairs = Number((database().prepare("SELECT count(*) AS n FROM memory_disclosure_outputs").get() as { n: number }).n);
  expect(pairs).toBeGreaterThan(2048);
  expect(pairs).toBeLessThan(20000);
  // receipts that list nothing of these replies, each its own group (the bulk of the thread)
  database().exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<3000)
    INSERT INTO memory_disclosures SELECT 'filler'||i, thread_id, driver_instance, native_session, record_versions, source_versions, '["unrelated-'||i||'"]', policy_revision+i, deletion_epoch, token_count, state, created_at
    FROM n, (SELECT * FROM memory_disclosures WHERE bundle_id='clone1')`);
  const receipts = Number((database().prepare("SELECT count(DISTINCT bundle_id) AS n FROM memory_disclosures WHERE thread_id='dax-direct'").get() as { n: number }).n);
  expect(receipts).toBeGreaterThan(2048);
  // the whole thread costs more than the budget, the listed pairs do not
  setReplayNodeBudgetForTest(3000);
  const kept = directAllowed("dax-direct", messages, a, new Set());
  expect(kept.filter(m => m.role !== "user" && m.kind === "text").length).toBe(12);
  expect(kept.length).toBe(messages.filter(m => m.kind !== "activity").length + 0);
}, 240_000);
