// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1022 recallperf item 4 (meaning search). Each witness enters through the helper's real answer (answerQuery, the function
// worker.ts runs for every search) over a real index, or through searchMemory (what a turn and memory_search call):
//  W4a  a memory over 12,000 vectors is scored whole, never switched to words only (it threw MEMORY_SEMANTIC_CAPACITY);
//  W4b  a warm search scores the resident vectors and reads none from the table (it read and copied every vector per search);
//  W4c  a forgotten or replaced vector is never scored from the resident set (own connection and another connection);
//  W4d  a meaning search cut off at SEMANTIC_CUTOFF_MS is never reported as complete coverage.
import { openTestIndex, put } from "./testing/open-index.ts";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { MemoryEligibility } from "./eligibility.ts";
import * as indexModule from "./index.ts";
import type { MemoryIndex } from "./index.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { setMemoryMode } from "./repository.ts";
import { clearMemorySearchCache, searchMemory } from "./search.ts";
import { answerQuery, scanLimits } from "./worker-query.ts";
import { eligibleLimits } from "./eligibility.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryOwnerRoute } from "./settings.ts";
import * as adoption from "./model-adoption.ts";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemorySearchInput } from "./worker-protocol.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { captureAndPublish, freshDataDir, hangingBridge, indexPendingRecords, accessFor } from "./testing/recall-fixture.ts";

const ROSTER: MemoryRoster = { bots: [{ id: "a", threadId: "thread-a", section: "crew" }], groups: [] };
const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
// (read through the module: the pre-fix build has no resident limit, and its witnesses must fail at their assertions, not here)
const residentVectorLimits = (indexModule as { residentVectorLimits?: { bytes: number } }).residentVectorLimits ?? { bytes: 0 };
const DEFAULT_RESIDENT = residentVectorLimits.bytes;
let index: MemoryIndex | undefined;

function setup() {
  closeMemoryIndexReader(); closeDatabase(); clearMemorySearchCache();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(ROSTER); setMemoryMode("active");
}
afterEach(() => { index?.close(); index = undefined; closeMemoryIndexReader(); residentVectorLimits.bytes = DEFAULT_RESIDENT; vi.restoreAllMocks(); });

function accessOf(): MemoryAccess {
  const registry = new InternalCapabilities(), generation = registry.begin("a", "thread-a");
  const token = registry.mint({ botId: "a", threadId: "thread-a", generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => ROSTER);
}
/** `count` readable records in bot a's scope, each with `parts` vectors written by another connection (as a restored file has them).
 * Record `hit` part `parts-1` points at the query; every other vector points away. */
async function memoryOf(count: number, parts: number, hit: number, entries = false) {
  const scope = ensureScope("bot", "a");
  const insert = database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',1,0,NULL,NULL,0)");
  const receipt = database().prepare("INSERT OR REPLACE INTO memory_projection_receipts VALUES(?,1,0,?,'indexed',NULL)");
  database().exec("BEGIN");
  for (let n = 0; n < count; n++) { const id = `r-${String(n).padStart(5, "0")}`; insert.run(id, scope, "quiet note"); receipt.run(id, scope); }
  database().exec("COMMIT");
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  index = await openTestIndex(INDEX_PATH());
  // the index's own entries first (writing an entry drops that record's vectors), then the vectors
  if (entries) await put(index, Array.from({ length: count }, (_, n) => ({ id: `r-${String(n).padStart(5, "0")}`, version: 1, scopeId: scope, text: "quiet note", deleted: false })));
  const db = new DatabaseSync(INDEX_PATH()), row = db.prepare("INSERT INTO vectors VALUES(?,1,'model',?,?)");
  db.exec("BEGIN");
  for (let n = 0; n < count; n++) for (let part = 0; part < parts; part++)
    row.run(`r-${String(n).padStart(5, "0")}`, part, Buffer.from(new Float32Array(n === hit && part === parts - 1 ? [1, 0] : [0, 1]).buffer));
  db.exec("COMMIT"); db.close();
  // the helper's boot (worker.ts), which swallows a refusal here the same way
  try { index.prepareModel("model"); } catch { /* as worker.ts: the search decides */ }
  return index;
}
function ask(of: MemoryIndex) {
  const access = accessOf(), eligibility = new MemoryEligibility(join(DATA_DIR, "messages.db"));
  const input: MemorySearchInput = { query: "harbour lantern", scopeIds: [...access.scopeIds], policyRevision: access.policyRevision, deletionEpoch: access.deletionEpoch, historical: false, cursor: "", limit: 10, semantic: true };
  type Answer = ReturnType<typeof answerQuery>["result"];
  try { return answerQuery(of, eligibility, input, [1, 0], "model").result as Answer & { vectorRanked: NonNullable<Answer["vectorRanked"]> }; } finally { eligibility.close(); }
}

// W4a: table-driven over both scoring paths of MemoryIndex.search (resident set; records the resident set cannot hold).
it.each([["resident", DEFAULT_RESIDENT], ["read from the table", 0]])("W4a: 4,001 records x 3 vectors (12,003 > 12,000) are all scored by meaning (%s)", async (_path, bytes) => {
  setup();
  residentVectorLimits.bytes = bytes;
  const answered = ask(await memoryOf(4001, 3, 2000));
  expect({ reason: answered.degradedReason, rows: answered.vectorRows, top: answered.vectorRanked[0]?.[0] }).toEqual({ reason: undefined, rows: 12003, top: "r-02000" });
}, 120_000);

it("W4b: a warm search scores the resident vectors and reads no vector from the table", async () => {
  setup();
  const warm = await memoryOf(2000, 1, 1234);
  const reads: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) { if (/\bvectors\b/.test(sql)) reads.push(sql); return prepare.call(this, sql); });
  const answered = ask(warm);
  expect({ reads, rows: answered.vectorRows, top: answered.vectorRanked[0]?.[0] }).toEqual({ reads: [], rows: 2000, top: "r-01234" });
}, 120_000);

