// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The msearch review (lanes/msearch-review/REPORT.md, BLOCK on 9ef747bea) and its follow-ups:
//  P1  search returned another bot's private identity record that memory_get refuses;
//  P1  search returned a promoted copy whose parent was archived or forgotten, which memory_get refuses;
//  P1  the keyword fallback walked every PIP row before its row limit, synchronously; hydration exempted the first hits
//      from its deadline;
//  P2  finding the current checkpoint walked every archived version (now they leave the index);
//  and a held memory_save says it is held, and why.
// Round 2 (lanes/msearch-review/r2/REPORT.md, BLOCK on 0e487a8b4): search diverged from memory_get on evidence scope,
// evidence presence and span, source tombstones, failed tools and historical forgotten-parent copies; the fallback's
// byte cap was checked between slices; a late index acknowledgement overwrote a rolled checkpoint's pending cleanup;
// the purge walked every checkpoint entry in one step and merged the whole index at once. Every read now goes through
// readableMemoryRecord (readable.ts); the property test below compares all five search paths with memory_get.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { hydrateMemoryRecord } from "./bundle.ts";
import { captureWork } from "./chunks.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { MemoryIndex, type IndexHit } from "./index.ts";
import { closeMemoryIndexReader, lexicalPage, RECALL_FIRST_PAGE, RECALL_SEARCH_SQL } from "./index-reader.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { assertMemoryAccess, ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { pendingProjectionRecords } from "./projection.ts";
import { KEYWORD_FALLBACK_BUDGET_MS, KEYWORD_FALLBACK_MAX_BYTES, KEYWORD_FALLBACK_MAX_ROWS, KEYWORD_FALLBACK_SLICE, keywordScan } from "./recent.ts";
import { setMemoryMode } from "./repository.ts";
import { memoryAgentRoute } from "./routes.ts";
import { clearMemorySearchCache, searchMemory, type MemorySearchBridge } from "./search.ts";
import { CURRENT_MEMORY, MemoryEligibility } from "./eligibility.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const ROOM_THREAD = "room-thread";
const ROSTER: MemoryRoster = { bots: [{ id: "a", threadId: "thread-a", section: "crew" }, { id: "b", threadId: "thread-b", section: "crew" }], groups: [{ id: "room", threadId: ROOM_THREAD, memberIds: ["a", "b"] }] };

/** The live roster: a trial may take bot A out of the room after its access was minted. */
let roster: MemoryRoster = structuredClone(ROSTER);
/** A new, empty store. The checkpointer thread holds the old messages.db open past closeDatabase() and, as the last
 * connection, deletes its log files when it closes; racing that, rmSync({force}) could return with the folder still there
 * (messages.db included), and the next trial then ran on the previous trial's whole store: its records, scopes and
 * grants (rc13 msearch: "MEMORY_SCOPE_DENIED" on a record the trial never wrote, and bot B's scope reachable with no
 * grant). The checkpointer is stopped first, and a store that survived the reset fails here, not as a policy mismatch. */
async function fresh() {
  closeMemoryIndexReader(); closeDatabase();
  expect(await stopWalMaintenance()).toBe(true);
  removeTempDirSync(DATA_DIR);
  expect(existsSync(DATA_DIR)).toBe(false);
  mkdirSync(DATA_DIR, { recursive: true });
  roster = structuredClone(ROSTER);
  reconcileMemoryRoster(roster); setMemoryMode("active");
}
beforeEach(fresh);
afterEach(() => { closeMemoryIndexReader(); setMemoryCaptureRoster(null); });

