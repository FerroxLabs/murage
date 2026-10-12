// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot's own memory_search (caller "tool") under load (fix/1.0.2-memory-search). Sable reported, two days running,
// that memory_search "came back empty and told me recall isn't available": the turn's 500 ms budget was applied to
// an explicit tool call, a helper that missed it left nothing but MEMORY_RECALL_UNAVAILABLE, and nothing was logged.
// Now a tool search waits TOOL_SEARCH_BUDGET_MS, falls back to keywords marked partial instead of answering empty,
// logs every degraded answer with its cause code (never memory text), and keeps every access check it had.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database } from "../database.ts";
import { resetObserveWindows, setObserveSink } from "../observe.ts";
import { MemoryIndex } from "./index.ts";
import { pendingProjectionRecords } from "./projection.ts";
import { closeMemoryIndexReader, lexicalPage, RECALL_FIRST_PAGE } from "./index-reader.ts";
import { SEARCH_BUDGET_MS, TOOL_SEARCH_BUDGET_MS, TOOL_SEMANTIC_CUTOFF_MS, searchMemory, type MemorySearchBridge } from "./search.ts";
import { resetWorkerLog } from "./worker-log.ts";
import { accessFor, captureAndPublish, failingBridge, freshDataDir, hangingBridge, indexPendingRecords } from "./testing/recall-fixture.ts";

let lines: string[];
beforeEach(() => { freshDataDir("active"); resetWorkerLog(); resetObserveWindows(); lines = []; setObserveSink(line => lines.push(line)); });
afterEach(() => { closeMemoryIndexReader(); setObserveSink(); });

const FACTS = ["The quarterly launch review is on Friday at ten.", "Sean prefers concise status reports every Monday.", "Dinner reservations are at the harbour restaurant."];
function seed(index = false) { for (const text of FACTS) captureAndPublish(text); if (index) indexPendingRecords(); }
const recordFor = (word: string) => database().prepare("SELECT id,version FROM memory_records WHERE text LIKE ? AND state='active' LIMIT 1").get(`%${word}%`)!;
const block = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* memory work holding the event loop */ } };
const recallLines = () => lines.filter(line => line.startsWith("[memory] recall "));

it("under worker load a tool search waits for the helper and returns full results inside the tool budget, where a turn's budget gave up", async () => {
  seed();
  const record = recordFor("launch");
  // The helper is behind a backlog: it answers after 1.2 s, and the event loop stalls 0.8 s on the way (perf102 measured 0.4-0.9 s p90).
  const busy = (): MemorySearchBridge => ({ search: () => new Promise(resolve => {
    setTimeout(() => block(800), 50);
    setTimeout(() => resolve({ hits: [{ id: String(record.id), version: Number(record.version), score: 1 }], vectorRows: 3, coverageComplete: true }), 1200);
  }) });
  const { access } = accessFor();
  const turn = await searchMemory("launch review", access, busy(), { lexical: null });
  expect(turn.hits.some(hit => hit.id === record.id)).toBe(true); // the keyword fallback still finds it
  expect(turn.partial).toBe(true);
  let slowest = 0, full = 0;
  for (let n = 0; n < 5; n++) {
    const started = performance.now();
    const tool = await searchMemory("launch review", access, busy(), { lexical: null, caller: "tool" });
    slowest = Math.max(slowest, performance.now() - started);
    if (tool.hits.some(hit => hit.id === record.id) && tool.degradedReason === undefined && !tool.partial) full++;
  }
  expect(full).toBe(5);
  expect(slowest).toBeLessThan(TOOL_SEARCH_BUDGET_MS);
  expect(SEARCH_BUDGET_MS).toBeLessThan(TOOL_SEARCH_BUDGET_MS);
}, 30_000);

it("a semantic timeout with no word index returns keyword hits marked partial, with a note the bot can read", async () => {
  seed();
  const started = performance.now();
  const result = await searchMemory("harbour restaurant", accessFor().access, hangingBridge, { lexical: null, caller: "tool" });
  expect(performance.now() - started).toBeLessThan(TOOL_SEARCH_BUDGET_MS + 400);
  expect(result.hits.map(hit => hit.text)).toEqual(["Dinner reservations are at the harbour restaurant."]);
  expect(result).toMatchObject({ partial: true, recallMode: "keyword", degradedReason: "MEMORY_RECALL_PARTIAL", coverageComplete: false });
  expect(result.note).toMatch(/^Partial results/);
  expect(result.note).not.toMatch(/\u2014|\bsafe/i);
}, 15_000);

it("a semantic timeout with the word index ready answers from the words, marked partial, within the tool's semantic cutoff", async () => {
  seed(true);
  const started = performance.now();
  const result = await searchMemory("launch review Friday", accessFor().access, hangingBridge, { caller: "tool" });
  expect(performance.now() - started).toBeLessThan(TOOL_SEMANTIC_CUTOFF_MS + 400);
  expect(result.hits[0].text).toContain("launch review");
  expect(result).toMatchObject({ partial: true, recallMode: "keyword", degradedReason: "semantic-skipped" });
});

it("nothing found by any path is still reported unavailable, and the note says memory could not be searched", async () => {
  const result = await searchMemory("zebra", accessFor().access, failingBridge("MEMORY_WORKER_NOT_READY"), { lexical: null, caller: "tool" });
  expect(result.hits).toEqual([]);
  expect(result.degradedReason).toBe("MEMORY_RECALL_UNAVAILABLE");
  expect(result.note).toMatch(/could not be searched/);
});