it("W4c: a vector deleted after the set went resident is never scored again (this connection, then another)", async () => {
  setup();
  const warm = await memoryOf(3, 1, 1, true), scope = ensureScope("bot", "a");
  expect(ask(warm).vectorRanked[0]?.[0]).toBe("r-00001");
  // forget on the helper's own connection (the purge path deletes the entry and its vectors)
  await put(warm, [{ id: "r-00001", version: 1, scopeId: scope, text: "quiet note", deleted: true }]);
  const own = warm.search("", [{ id: "r-00001", version: 1 }], [1, 0], "model", 10, { words: false });
  expect({ rows: own.vectorRows, ranked: own.vectorRanked }).toEqual({ rows: 0, ranked: [] });
  // a commit by another connection (a restore or repair) moves the file's version: the resident set is read again
  const db = new DatabaseSync(INDEX_PATH()); db.prepare("DELETE FROM vectors WHERE id='r-00002'").run(); db.close();
  const other = warm.search("", [{ id: "r-00002", version: 1 }], [1, 0], "model", 10, { words: false });
  expect({ rows: other.vectorRows, ranked: other.vectorRanked }).toEqual({ rows: 0, ranked: [] });
}, 120_000);

it("W4d: a meaning search cut off at SEMANTIC_CUTOFF_MS is not reported as complete", async () => {
  freshDataDir("active");
  captureAndPublish("The quarterly launch review is on Friday at ten.");
  await indexPendingRecords();
  const result = await searchMemory("launch review Friday", accessFor().access, hangingBridge, { allowance: LineageAllowance.tool(1_000_000_000) });
  expect(result.hits[0]?.text).toContain("launch review");
  expect(result.coverageComplete).toBe(false);
});
beforeEach(() => { clearMemorySearchCache(); });