function accessOf(bot: string, thread: string): MemoryAccess {
  const registry = new InternalCapabilities(), generation = registry.begin(bot, thread);
  const token = registry.mint({ botId: bot, threadId: thread, generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
/** The owner grants bot A an audience binding to bot B's own scope (settings "bind", authority.ts bindMemoryScope). */
function grantBotScope(to: string, scopeId: string) {
  database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'bot',?,0,'granted','{}')").run(randomUUID(), scopeId, to);
  database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
}
/** An owner-stated record: no evidence needed, pinned so relevance selection keeps every hit it is given. */
function record(id: string, scopeId: string, opts: { kind?: string; state?: string; identity?: boolean; version?: number; supersedes?: string; assertion?: string } = {}) {
  const version = opts.version ?? 1;
  database().prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,1,0,NULL,?,0)")
    .run(id, version, scopeId, opts.kind ?? "fact", `harbour lantern note ${id}`, opts.assertion ?? "owner-statement", opts.state ?? "active", opts.supersedes ?? null);
  if (opts.identity) database().prepare("UPDATE memory_record_details SET partition='identity',confidence_basis='Owner-authored fictional continuity' WHERE record_id=? AND record_version=?").run(id, version);
  return { id, version, score: 1 };
}
const derive = (parent: string, child: string) => database().prepare("INSERT INTO memory_derivations VALUES(?,1,?,1)").run(parent, child);
const bridgeFor = (hits: IndexHit[]): MemorySearchBridge => ({ search: async () => ({ hits, vectorRows: hits.length, coverageComplete: true }) });
/** A helper answer that is never cached (no vectors), so each path below reads the hits it is given. */
const plainBridge = (hits: IndexHit[]): MemorySearchBridge => ({ search: async () => ({ hits, vectorRows: 0, coverageComplete: true }) });
const failing: MemorySearchBridge = { search: async () => { throw new Error("MEMORY_WORKER_EXITED"); } };
const getAllowed = (access: MemoryAccess, id: string, version = 1) => { try { hydrateMemoryRecord(id, version, access, {allowance: LineageAllowance.tool(1_000_000_000)}); return true; } catch { return false; } };
/** memory_get itself, through the route a bot calls. */
async function memoryGet(access: MemoryAccess, id: string, version = 1): Promise<true | string> {
  try { await memoryAgentRoute("/api/internal/memory/get", { handles: [{ id, version }] }, access, failing); return true; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}
async function searchIds(access: MemoryAccess, hits: IndexHit[], options: { historical?: boolean } = {}) {
  // limit 20: every fed hit can come back. Only fed ids count: the recent fallback adds unindexed records of its own.
  const fed = new Set(hits.map(hit => hit.id));
  const result = await searchMemory("harbour lantern note", access, bridgeFor(hits), { allowance: LineageAllowance.tool(1_000_000_000), lexical: null, caller: "tool", limit: 20, ...options });
  return new Set(result.hits.map(hit => hit.id).filter(id => fed.has(id)));
}
const PATHS = ["helper", "word", "recent", "keyword", "historical"] as const;
type SearchPath = typeof PATHS[number];
/** Each search path on its own, over the given record ids (version 1). The helper, word, keyword and historical runs
 * mark every record indexed so the recent fallback stays silent; the recent run marks none, with no helper or word hit. */
async function fivePaths(access: MemoryAccess, ids: readonly string[]): Promise<Record<SearchPath, Set<string>>> {
  const db = database(), query = "harbour lantern note", fed = new Set(ids);
  const hits = ids.map(id => ({ id, version: 1, score: 1 }));
  const found = (result: { hits: Array<{ id: string }> }) => new Set(result.hits.map(hit => hit.id).filter(id => fed.has(id)));
  const indexed = (on: boolean) => {
    db.exec("DELETE FROM memory_projection_receipts");
    if (on) db.exec("INSERT INTO memory_projection_receipts SELECT id,version,0,'indexed','indexed',NULL FROM memory_records");
  };
  const options = { caller: "tool" as const, limit: 20 };
  indexed(true);
  const helper = found(await searchMemory(query, access, plainBridge(hits), { allowance: LineageAllowance.tool(1_000_000_000), ...options, lexical: null }));
  const word = found(await searchMemory(query, access, plainBridge([]), { allowance: LineageAllowance.tool(1_000_000_000), ...options, lexical: () => ({ hits, more: false }) }));
  const keywordResult = await searchMemory(query, access, failing, { allowance: LineageAllowance.tool(1_000_000_000), ...options, lexical: null });
  expect(keywordResult.recallMode).toBe("keyword");
  const keyword = found(keywordResult);
  const historical = found(await searchMemory(query, access, plainBridge(hits), { allowance: LineageAllowance.tool(1_000_000_000), ...options, lexical: null, historical: true }));
  indexed(false);
  const recent = found(await searchMemory(query, access, plainBridge([]), { allowance: LineageAllowance.tool(1_000_000_000), ...options, lexical: null }));
  return { helper, word, recent, keyword, historical };
}
/** A captured source: `texts[n]` is revision n+1's text; the source stands at the last revision. */
function source(id: string, scopeId: string, opts: { texts?: string[]; state?: string; kind?: string; speaker?: string; outcome?: string } = {}) {
  const texts = opts.texts ?? ["harbour lantern evidence text"];
  database().prepare("INSERT INTO memory_sources VALUES(?,?,NULL,NULL,NULL,?,'hash',?,?,?,NULL,?)")
    .run(id, scopeId, texts.length, opts.kind ?? "message", opts.speaker ?? "user", opts.outcome ?? "succeeded", opts.state ?? "active");
  texts.forEach((text, n) => database().prepare("INSERT INTO memory_source_versions VALUES(?,?,'hash',?,1)").run(id, n + 1, JSON.stringify({ text, occurredAt: 1 })));
}
const evidence = (recordId: string, sourceId: string, revision: number, start: number, end: number) =>
  database().prepare("INSERT INTO memory_evidence VALUES(?,1,?,?,?,?)").run(recordId, sourceId, revision, start, end);
const tombstone = (type: "record" | "source", id: string, revision: number | null) =>
  database().prepare("INSERT INTO memory_tombstones VALUES(?,?,?,?,NULL,1,'owner-forget',0)").run(randomUUID(), type, id, revision);
const forget = (id: string) => { database().prepare("UPDATE memory_records SET state='deleted' WHERE id=?").run(id); tombstone("record", id, null); };
const scopeOk = (access: MemoryAccess, scope: string) => { try { assertMemoryAccess(access, scope); return true; } catch { return false; } };
/** Every path misses each id, and memory_get refuses each one. */
async function refusedEverywhere(access: MemoryAccess, ids: string[], code?: string) {
  const paths = await fivePaths(access, ids);
  for (const path of PATHS) expect({ path, found: [...paths[path]] }).toEqual({ path, found: [] });
  for (const id of ids) { const got = await memoryGet(access, id); expect(got).not.toBe(true); if (code) expect(got).toBe(code); }
}

describe("search denies exactly what memory_get denies", () => {
  it("P1: a bot granted another bot's scope does not find that bot's private identity record, on any search path", async () => {
    const aScope = ensureScope("bot", "a"), bScope = ensureScope("bot", "b");
    grantBotScope("a", bScope);
    const access = accessOf("a", "thread-a");
    expect(access.scopeIds).toContain(bScope); // the grant reaches B's scope, unpartitioned, owner direct turn
    const hits = [record("own-canon", aScope, { kind: "character-canon", identity: true }), record("b-canon", bScope, { kind: "character-canon", identity: true }), record("b-fact", bScope)];
    expect(getAllowed(access, "b-canon")).toBe(false);
    expect(() => hydrateMemoryRecord("b-canon", 1, access, {allowance: LineageAllowance.tool(1_000_000_000)})).toThrow("MEMORY_SCOPE_DENIED");
    expect([getAllowed(access, "own-canon"), getAllowed(access, "b-fact")]).toEqual([true, true]);
    const paths = await fivePaths(access, hits.map(hit => hit.id));
    for (const path of PATHS) expect({ path, found: paths[path] }).toEqual({ path, found: new Set(["own-canon", "b-fact"]) });
    // in a room the bot's own identity stays out too, as memory_get says
    const room = accessOf("a", ROOM_THREAD);
    expect(getAllowed(room, "own-canon")).toBe(false);
    expect(room.scopeIds).toContain(aScope);
    expect(await searchIds(room, [{ id: "own-canon", version: 1, score: 1 }])).toEqual(new Set());
  });

  it("P1: a copy whose parent was archived is not current; a copy whose parent was forgotten is not found by any path, historical included", async () => {
    const aScope = ensureScope("bot", "a"), team = ensureScope("team", "crew");
    const access = accessOf("a", "thread-a");
    record("parent", aScope); record("copy", team); derive("parent", "copy");
    record("parent-2", aScope); record("copy-2", team); derive("parent-2", "copy-2");
    const hits = ["copy", "copy-2"].map(id => ({ id, version: 1, score: 1 }));
    expect(await searchIds(access, hits)).toEqual(new Set(["copy", "copy-2"]));
    database().prepare("UPDATE memory_records SET state='archived' WHERE id='parent'").run();
    forget("parent-2");
    expect([getAllowed(access, "copy"), getAllowed(access, "copy-2")]).toEqual([false, false]);
    const paths = await fivePaths(access, ["copy", "copy-2"]);
    for (const path of ["helper", "word", "recent", "keyword"] as const) expect({ path, found: paths[path] }).toEqual({ path, found: new Set() });
    // History reads a copy whose parent was archived since; a surviving copy of a forgotten parent is forgotten with it.
    expect(paths.historical).toEqual(new Set(["copy"]));
  });

  it("round 2 P1: after the bot leaves a room, a lesson in its own scope resting on the room's words is refused by memory_get and every path", async () => {
    const aScope = ensureScope("bot", "a"), room = ensureScope("room", "room");
    const access = accessOf("a", "thread-a");
    expect(access.scopeIds).toContain(room);
    source("room-src", room);
    record("lesson", aScope, { assertion: "tool-observation" }); evidence("lesson", "room-src", 1, 0, 7);
    expect(await memoryGet(access, "lesson")).toBe(true);
    const before = await fivePaths(access, ["lesson"]);
    for (const path of PATHS) expect({ path, found: [...before[path]] }).toEqual({ path, found: ["lesson"] });
    roster.groups[0].memberIds = ["b"];  // A leaves the room; its access was minted before
    expect(scopeOk(access, room)).toBe(false);
    await refusedEverywhere(access, ["lesson"], "MEMORY_SCOPE_DENIED");
    // a fresh access does not reach the room at all: same answer
    await refusedEverywhere(accessOf("a", "thread-a"), ["lesson"], "MEMORY_SCOPE_DENIED");
  });

  it("round 2 negative fixtures: missing evidence, a span past the text, a forgotten source, a failed tool, evidence in a scope never granted", async () => {
    const aScope = ensureScope("bot", "a"), foreign = ensureScope("conversation", "thread-b");
    const access = accessOf("a", "thread-a");
    source("src", aScope, { texts: ["harbour lantern"] });
    source("gone", aScope); tombstone("source", "gone", 1);
    source("gone-all", aScope); tombstone("source", "gone-all", null);
    source("tool", aScope, { kind: "tool-outcome", speaker: "tool", outcome: "failed" });
    source("other-bot", foreign);
    record("no-evidence", aScope, { assertion: "tool-observation" });
    record("span-past", aScope, { assertion: "tool-observation" }); evidence("span-past", "src", 1, 0, 16);
    record("span-empty", aScope, { assertion: "tool-observation" }); evidence("span-empty", "src", 1, 3, 3);
    record("tombstoned-src", aScope, { assertion: "tool-observation" }); evidence("tombstoned-src", "gone", 1, 0, 7);
    record("tombstoned-all", aScope, { assertion: "tool-observation" }); evidence("tombstoned-all", "gone-all", 1, 0, 7);
    record("failed-tool", aScope, { assertion: "tool-observation" }); evidence("failed-tool", "tool", 1, 0, 7);
    record("foreign-evidence", aScope, { assertion: "tool-observation" }); evidence("foreign-evidence", "other-bot", 1, 0, 7);
    record("good", aScope, { assertion: "tool-observation" }); evidence("good", "src", 1, 0, 15);
    expect(await memoryGet(access, "good")).toBe(true);
    const good = await fivePaths(access, ["good"]);
    for (const path of PATHS) expect({ path, found: [...good[path]] }).toEqual({ path, found: ["good"] });
    await refusedEverywhere(access, ["no-evidence", "span-past", "span-empty", "tombstoned-src", "tombstoned-all", "failed-tool"], "MEMORY_EVIDENCE_UNAVAILABLE");
    await refusedEverywhere(access, ["foreign-evidence"], "MEMORY_SCOPE_DENIED");
  });

  it("property: over randomized grants and revocations, room membership, identity rows, derivations, archive and forget, sources, tombstones, spans, failed tools and pending records, every search path returns a record exactly when memory_get allows it", { tags: ["nightly"], timeout: 3_600_000 }, async () => {
    let seed = 0x5eed;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)];
    const tally = { checked: 0, denied: 0, historyOnly: 0, revoked: 0, compared: 0, comparedNonEmpty: 0, faults: {} as Record<string, number> };
    const TRIALS = 80, RECORDS = 12;
    for (let trial = 0; trial < TRIALS; trial++) {
      await fresh();
      const scopes = { a: ensureScope("bot", "a"), b: ensureScope("bot", "b"), team: ensureScope("team", "crew"), conv: ensureScope("conversation", "thread-a"), room: ensureScope("room", "room"), foreign: ensureScope("conversation", "thread-b") };
      const grant = rand();
      if (grant < 0.5) grantBotScope("a", scopes.b);
      else if (grant < 0.65) { grantBotScope("a", scopes.b); database().exec("UPDATE memory_scope_bindings SET state='revoked' WHERE subject_id='a' AND state='granted'; UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1"); }
      const inRoom = rand() < 0.25;
      const access = inRoom ? accessOf("a", ROOM_THREAD) : accessOf("a", "thread-a");
      if (!inRoom && rand() < 0.35) roster.groups[0].memberIds = ["b"]; // A leaves the room after its access was minted
      // Which scopes bot A can reach, modelled from the fixture and NOT from assertMemoryAccess: its own, the team's, its
      // conversation, the room while it is a member, bot B's when granted, not revoked and outside a room, never another conversation's.
      const reach = (scope: string) => scope === scopes.a || scope === scopes.team || scope === scopes.conv ? true : scope === scopes.room ? roster.groups[0].memberIds.includes("a") : scope === scopes.b ? grant < 0.5 && !inRoom : false;
      const all = Object.values(scopes), reachable = all.filter(reach);
      // the model is checked against the production rule here once, and the oracle below uses only the model
      for (const [name, scope] of Object.entries(scopes)) expect({ trial, name, inRoom, grant, left: !roster.groups[0].memberIds.includes("a"), model: reach(scope) }).toEqual({ trial, name, inRoom, grant, left: !roster.groups[0].memberIds.includes("a"), model: scopeOk(access, scope) });
      // Sources, in any scope: some retired, deleted or edited since (two revisions), some forgotten, some failed tools.
      type Src = { scope: string; state: string; texts: string[]; tomb: null | "all" | number; failed: boolean };
      const sources = new Map<string, Src>();
      for (let n = 0; n < 8; n++) {
        const id = `s${trial}-${n}`, texts = rand() < 0.3 ? ["harbour lantern first words", "harbour lantern"] : ["harbour lantern source words"];
        const src: Src = { scope: pick(all), state: rand() < 0.8 ? "active" : pick(["retired", "deleted"]), texts, tomb: null, failed: rand() < 0.2 };
        source(id, src.scope, { texts, state: src.state, ...src.failed ? { kind: "tool-outcome", speaker: "tool", outcome: "failed" } : {} });
        if (rand() < 0.12) { src.tomb = rand() < 0.5 ? "all" : texts.length; tombstone("source", id, src.tomb === "all" ? null : src.tomb); }
        sources.set(id, src);
      }
      type Rec = { scope: string; kind: string; assertion: string; state: string; identity: boolean; parents: string[]; evidence: Array<{ source: string; revision: number; start: number; end: number }>; forgotten: boolean };
      const records = new Map<string, Rec>();
      for (let n = 0; n < RECORDS; n++) {
        const id = `r${trial}-${n}`;
        const rec: Rec = { scope: pick(reachable), kind: pick(["fact", "character-canon", "preference"]), assertion: rand() < 0.35 ? "owner-statement" : "tool-observation", identity: rand() < 0.3,
          state: rand() < 0.75 ? "active" : pick(["archived", "superseded", "candidate"]), parents: [], evidence: [], forgotten: false };
        record(id, rec.scope, { kind: rec.kind, identity: rec.identity, state: rec.state, assertion: rec.assertion });
        for (let e = Math.floor(rand() * 3); e > 0; e--) {
          const sid = pick([...sources.keys()]), src = sources.get(sid)!, revision = 1 + Math.floor(rand() * src.texts.length), length = Buffer.byteLength(src.texts[revision - 1]);
          const roll = rand(), [start, end] = roll < 0.08 ? [2, 2] : roll < 0.16 ? [0, length + 1 + Math.floor(rand() * 8)] : [0, 1 + Math.floor(rand() * length)];
          if (rec.evidence.some(handle => handle.source === sid && handle.revision === revision && handle.start === start)) continue;
          evidence(id, sid, revision, start, end); rec.evidence.push({ source: sid, revision, start, end });
        }
        for (const parent of records.keys()) if (rand() < 0.15) { derive(parent, id); rec.parents.push(parent); }
        records.set(id, rec);
      }
      for (const [id, rec] of records) {
        const roll = rand();
        if (roll < 0.1) { rec.state = "archived"; database().prepare("UPDATE memory_records SET state='archived' WHERE id=?").run(id); }
        else if (roll < 0.17) { rec.state = "deleted"; rec.forgotten = true; forget(id); }
      }
      // The oracle, written from the model above and not from readable.ts.
      const fault = (id: string, mode: "current" | "historical"): string | null => {
        const rec = records.get(id)!;
        if (rec.forgotten) return "forgotten";
        if (!(mode === "current" ? ["active"] : ["active", "archived", "superseded"]).includes(rec.state)) return "state";
        const seen = new Set<string>(), walk = [...rec.parents];
        while (walk.length) {
          const parentId = walk.pop()!, parent = records.get(parentId)!;
          if (seen.has(parentId)) continue; seen.add(parentId);
          if (parent.forgotten) return "forgotten-ancestor";
          // a parent forgotten by what it rests on (a deleted or tombstoned source) takes what was derived from it (1.0.2 revoke-bounded r3)
          for (const handle of parent.evidence) { const src = sources.get(handle.source)!; if (src.tomb === "all" || src.tomb === handle.revision || src.state === "deleted") return "forgotten-ancestor"; }
          if (!(mode === "current" ? ["active", "candidate"] : ["active", "candidate", "archived", "superseded"]).includes(parent.state)) return "ancestor-state";
          walk.push(...parent.parents);
        }
        if (rec.identity && !(rec.scope === scopes.a || rec.scope === scopes.conv) || rec.identity && inRoom) return "identity";
        if (!rec.evidence.length && rec.assertion !== "owner-statement") return "no-evidence";
        for (const handle of rec.evidence) {
          const src = sources.get(handle.source)!;
          if (src.tomb === "all" || src.tomb === handle.revision) return "source-tombstone";
          if (mode === "current" ? src.state !== "active" || src.texts.length !== handle.revision : src.state === "deleted") return "source-state";
          if (src.failed && rec.kind === "fact") return "failed-tool";
          if (!reach(src.scope)) return "evidence-scope";
          if (handle.end <= handle.start || handle.end > Buffer.byteLength(src.texts[handle.revision - 1])) return "span";
        }
        return null;
      };
      const ids = [...records.keys()];
      const paths = await fivePaths(access, ids);
      for (const id of ids) {
        const got = await memoryGet(access, id), current = fault(id, "current"), history = fault(id, "historical");
        // memory_get is right (against the oracle), and every current path agrees with memory_get
        expect({ trial, id, get: got === true }).toEqual({ trial, id, get: current === null });
        for (const path of ["helper", "word", "recent", "keyword"] as const) expect({ trial, id, path, found: paths[path].has(id) }).toEqual({ trial, id, path, found: got === true });
        // historical: what memory_get allows, plus history only; never a refusal that is not about history
        expect({ trial, id, path: "historical", found: paths.historical.has(id) }).toEqual({ trial, id, path: "historical", found: history === null });
        if (got === true) expect(paths.historical.has(id)).toBe(true);
        tally.checked++;
        if (got !== true) { tally.denied++; tally.faults[current!] = (tally.faults[current!] ?? 0) + 1; }
        if (got !== true && history === null) tally.historyOnly++;
      }
      // Whole responses, not id sets: a world that holds every record and a world that holds only what the oracle allows
      // must answer identically, scores, counts, coverage and cursors included.
      const text = (id: string) => `harbour lantern note ${id}`;
      database().exec("DELETE FROM memory_projection_receipts; INSERT INTO memory_projection_receipts SELECT id,version,0,'indexed','indexed',NULL FROM memory_records");
      const build = (name: string, keep: (id: string) => boolean) => {
        const index = new MemoryIndex(join(DATA_DIR, name));
        index.prepareModel("model");
        const entries = ids.filter(keep).map(id => ({ id, version: 1, scopeId: records.get(id)!.scope, text: text(id), deleted: false }));
        index.upsert(entries);
        entries.forEach(entry => { const angle = (ids.indexOf(entry.id) + 1) * 0.37; index.vector(entry, "model", 0, [Math.cos(angle), Math.sin(angle)]); });
        return index;
      };
      // Each world is asked with its own empty answer cache and its own counter: the cache key is (query, reader, revision), the
      // same for both worlds, so the second search used to be answered from the first one's cached answer (msearch review round
      // 4: two searches, one bridge invocation, and the comparison compared a response with itself).
      const executed = new Map<MemoryIndex, number>();
      const answer = async (index: MemoryIndex, historical: boolean) => {
        clearMemorySearchCache();
        const bridge: MemorySearchBridge = { search: async input => {
          executed.set(index, (executed.get(index) ?? 0) + 1);
          const eligibility = new MemoryEligibility(join(DATA_DIR, "messages.db"));
          try { const eligible = eligibility.read(input); const found = index.search(input.query, eligible.allowed, [1, 0], "model", input.limit); return { ...found, coverageComplete: found.vectorRows === eligible.allowed.length }; }
          finally { eligibility.close(); }
        } };
        const before = executed.get(index) ?? 0;
        const response = await searchMemory("harbour lantern note", access, bridge, { allowance: LineageAllowance.tool(1_000_000_000), lexical: null, caller: "tool", limit: 20, historical });
        expect({ trial, historical, executedThisSearch: (executed.get(index) ?? 0) - before }).toEqual({ trial, historical, executedThisSearch: 1 });
        return response;
      };
      const everything = build(`full-${trial}.db`, () => true);
      for (const historical of [false, true]) {
        const permitted = new Set(ids.filter(id => fault(id, historical ? "historical" : "current") === null));
        const reference = build(`reference-${trial}-${historical}.db`, id => permitted.has(id));
        const full = await answer(everything, historical), ref = await answer(reference, historical);
        // both worlds really ran the index search
        expect(executed.get(everything) ?? 0).toBeGreaterThan(0);
        expect(executed.get(reference) ?? 0).toBeGreaterThan(0);
        reference.close();
        expect({ trial, historical, response: full }).toEqual({ trial, historical, response: ref });
        expect(new Set(full.hits.map(hit => hit.id).filter(id => ids.includes(id)))).toEqual(permitted);
        tally.compared++; if (full.hits.length) tally.comparedNonEmpty++;
      }
      everything.close();
      // Revoking the reader (policy revision) ends both: nothing is searched and nothing is read.
      if (rand() < 0.2) {
        database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
        await expect(searchMemory("harbour lantern note", access, plainBridge(ids.map(id => ({ id, version: 1, score: 1 }))), { allowance: LineageAllowance.tool(1_000_000_000), lexical: null, caller: "tool" })).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
        expect(await memoryGet(access, ids[0])).toBe("MEMORY_CONTEXT_REVOKED");
        tally.revoked++;
      }
    }
    console.log(`[msearch] property: ${JSON.stringify(tally)}`);
    expect(tally.checked).toBe(TRIALS * RECORDS);
    expect(tally.denied).toBeGreaterThan(300);
    expect(tally.historyOnly).toBeGreaterThan(20);
    expect(tally.revoked).toBeGreaterThan(5);
    expect(tally.compared).toBe(TRIALS * 2);
    expect(tally.comparedNonEmpty).toBeGreaterThan(TRIALS);
    // the generator reaches every refusal it is meant to compare
    for (const reason of ["forgotten", "state", "forgotten-ancestor", "ancestor-state", "identity", "no-evidence", "source-tombstone", "source-state", "failed-tool", "evidence-scope", "span"]) expect({ reason, n: tally.faults[reason] ?? 0 }).not.toEqual({ reason, n: 0 });
  });
});

