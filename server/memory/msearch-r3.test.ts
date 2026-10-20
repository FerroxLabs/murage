// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Msearch review round 3 (lanes/msearch-review/r3/REPORT.md, BLOCK on 14ea372d6):
//  P1  a record the reader may not read still moved scores, counts, telemetry and cursors of what it could read;
//  P2  refused candidates crowded readable ones out of the helper's 60 and the word index's 200;
//  P2  a normal checkpoint rollover ran a whole-index FTS optimize and a truncating WAL checkpoint per batch.
// Searches here run through the real index and the real eligibility read, the way the helper answers them, and compare
// WHOLE responses between a world that holds the refused record and a world that does not.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { MemoryEligibility } from "./eligibility.ts";
import { MemoryIndex, type IndexedMemory } from "./index.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { pendingProjectionRecords } from "./projection.ts";
import { setMemoryMode } from "./repository.ts";
import { searchMemory, type MemorySearchBridge } from "./search.ts";
import type { MemorySearchInput } from "./worker-protocol.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const ROSTER: MemoryRoster = { bots: [{ id: "a", threadId: "thread-a", section: "crew" }, { id: "b", threadId: "thread-b", section: "crew" }], groups: [] };
const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
const QUERY = "harbour lantern";

function fresh() {
  closeMemoryIndexReader(); closeDatabase();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(ROSTER); setMemoryMode("active");
}
beforeEach(fresh);
afterEach(() => { closeMemoryIndexReader(); });

function accessOf(bot = "a", thread = "thread-a"): MemoryAccess {
  const registry = new InternalCapabilities(), generation = registry.begin(bot, thread);
  const token = registry.mint({ botId: bot, threadId: thread, generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => ROSTER);
}
/** Readable: an owner statement needs no evidence. Refused by memory_get and search alike: a tool observation with none. */
function add(id: string, scope: string, text: string, readable: boolean) {
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,?,'active',1,0,NULL,NULL,0)").run(id, scope, text, readable ? "owner-statement" : "tool-observation");
  // the projection receipt a new record gets is marked indexed, as if the helper had written it: the recent fallback stays silent
  database().prepare("INSERT OR REPLACE INTO memory_projection_receipts VALUES(?,1,0,'indexed','indexed',NULL)").run(id);
}
const entry = (id: string, scopeId: string, text: string): IndexedMemory => ({ id, version: 1, scopeId, text, deleted: false });

/** The helper's answer over a real index (a fresh authority read per search). worker-query.ts wraps these same two calls. */
function helperBridge(index: MemoryIndex, vector: number[] | null): MemorySearchBridge {
  return { search: async (input: MemorySearchInput) => {
    const eligibility = new MemoryEligibility(join(DATA_DIR, "messages.db"));
    try {
      const eligible = eligibility.read(input);
      const result = index.search(input.query, eligible.allowed, vector, "model", input.limit);
      return { ...result, coverageComplete: result.vectorRows === eligible.allowed.length };
    } finally { eligibility.close(); }
  } };
}
function world(records: IndexedMemory[], vectors: Record<string, number[]> = {}) {
  closeMemoryIndexReader();
  rmSync(INDEX_PATH(), { force: true }); rmSync(`${INDEX_PATH()}-wal`, { force: true }); rmSync(`${INDEX_PATH()}-shm`, { force: true });
  const index = new MemoryIndex(INDEX_PATH());
  index.prepareModel("model");
  index.upsert(records);
  for (const record of records) if (vectors[record.id]) index.vector(record, "model", 0, vectors[record.id]);
  return index;
}