// W4e (item 4, "tell the owner if capacity is hit"): a turn's meaning search that stops at its scan budget with records left is reported on the
// owner's memory status (GET /api/memory/status, semantic.capacityHitAt). The budget is lowered so 300 records stand for a big memory.
it("W4e: a meaning search stopped at its scan budget shows on the owner's memory status", async () => {
  setup();
  // (through the module: the pre-fix build has no capacity note, and its run must fail at the assertion, not here)
  (adoption as { resetSemanticCapacityForTest?: () => void }).resetSemanticCapacityForTest?.();
  const chunk = eligibleLimits.chunk, chunks = scanLimits.chunks;
  eligibleLimits.chunk = 100; scanLimits.chunks = 1;
  try {
    const of = await memoryOf(300, 1, 250);
    const status = async () => ((await memoryOwnerRoute("/api/memory/status", undefined, ownerMemoryTicket(), ROSTER)) as { semantic?: { capacityHitAt?: number } | null }).semantic;
    expect((await status())?.capacityHitAt, "nothing hit before any search").toBeUndefined();
    const eligibility = new MemoryEligibility(join(DATA_DIR, "messages.db"));
    const bridge = { search: async (input: MemorySearchInput) => answerQuery(of, eligibility, input, [1, 0], "model").result };
    try { await searchMemory("harbour lantern", accessOf(), bridge, { allowance: LineageAllowance.tool(1_000_000_000) }).catch(() => undefined); } finally { eligibility.close(); }
    expect(typeof (await status())?.capacityHitAt, "the owner's status names the capacity hit").toBe("number");
  } finally { eligibleLimits.chunk = chunk; scanLimits.chunks = chunks; }
}, 120_000);

// W4f (item 4d, MAIN-RULING RECALLPERF-1022): the capacity hit on the owner's status shows as ONE plain sentence on the Memory page health card
// (MemoryHealth open, as MemorySettings mounts it), in every shipped language, and only once a search has hit the budget.
const CAPACITY_SENTENCE: Record<string, string> = {
  en: "Murage searched your most recent memories first; older ones are still there.",
  de: "Murage hat zuerst deine neuesten Erinnerungen durchsucht; ältere sind weiterhin da.",
  es: "Murage buscó primero en tus memorias más recientes; las más antiguas siguen ahí.",
  fr: "Murage a d’abord cherché dans tes souvenirs les plus récents ; les plus anciens sont toujours là.",
  hi: "Murage ने पहले आपकी सबसे नई यादें खोजीं; पुरानी यादें अब भी मौजूद हैं।",
  ja: "Murage は新しいメモリから先に検索しましたが、古いメモリもそのまま残っています。",
  "pt-br": "O Murage buscou primeiro nas suas memórias mais recentes; as mais antigas continuam lá.",
  zh: "Murage 先搜索了你最近的记忆；较早的记忆仍然都在。",
};
it("W4f: the Memory page health card says older memories are still there once a search hit its budget, in all 8 languages", async () => {
  setup();
  (adoption as { resetSemanticCapacityForTest?: () => void }).resetSemanticCapacityForTest?.();
  // (the client modules through vi.importActual, as turn-preparation-api.test.ts does: the server typecheck program has no JSX or DOM)
  const { MemoryHealth } = await vi.importActual<{ MemoryHealth: ComponentType<{ status: unknown; open?: boolean }> }>("../../src/components/MemoryLearningControls.tsx");
  const { setLocale } = await vi.importActual<{ setLocale: (tag: string) => Promise<string> }>("../../src/lib/i18n.ts");
  const chunk = eligibleLimits.chunk, chunks = scanLimits.chunks;
  eligibleLimits.chunk = 100; scanLimits.chunks = 1;
  const page = async () => {
    const status = await memoryOwnerRoute("/api/memory/status", undefined, ownerMemoryTicket(), ROSTER);
    return renderToStaticMarkup(createElement(MemoryHealth, { status, open: true }));
  };
  try {
    const of = await memoryOf(300, 1, 250);
    expect(await page(), "no sentence before any search hit the budget").not.toContain(CAPACITY_SENTENCE.en);
    const eligibility = new MemoryEligibility(join(DATA_DIR, "messages.db"));
    const bridge = { search: async (input: MemorySearchInput) => answerQuery(of, eligibility, input, [1, 0], "model").result };
    try { await searchMemory("harbour lantern", accessOf(), bridge, { allowance: LineageAllowance.tool(1_000_000_000) }).catch(() => undefined); } finally { eligibility.close(); }
    for (const code of Object.keys(CAPACITY_SENTENCE)) {
      expect(await setLocale(code), "pack loads").toBe(code);
      expect(await page(), `Memory page (${code})`).toContain(CAPACITY_SENTENCE[code]);
    }
  } finally { eligibleLimits.chunk = chunk; scanLimits.chunks = chunks; await setLocale("en"); }
}, 120_000);