describe("bounded keyword fallback", () => {
  // The same tables and index the authority database has, in memory: four million rows through its triggers would
  // take minutes; the scan only reads memory_records (through memory_records_scope), memory_evidence and memory_sources.
  function authority(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE memory_records (id TEXT NOT NULL, version INTEGER NOT NULL, scope_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, assertion TEXT NOT NULL,
        state TEXT NOT NULL, owner_pinned INTEGER NOT NULL DEFAULT 0, valid_from INTEGER NOT NULL, valid_to INTEGER, supersedes_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(id,version));
      CREATE INDEX memory_records_scope ON memory_records(scope_id,state);
      CREATE TABLE memory_sources (id TEXT PRIMARY KEY, state TEXT NOT NULL, revision INTEGER NOT NULL, thread_id TEXT, scope_id TEXT, kind TEXT);
      CREATE TABLE memory_evidence (record_id TEXT NOT NULL, record_version INTEGER NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL, start_byte INTEGER, end_byte INTEGER);
      -- what the deny predicate reads (deny.ts, 1.0.2 revoke-bounded r3)
      CREATE TABLE memory_deny (kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE branch_change(thread_id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT NOT NULL, leave_at TEXT, join_at TEXT, leave_done INTEGER NOT NULL DEFAULT 0, join_done INTEGER NOT NULL DEFAULT 0, all_cursor TEXT) WITHOUT ROWID;
      CREATE TABLE memory_source_versions (source_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(source_id,revision));
      CREATE TABLE memory_tombstones (target_type TEXT NOT NULL, target_id TEXT NOT NULL, revision INTEGER);`);
    return db;
  }

  it("P1: four million PIP rows newer than the reader's notes: the scan stops at its row cap within its budget, yielding between slices", async () => {
    const db = authority();
    db.prepare("INSERT INTO memory_records VALUES('old-match',1,'s','fact','harbour lantern oil','owner-statement','active',0,0,NULL,NULL,0)").run();
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4000000)
      INSERT INTO memory_records SELECT 'episode-'||i,1,'s','episode','an episode the owner lived','assistant-inference','active',0,0,NULL,NULL,0 FROM n`);
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_records").get()!.n)).toBe(4_000_001);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT r.rowid FROM memory_records r INDEXED BY memory_records_scope WHERE r.scope_id=? AND r.state='active' AND r.rowid<? ORDER BY r.rowid DESC LIMIT ?").all("s", 1e15, 512).map(row => String(row.detail)).join(" | ");
    expect(plan).not.toMatch(/TEMP B-TREE/);
    // The longest stretch the event loop was held, measured by a tick that re-arms itself.
    let last = performance.now(), longest = 0, ticks = 0, live = true;
    const tick = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; ticks++; if (live) setImmediate(tick); };
    setImmediate(tick);
    const started = performance.now();
    const scan = await keywordScan(db as never, "harbour lantern", ["s"]);
    const elapsed = performance.now() - started;
    live = false;
    expect(scan.complete).toBe(false);
    expect(scan.visited).toBeLessThanOrEqual(KEYWORD_FALLBACK_MAX_ROWS);
    expect(scan.slices).toBeGreaterThan(1);
    expect(elapsed).toBeLessThan(KEYWORD_FALLBACK_BUDGET_MS + 50);
    expect(ticks).toBeGreaterThanOrEqual(scan.slices - 1);
    expect(longest).toBeLessThan(100);
    console.log(`[msearch] keyword fallback at 4M PIP rows: visited=${scan.visited} slices=${scan.slices} ms=${elapsed.toFixed(1)} longest-hold=${longest.toFixed(1)}`);
    // Within the cap, the scan still finds what it should: a match among the newest rows.
    db.prepare("INSERT INTO memory_records VALUES('new-match',1,'s','fact','harbour lantern wick','owner-statement','active',0,0,NULL,NULL,0)").run();
    expect((await keywordScan(db as never, "harbour lantern", ["s"])).hits.map(hit => hit.id)).toEqual(["new-match"]);
    db.close();
  }, 3_600_000);

  it("a time budget ends the scan between slices, and the slice size is the unit of work", async () => {
    const db = authority();
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000)
      INSERT INTO memory_records SELECT 'f-'||i,1,'s','fact','plain words '||i,'owner-statement','active',0,0,NULL,NULL,0 FROM n`);
    const none = await keywordScan(db as never, "plain", ["s"], { budgetMs: 0 });
    expect([none.visited, none.complete]).toEqual([0, false]);
    const all = await keywordScan(db as never, "plain", ["s"]);
    expect(all.slices).toBeGreaterThanOrEqual(Math.ceil(4000 / KEYWORD_FALLBACK_SLICE));
    expect(all.hits).toHaveLength(50);
    expect(db.prepare(`SELECT count(*) AS n FROM memory_records r WHERE ${CURRENT_MEMORY}`).get()!.n).toBe(5000);
    db.close();
  });

  it("round 2 P2: the byte cap holds per row as it is read, never past 8 MiB, and a row that would pass it is not read", async () => {
    const db = authority(), text = `harbour lantern ${"x".repeat(4096 - 16)}`;
    expect(Buffer.byteLength(text)).toBe(4096);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4000)
      INSERT INTO memory_records SELECT 'big-'||i,1,'s','fact','${text}','owner-statement','active',0,0,NULL,NULL,0 FROM n`);
    const scan = await keywordScan(db as never, "harbour lantern", ["s"]);
    expect(scan.complete).toBe(false);
    expect(scan.bytes).toBeLessThanOrEqual(KEYWORD_FALLBACK_MAX_BYTES);
    expect(scan.bytes).toBeGreaterThan(KEYWORD_FALLBACK_MAX_BYTES - 4096);
    console.log(`[msearch] keyword fallback byte cap: bytes=${scan.bytes} cap=${KEYWORD_FALLBACK_MAX_BYTES} visited=${scan.visited} slices=${scan.slices}`);
    // one row larger than the whole cap: the scan stops before reading its text
    db.prepare("INSERT INTO memory_records VALUES('huge',1,'s','fact',?,'owner-statement','active',0,0,NULL,NULL,0)").run(`harbour lantern ${"y".repeat(KEYWORD_FALLBACK_MAX_BYTES)}`);
    const huge = await keywordScan(db as never, "harbour lantern", ["s"]);
    expect([huge.bytes, huge.hits.length, huge.complete]).toEqual([0, 0, false]);
    db.close();
  }, 3_600_000);

  it("P1: hydration has no exempt hits: a tool search that starts past its hydration limit answers empty and partial", async () => {
    const aScope = ensureScope("bot", "a");
    const hits = [record("late-1", aScope), record("late-2", aScope)];
    const stalled: MemorySearchBridge = { search: async () => { const end = performance.now() + 3600; while (performance.now() < end) { /* a stalled event loop */ } return { hits, vectorRows: 2, coverageComplete: true }; } };
    const result = await searchMemory("harbour lantern note", accessOf("a", "thread-a"), stalled, { allowance: LineageAllowance.tool(1_000_000_000), lexical: null, caller: "tool" });
    expect(result.hits).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.degradedReason).toBe("MEMORY_RECALL_UNAVAILABLE");
  }, 3_600_000);
});