describe("round 3 P1: a refused record leaves no trace in anything a reader sees", () => {
  const scope = () => ensureScope("bot", "a");
  const readable = () => entry("kept", scope(), "harbour lantern notes for the Friday review of the long quiet quay and its many lights");
  const refused = () => entry("refused", scope(), "harbour lantern harbour lantern harbour lantern");
  const vectors = { kept: [0.6, 0.8], refused: [1, 0] };

  for (const [name, options] of [["the helper's lists", { lexical: null }], ["the main process's word index", {}]] as const) {
    it(`the whole response is the same with the refused record present and absent (${name})`, async () => {
      add("kept", scope(), readable().text, true);
      add("refused", scope(), refused().text, false);
      const access = accessOf();
      const without = world([readable()], vectors);
      const absent = await searchMemory(QUERY, access, helperBridge(without, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), ...options, caller: "tool", limit: 20 });
      without.close();
      const withIt = world([readable(), refused()], vectors);
      const present = await searchMemory(QUERY, access, helperBridge(withIt, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), ...options, caller: "tool", limit: 20 });
      withIt.close();
      expect(absent.hits.map(hit => hit.id)).toEqual(["kept"]);
      // the refused record ranks first by words and by meaning; the readable one is first of what the reader may see
      expect(absent.hits[0].score).toBeCloseTo(2 / 61, 9);
      expect(present).toEqual(absent);
    });
  }

  it("the answer carries no helper counts, memory figures or timings", async () => {
    add("kept", scope(), readable().text, true);
    const index = world([readable()], vectors);
    let seen: Record<string, unknown> = {};
    const answer = await searchMemory(QUERY, accessOf(), helperBridge(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), lexical: null, telemetry: facts => { seen = facts as unknown as Record<string, unknown>; } });
    index.close();
    for (const key of ["vectorRows", "workerPeakRssBytes", "timings", "profile", "lexicalRanked", "vectorRanked", "unvectored"]) expect(answer).not.toHaveProperty(key);
    expect(seen.vectorRows).toBe(1);
  });

  it("coverage is judged on records the reader may read: a refused record without a vector does not change it", async () => {
    add("kept", scope(), readable().text, true);
    add("refused", scope(), refused().text, false);
    const index = world([readable()], { kept: [0.6, 0.8] });  // the refused record is eligible but has no vector
    const answer = await searchMemory(QUERY, accessOf(), helperBridge(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), lexical: null });
    index.close();
    expect(answer.coverageComplete).toBe(true);
    expect(answer).not.toHaveProperty("recentFallback");
    add("waiting", scope(), "harbour lantern waiting for its vector", true);
    const behind = world([readable()], { kept: [0.6, 0.8] });
    // a different query: the first answer is cached by (query, data revision), and this fixture adds a record without moving the revision
    const incomplete = await searchMemory(`${QUERY} vector`, accessOf(), helperBridge(behind, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), lexical: null });
    behind.close();
    expect(incomplete.coverageComplete).toBe(false);
  });

  it("the recent fallback is reported only when it found a record the reader may read", async () => {
    add("kept", scope(), readable().text, true);
    add("refused", scope(), refused().text, false);
    // neither record is in the index and both are still owed their projection: the recent fallback looks at both
    database().exec("UPDATE memory_projection_receipts SET lexical_status='pending',embedding_status='pending'");
    const bridge: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0, coverageComplete: true }) };
    const both = await searchMemory(QUERY, accessOf(), bridge, { allowance: LineageAllowance.tool(1_000_000_000), lexical: null, caller: "tool", limit: 20 });
    expect(both.hits.map(hit => hit.id)).toEqual(["kept"]);
    expect(both.recentFallback).toBe(true);
    database().prepare("UPDATE memory_records SET state='archived' WHERE id='kept'").run();
    const none = await searchMemory(QUERY, accessOf(), bridge, { allowance: LineageAllowance.tool(1_000_000_000), lexical: null, caller: "tool", limit: 20 });
    expect(none.hits).toEqual([]);
    expect(none).not.toHaveProperty("recentFallback");
    expect(none.coverageComplete).toBe(true);
  });

  it("a cursor is a token only its reader can use and names no record", async () => {
    const reader = accessOf();
    // a stopped scan with a readable record past the stop: the reader is given a token for where it stopped
    const scope = ensureScope("bot", "a");
    add("DENIED-RECORD-ID-0042", scope, "x", false);
    add("zzz-readable-past-the-stop", scope, "past the stop", true);
    const deniedCursor = JSON.stringify(["DENIED-RECORD-ID-0042", 1]);
    const seenCursors: string[] = [];
    const bridge: MemorySearchBridge = { search: async input => { seenCursors.push(input.cursor); return { hits: [], vectorRows: 0, unvectored: [], resumeAfter: deniedCursor }; } };
    const first = await searchMemory(QUERY, reader, bridge, { allowance: LineageAllowance.tool(1_000_000_000), lexical: null });
    expect(JSON.stringify(first)).not.toContain("DENIED-RECORD-ID");
    expect(first.nextCursor).toBeTruthy();
    expect(first.nextCursor).not.toContain("DENIED");
    expect(first.degradedReason).toBe("semantic-capacity-paged");
    expect(first.coverageComplete).toBe(false);
    await searchMemory(QUERY, reader, bridge, { allowance: LineageAllowance.tool(1_000_000_000), lexical: null, cursor: first.nextCursor! });
    expect(seenCursors).toEqual(["", deniedCursor]);
    // another reader, the raw id, and a changed policy revision are all refused
    await expect(searchMemory(QUERY, accessOf("b", "thread-b"), bridge, { allowance: LineageAllowance.tool(1_000_000_000), lexical: null, cursor: first.nextCursor! })).rejects.toThrow("INVALID_MEMORY_CURSOR");
    await expect(searchMemory(QUERY, reader, bridge, { allowance: LineageAllowance.tool(1_000_000_000), lexical: null, cursor: deniedCursor })).rejects.toThrow("INVALID_MEMORY_CURSOR");
    database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    await expect(searchMemory(QUERY, reader, bridge, { allowance: LineageAllowance.tool(1_000_000_000), lexical: null, cursor: first.nextCursor! })).rejects.toThrow();
  });

  it("cursor tokens: sealed once per reader, expired after their lifetime, history mode is part of the binding", async () => {
    const { openMemoryCursor, sealMemoryCursor } = await import("./cursor.ts");
    const reader = accessOf();
    const token = sealMemoryCursor("raw-id", reader, false, 1000);
    expect(openMemoryCursor(token, reader, false, 1000 + 1000)).toBe("raw-id");
    expect(() => openMemoryCursor(token, reader, true, 2000)).toThrow("INVALID_MEMORY_CURSOR");
    expect(() => openMemoryCursor(token, reader, false, 1000 + 11 * 60_000)).toThrow("INVALID_MEMORY_CURSOR");
    expect(openMemoryCursor("", reader, false)).toBe("");
  });
});