it("each failure cause is logged with its code, the caller and the outcome, and never the memory text", async () => {
  seed();
  const { access } = accessFor();
  await searchMemory("harbour", access, failingBridge("MEMORY_WORKER_NOT_READY"), { lexical: null, caller: "tool" });
  await searchMemory("harbour", access, failingBridge("MEMORY_WORKER_START_BACKOFF"), { lexical: null });
  await searchMemory("harbour", access, hangingBridge, { lexical: null });
  const record = recordFor("harbour");
  await searchMemory("harbour", access, { search: async () => ({ hits: [{ id: String(record.id), version: Number(record.version), score: 1 }], vectorRows: 0, degradedReason: "local-model-unavailable" }) }, { lexical: null, caller: "tool" });
  // Hydration that starts past its limit: the helper holds the loop past the tool's 3.5 s hydration limit, then hands back
  // three hits. No hit is exempt from the limit (msearch review P1), so the search answers at once, empty and partial.
  const many = database().prepare("SELECT id,version FROM memory_records WHERE state='active' ORDER BY text LIKE '%reports%' DESC").all().map(row => ({ id: String(row.id), version: Number(row.version), score: 1 }));
  const late = await searchMemory("reports", access, { search: () => { block(3600); return Promise.resolve({ hits: many, vectorRows: 3, coverageComplete: true }); } }, { lexical: null, limit: 1, caller: "tool" });
  expect(late.hits).toHaveLength(0);
  expect(late).toMatchObject({ degradedReason: "MEMORY_RECALL_UNAVAILABLE", partial: true });
  seed(true);
  await searchMemory("launch", access, hangingBridge, { caller: "tool" });
  const logged = recallLines();
  for (const [caller, cause, outcome] of [["tool", "MEMORY_WORKER_NOT_READY", "partial"], ["turn", "MEMORY_WORKER_START_BACKOFF", "partial"], ["turn", "MEMORY_QUERY_DEADLINE", "partial"],
    ["tool", "local-model-unavailable", "full"], ["tool", "MEMORY_RECALL_HYDRATION_LIMIT", "empty"], ["tool", "SEMANTIC_CUTOFF", "partial"]])
    expect(logged.some(line => line.includes(`caller=${caller} cause=${cause} outcome=${outcome}`)), `${caller} ${cause}\n${logged.join("\n")}`).toBe(true);
  for (const word of ["harbour", "launch", "Sean", "reports", "restaurant"]) expect(logged.join("\n")).not.toContain(word);
}, 30_000);

it("the keyword fallback keeps every access check: other audiences, records waiting for review, and revoked access", async () => {
  seed();
  const db = database();
  const other = randomUUID();
  db.prepare("INSERT INTO memory_scopes VALUES(?,'conversation',?,'[]',0)").run(other, "other-thread");
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,0,NULL,NULL,0)").run("other-audience", other, "harbour restaurant OTHER_CANARY");
  const own = String(db.prepare("SELECT scope_id FROM memory_records WHERE text LIKE '%harbour%'").get()!.scope_id);
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'assistant-inference','candidate',0,0,NULL,NULL,0)").run("waiting-review", own, "harbour restaurant PENDING_CANARY");
  const { access, registry } = accessFor();
  const result = await searchMemory("harbour restaurant", access, hangingBridge, { lexical: null, caller: "tool" });
  expect(result.hits.length).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toMatch(/OTHER_CANARY|PENDING_CANARY/);
  expect(result.hits.every(hit => hit.scopeId === own)).toBe(true);
  registry.revokeThread("thread");
  await expect(searchMemory("harbour", access, hangingBridge, { lexical: null, caller: "tool" })).rejects.toThrow();
});

it("old versions of a long thread's checkpoint no longer crowd the word page: they leave the index, and current recall finds the facts", async () => {
  seed(true);
  const db = database();
  const scope = String(db.prepare("SELECT scope_id FROM memory_records LIMIT 1").get()!.scope_id);
  const id = `checkpoint:${randomUUID()}`, versions = 300;
  const insert = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES(?,?,?,'checkpoint',?,'assistant-inference',?,0,0,0)");
  const rows = [];
  for (let version = 1; version <= versions; version++) {
    const text = `Thread checkpoint ${version}: the launch review status and the reports.`;
    insert.run(id, version, scope, text, version === versions ? "active" : "archived");
    rows.push({ id, version, scopeId: scope, text, deleted: false, archived: version !== versions });
  }
  // An index an earlier build wrote: every version is in it, and they fill the first page.
  closeMemoryIndexReader();
  let index = new MemoryIndex(join(DATA_DIR, "memory-index.db"));
  try { index.upsert(rows); } finally { index.close(); }
  expect(lexicalPage("launch review reports", [scope], RECALL_FIRST_PAGE)!.hits.filter(hit => hit.id === id).length).toBe(RECALL_FIRST_PAGE);
  // The helper removes them in slices when it opens the index (worker.ts); the newest version stays.
  closeMemoryIndexReader();
  index = new MemoryIndex(join(DATA_DIR, "memory-index.db"));
  try { while (!index.purgeRolledCheckpoints({ maxExamined: 100 }).done) { /* steps */ } } finally { index.close(); }
  expect(lexicalPage("launch review reports", [scope], RECALL_FIRST_PAGE)!.hits.filter(hit => hit.id === id).map(hit => hit.version)).toEqual([versions]);
  const result = await searchMemory("launch review reports", accessFor().access, hangingBridge, { caller: "tool" });
  expect(result.hits.some(hit => hit.text.includes("quarterly launch review"))).toBe(true);
  expect(result.hits.some(hit => hit.text.includes("concise status reports"))).toBe(true);
  // New archived versions are never written: the projection sends them as deleted (projection.ts rolledCheckpointSql).
  db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending-archive','pending',NULL)").run(id, 1);
  expect(pendingProjectionRecords(db, 16).find(row => row.id === id && Number(row.version) === 1)).toMatchObject({ state: "deleted", text: "" });
}, 15_000);