describe("old checkpoint versions leave the word index", () => {
  it("P2: a rolled checkpoint version projects as deleted; one archived with no successor stays for historical search", () => {
    const scope = ensureScope("bot", "a"), db = database();
    const add = (id: string, version: number, kind: string, state: string) => {
      db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,'assistant-inference',?,0,0,NULL,NULL,0)").run(id, version, scope, kind, `${kind} ${id} ${version}`, state);
      db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending-archive','pending',NULL)").run(id, version);
    };
    add("checkpoint:rolling", 1, "checkpoint", "archived"); add("checkpoint:rolling", 2, "checkpoint", "active");
    add("checkpoint:ended", 1, "checkpoint", "archived"); add("fact-old", 1, "fact", "archived");
    const rows = Object.fromEntries(pendingProjectionRecords(db, 16).map(row => [`${row.id}:${row.version}`, { state: row.state, text: row.text }]));
    expect(rows["checkpoint:rolling:1"]).toEqual({ state: "deleted", text: "" });
    expect(rows["checkpoint:rolling:2"]?.state).toBe("active");
    expect(rows["checkpoint:ended:1"]?.state).toBe("archived");
    expect(rows["fact-old:1"]?.state).toBe("archived");
  });

  /** Runs the purge step by step to the end, as the helper does between queries. Step times on a shared disk include
   * its write stalls (a commit waiting 100-500 ms on a busy disk), so what is asserted is the work each step does and the
   * median time; the 95th percentile and the longest are printed (on tmpfs: every walk step under ~21 ms, every merge
   * step under ~26 ms). */
  function purgeAll(index: MemoryIndex) {
    const walk: number[] = [], merge: number[] = [];
    let removed = 0, examined = 0, maxExamined = 0;
    const started = performance.now();
    for (;;) {
      const at = performance.now(), step = index.purgeRolledCheckpoints(), ms = performance.now() - at;
      (step.merged ? merge : walk).push(ms);
      removed += step.removed; examined += step.examined; maxExamined = Math.max(maxExamined, step.examined);
      if (step.done) break;
    }
    const stat = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { n: values.length, p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, max: sorted.at(-1) ?? 0 }; };
    return { walk: stat(walk), merge: stat(merge), removed, examined, maxExamined, ms: performance.now() - started };
  }
  const fmt = (stat: { n: number; p50: number; p95: number; max: number }) => `${stat.n} steps p50=${stat.p50.toFixed(1)} p95=${stat.p95.toFixed(1)} max=${stat.max.toFixed(1)}ms`;
  function seedIndex(path: string, sql: string) {
    new MemoryIndex(path).close();
    const raw = new DatabaseSync(path);
    raw.exec("BEGIN");
    raw.exec(sql);
    raw.exec("INSERT INTO entries VALUES('fact-1',1,'s','The quarterly launch review is on Friday at ten.')");
    raw.exec("INSERT INTO lexical(id,version,text) SELECT id,version,text FROM entries ORDER BY id,version");
    raw.exec("INSERT INTO lexical_keys SELECT id,CAST(version AS INTEGER),rowid FROM lexical");
    raw.exec("COMMIT");
    return raw;
  }

  it("P2: an index holding 500,000 versions of one checkpoint is purged in short steps, merged in short steps, then the word query is fast and current", { tags: ["perf-budget"], timeout: 3_600_000 }, () => {
    const scope = "s", path = join(DATA_DIR, "memory-index.db"), versions = 500_000;
    const raw = seedIndex(path, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${versions})
      INSERT INTO entries SELECT 'checkpoint:long',i,'${scope}','Working evidence: the launch review status, version '||i FROM n`);
    const timeQuery = (db: DatabaseSync) => { const started = performance.now(); db.prepare(RECALL_SEARCH_SQL).all("\"launch\" OR \"review\"", JSON.stringify([scope]), RECALL_FIRST_PAGE + 1, 0); return performance.now() - started; };
    const before = timeQuery(raw);
    raw.close();
    const index = new MemoryIndex(path);
    const run = purgeAll(index);
    index.close();
    console.log(`[msearch] purge 500k versions: removed=${run.removed}; walk ${fmt(run.walk)}; merge ${fmt(run.merge)}; total ${run.ms.toFixed(0)}ms`);
    expect(run.removed).toBe(versions - 1);
    expect(run.maxExamined).toBeLessThanOrEqual(2048);
    // the merge is many short steps, not one call at the end
    expect(run.merge.n).toBeGreaterThan(50);
    expect(run.walk.p50).toBeLessThan(20);
    expect(run.merge.p50).toBeLessThan(20);
    const after = new DatabaseSync(path);
    expect(after.prepare("SELECT id,version FROM entries ORDER BY id").all().map(row => `${row.id}:${row.version}`)).toEqual([`checkpoint:long:${versions}`, "fact-1:1"]);
    const query = timeQuery(after);
    after.close();
    const page = lexicalPage("launch review", [scope], RECALL_FIRST_PAGE)!;
    expect(page.hits.map(hit => `${hit.id}:${hit.version}`).sort()).toEqual([`checkpoint:long:${versions}`, "fact-1:1"]);
    expect(query).toBeLessThan(50);
    console.log(`[msearch] 500k checkpoint versions: query before=${before.toFixed(1)}ms after=${query.toFixed(1)}ms`);
  });

  it("round 2 P2: 500,000 sole checkpoints: every step examines a bounded number of entries and none is removed", () => {
    const path = join(DATA_DIR, "memory-index.db"), count = 500_000;
    seedIndex(path, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${count})
      INSERT INTO entries SELECT 'checkpoint:thread-'||i,1,'s','Working evidence: thread '||i FROM n`).close();
    const index = new MemoryIndex(path);
    const run = purgeAll(index);
    // a later pass starts again from the beginning, bounded the same way
    const again = index.purgeRolledCheckpoints();
    index.close();
    console.log(`[msearch] purge 500k sole checkpoints: examined=${run.examined} removed=${run.removed}; walk ${fmt(run.walk)}; total ${run.ms.toFixed(0)}ms`);
    expect(run.removed).toBe(0);
    expect(run.merge.n).toBe(0);
    expect(run.examined).toBe(count);
    expect(run.maxExamined).toBeLessThanOrEqual(2048);
    expect(run.walk.n).toBeGreaterThan(count / 2048);
    expect(run.walk.p50).toBeLessThan(20);
    expect(again.examined).toBeLessThanOrEqual(2048);
  }, 3_600_000);
});