describe("the helper's answer", () => {
  it("answerQuery returns the candidate lists, reports only where a scan stopped, and leaves coverage to the main thread", async () => {
    const { answerQuery } = await import("./worker-query.ts");
    const scope = ensureScope("bot", "a");
    add("kept", scope, "harbour lantern notes", true);
    const index = world([entry("kept", scope, "harbour lantern notes")], { kept: [1, 0] });
    const eligibility = new MemoryEligibility(join(DATA_DIR, "messages.db"));
    const access = accessOf();
    const input: MemorySearchInput = { query: QUERY, scopeIds: [...access.scopeIds], policyRevision: access.policyRevision, deletionEpoch: access.deletionEpoch, historical: false, cursor: "", limit: 10, semantic: true };
    const answered = answerQuery(index, eligibility, input, [1, 0], "model");
    expect(answered.result.lexicalRanked).toEqual([["kept", 1]]);
    expect(answered.result.vectorRanked?.map(ref => ref.slice(0, 2))).toEqual([["kept", 1]]);
    expect(answered.result.unvectored).toEqual([]);
    expect(answered.result).not.toHaveProperty("coverageComplete");
    const without = answerQuery(index, eligibility, input, null, "model");
    expect(without.result.coverageComplete).toBe(false);
    expect(without.result).not.toHaveProperty("unvectored");
    eligibility.close(); index.close();
  });
});

describe("round 3 P2: refused candidates never crowd readable ones out", () => {
  const refusedText = "harbour lantern harbour lantern harbour lantern harbour lantern";
  const keptText = "harbour lantern notes for the Friday review of the long quiet quay and its many lights";
  function crowded(count: number) {
    const scope = ensureScope("bot", "a");
    add("kept", scope, keptText, true);
    const records = [entry("kept", scope, keptText)];
    database().exec("BEGIN");
    for (let n = 0; n < count; n++) { const id = `refused-${String(n).padStart(5, "0")}`; add(id, scope, refusedText, false); records.push(entry(id, scope, refusedText)); }
    database().exec("COMMIT");
    return records;
  }
  for (const [name, options] of [["the helper's lists", { lexical: null }], ["the main process's word index", {}]] as const) {
    it(`201 refused matches ahead of one readable match: the readable one is found (${name})`, async () => {
      const index = world(crowded(201));
      const answer = await searchMemory(QUERY, accessOf(), helperBridge(index, null), { allowance: LineageAllowance.tool(1_000_000_000), ...options, caller: "tool", limit: 20 });
      index.close();
      expect(answer.hits.map(hit => hit.id)).toEqual(["kept"]);
      expect(answer.hits[0].text).toBe(keptText);
    });
    it(`more refused matches than the budget covers: nothing leaks, and the answer says coverage is incomplete (${name})`, async () => {
      const index = world(crowded(1200));
      const answer = await searchMemory(QUERY, accessOf(), helperBridge(index, null), { allowance: LineageAllowance.tool(1_000_000_000), ...options, caller: "tool", limit: 20 });
      index.close();
      expect(answer.hits.some(hit => hit.id.startsWith("refused"))).toBe(false);
      expect(answer.coverageComplete).toBe(false);
    }, 60_000);
  }
});

describe("round 3 P2: a rollover deletion is the stepped maintenance's work, not a whole-index pass per batch", () => {
  const sqlLog = (index: MemoryIndex) => {
    const statements: string[] = [];
    const db = (index as unknown as { db: { exec(sql: string): void } }).db, original = db.exec.bind(db);
    db.exec = (sql: string) => { statements.push(sql); original(sql); };
    return statements;
  };
  const seedRolled = (index: MemoryIndex) => index.upsert([1, 2, 3].map(version => ({ id: "checkpoint:t", version, scopeId: "s", text: `Working evidence: version ${version}`, deleted: false })));

  it("deleting rolled checkpoint versions runs no optimize and no truncating checkpoint, and owes the stepped merge", () => {
    const index = new MemoryIndex(INDEX_PATH());
    seedRolled(index);
    const statements = sqlLog(index);
    index.upsert([1, 2].map(version => ({ id: "checkpoint:t", version, scopeId: "s", text: "", deleted: true, rolled: true })));
    expect(statements.filter(sql => /optimize|wal_checkpoint/i.test(sql))).toEqual([]);
    expect(index.maintenanceOwed()).toBe(true);
    // the stepped maintenance does the merge in short steps and then has nothing owed
    let steps = 0;
    while (!index.purgeRolledCheckpoints().done) if (++steps > 10_000) throw new Error("the stepped maintenance did not finish");
    expect(index.maintenanceOwed()).toBe(false);
    index.close();
  });

  // 1.0.3 rehearsal 2: a forget used to merge the whole word index and truncate the log in its own batch, about 47 MB per 16
  // deletions on the owner's index. It now owes the merge to the same stepped maintenance a rollover does.
  it("a forget owes the stepped merge too: no whole-index pass and no truncating checkpoint in its batch", () => {
    const index = new MemoryIndex(INDEX_PATH());
    seedRolled(index);
    const statements = sqlLog(index);
    index.upsert([{ id: "checkpoint:t", version: 3, scopeId: "s", text: "", deleted: true }]);
    expect(statements.filter(sql => /optimize|wal_checkpoint/i.test(sql))).toEqual([]);
    expect(index.maintenanceOwed()).toBe(true);
    let steps = 0;
    while (!index.purgeRolledCheckpoints().done) if (++steps > 10_000) throw new Error("the stepped maintenance did not finish");
    expect(index.maintenanceOwed()).toBe(false);
    index.close();
  });

  it("only a rolled checkpoint version projects as a rollover deletion; a forgotten one and an archived fact do not", () => {
    const scope = ensureScope("bot", "a"), db = database();
    const put = (id: string, version: number, kind: string, state: string, status: string) => {
      db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,'assistant-inference',?,0,0,NULL,NULL,0)").run(id, version, scope, kind, `${kind} ${id} ${version}`, state);
      db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,?,'pending',NULL)").run(id, version, status);
    };
    put("checkpoint:a", 1, "checkpoint", "archived", "pending-archive"); put("checkpoint:a", 2, "checkpoint", "active", "pending");
    put("checkpoint:b", 1, "checkpoint", "deleted", "delete-pending"); put("checkpoint:b", 2, "checkpoint", "active", "pending");
    put("fact-old", 1, "fact", "archived", "pending-archive");
    const rows = Object.fromEntries(pendingProjectionRecords(db, 16).map(row => [`${row.id}:${row.version}`, Number(row.rolled)]));
    expect(rows).toMatchObject({ "checkpoint:a:1": 1, "checkpoint:a:2": 0, "checkpoint:b:1": 0, "checkpoint:b:2": 0, "fact-old:1": 0 });
  });
});