describe("index acknowledgements are fenced against the record's current state", () => {
  it("round 2 P2: 205 rollovers each landing before their late ack: no rolled version is marked indexed, every one stays owed for removal", async () => {
    const scope = ensureScope("bot", "a"), db = database(), id = "checkpoint:thread-a", rounds = 205;
    const controller = new MemoryWorkerController();
    const internals = controller as unknown as { child: unknown; ready: boolean; indexing: boolean; indexRequestId: string | null; onWorkerMessage(child: unknown, message: unknown): void };
    const sent: Array<{ type: string; requestId?: string }> = [];
    internals.child = { kill() {}, on() {}, send: (message: { type: string; requestId?: string }) => { sent.push(message); } };
    internals.ready = true;
    const settle = () => new Promise<void>(resolve => setTimeout(resolve, 5));
    const add = (version: number) => {
      db.prepare("INSERT INTO memory_records VALUES(?,?,?,'checkpoint',?,'assistant-inference','active',0,0,NULL,NULL,0)").run(id, version, scope, `checkpoint ${version}`);
      db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL)").run(id, version);
    };
    try {
      add(1);
      for (let version = 1; version <= rounds; version++) {
        // the batch is sent while this version is current...
        internals.indexing = true; internals.indexRequestId = `req-${version}`;
        (controller as unknown as { indexSent: Map<string, string> }).indexSent = new Map([[`${id}\u0000${version}`, "active"]]);
        // ...the thread captures again before the helper answers: the checkpoint rolls over
        add(version + 1);
        db.prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(id, version);
        db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending-archive' WHERE record_id=? AND record_version=?").run(id, version);
        // ...and the acknowledgement lands late
        internals.onWorkerMessage(internals.child, { type: "index-result", requestId: `req-${version}`, records: [{ id, version, deleted: false }], embeddingStatus: "indexed" });
        await settle();
      }
      const status = (where: string) => Number(db.prepare(`SELECT count(*) AS n FROM memory_projection_receipts p JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version WHERE ${where}`).get()!.n);
      expect(status("r.state='archived' AND p.lexical_status='indexed'")).toBe(0);
      expect(status("r.state='archived' AND p.lexical_status='pending-archive'")).toBe(rounds);
      // every rolled version is projected as a removal
      const owed = pendingProjectionRecords(db, 1000).filter(row => row.state === "deleted");
      expect(owed).toHaveLength(rounds);
      // an ack that did not race still lands
      const last = rounds + 1;
      internals.indexing = true; internals.indexRequestId = "req-last";
      (controller as unknown as { indexSent: Map<string, string> }).indexSent = new Map([[`${id}\u0000${last}`, "active"]]);
      internals.onWorkerMessage(internals.child, { type: "index-result", requestId: "req-last", records: [{ id, version: last, deleted: false }], embeddingStatus: "indexed" });
      await settle();
      expect(db.prepare("SELECT lexical_status FROM memory_projection_receipts WHERE record_id=? AND record_version=?").get(id, last)?.lexical_status).toBe("indexed");
    } finally { await controller.stop().catch(() => {}); }
  }, 3_600_000);
});

describe("memory_save held for the owner", () => {
  it("says it is held, that search will not return it yet, and why; an active save says nothing of the kind", async () => {
    const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] };
    setMemoryCaptureRoster(() => roster); reconcileMemoryRoster(roster); setMemoryMode("capture");
    appendMessage("thread", { id: "m", at: 1, role: "user", origin: "desktop", kind: "text", text: "Verified source note" });
    const work = claimMemoryJob("fixture")!; publishMemoryWork(work, "fixture", captureWork(work));
    setMemoryMode("active");
    const registry = new InternalCapabilities(); registry.begin("bot", "thread", "generation");
    const token = registry.mint({ botId: "bot", threadId: "thread", generation: "generation", depth: 99, kind: "memory", skillAuthoring: false });
    const context = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
    const bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
    const evidence = [{ sourceId: work.sourceId, revision: 1, startByte: 0, endByte: Buffer.byteLength(work.text) }];
    const held = await memoryAgentRoute("/api/internal/memory/save", { text: "Candidate", evidence, idempotencyKey: "held" }, context, bridge) as { state: string; pendingReview: boolean; note?: string };
    expect(held).toMatchObject({ state: "candidate", pendingReview: true });
    expect(held.note).toMatch(/^Saved for the owner's review in Needs you\. It is not active yet, so memory_search will not return it until the owner approves it\. Reason: [^.].*[^.]\.$/);
    expect(held.note).not.toMatch(/[—–]|\.\./);
    const active = await memoryAgentRoute("/api/internal/memory/save", { text: "Verified source note", evidence, idempotencyKey: "grounded", claimType: "owner-statement" }, context, bridge) as { state: string; note?: string };
    expect(active.state).toBe("active");
    expect(active.note).toBeUndefined();
  });
});
