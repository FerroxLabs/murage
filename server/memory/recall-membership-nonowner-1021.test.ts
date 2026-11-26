// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1021 RECALLWALK: the 1020 owner fix (recall-membership-bounded-1020.test.ts) left every other principal walking every
// memory_scope_bindings row (and every memory_scopes row) per recall-view build, 64 rows a page. On 50k bindings that is ~800 statements
// per view, and the construction budget (4 KiB charged per row read) refuses the view outright. A linked person's view now reads the
// threads it names, the human-thread candidates and the grants to that person, each by index, and answers exactly as the walk did
// (the legacy oracle legacyRecallScopes, and personReadableScopes for S(P)).
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { resetDataRootsForTest } from "../data-roots.ts";
import type { HumanPrincipal } from "../human-principals.ts";
import { ensureScope, legacyRecallScopes, personReadableScopes, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { ConstructionBudget } from "./recall-construction.ts";
import { recallMembershipSteps } from "./recall-membership.ts";
import { RECALL_BUILD_SLICE } from "./recall-view.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetDataRootsForTest(); });
afterEach(() => { vi.restoreAllMocks(); });

const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: "reader", threadId: "reader-thread", section: "agency", tasks: [{ threadId: "reader-thread" }, { threadId: "reader-task" }] }, { id: "other", threadId: "other-thread", section: "agency" }], groups: [{ id: "room", threadId: "room-thread", memberIds: ["reader", "other"] }] };
const person: HumanPrincipal = { personId: "fixture-person", bindingId: "human-binding:fixture", revision: 1 };
const stranger: HumanPrincipal = { personId: "fixture-stranger", bindingId: "human-binding:stranger", revision: 1 };
const binding = { botId: "reader", threadId: "reader-thread", humanPrincipal: person, notOwnerAudience: false };

const insert = (id: string, scope: string, type: string, subject: string, state = "granted", intent = "{}") =>
  database().prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES(?,?,?,?,1,?,?)").run(id, scope, type, subject, state, intent);
const bindThread = (thread: string, principal: unknown) => insert("human-thread:" + thread, ensureScope("conversation", thread), "human-thread", thread, "granted", JSON.stringify(principal));

/** One construction, the binding/scope statements it ran and the rows they returned (bindings counted on their own too). */
function measure(onBindingRead?: (rows: number) => void) {
  let statements = 0, rows = 0, bindingRows = 0; const db = database(), prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    const s = prepare(sql), bindingTable = sql.includes("FROM memory_scope_bindings");
    if (bindingTable || /FROM memory_scopes\b/.test(sql)) {
      for (const name of ["all", "get"] as const) { const original = s[name].bind(s) as (...a: never[]) => unknown;
        (s as unknown as Record<string, unknown>)[name] = (...a: never[]) => {
          statements++;
          const out = original(...a), n = Array.isArray(out) ? out.length : out ? 1 : 0;
          rows += n;
          if (bindingTable) { bindingRows += n; onBindingRead?.(n); }
          return out;
        };
      }
    }
    return s;
  });
  try {
    const steps = recallMembershipSteps(db, binding, roster, new ConstructionBudget());
    for (;;) { const next = steps.next(); if (next.done) return { statements, rows, bindingRows, result: next.value }; }
  } finally { spy.mockRestore(); }
}
const scopeOwnerIndex = () => !!database().prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='memory_scopes_owner'").get();
/** A file whose memory_scopes_owner is not built yet (schema.ts ensureScopeOwnerIndex makes it after listen): the person scopes are walked. */
const withoutScopeOwnerIndex = () => { database().exec("DROP INDEX IF EXISTS memory_scopes_owner"); expect(scopeOwnerIndex()).toBe(false); };
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** The person's own world: the view's thread bound to them, a lineage-only thread of theirs outside the roster, a room grant, plus the
 * near misses (another person's thread, a bot-kind grant, a revoked grant, a personId of another JSON type). */
function seedPersonWorld() {
  reconcileMemoryRoster(roster); setMemoryMode("active");
  const preferences = ensureScope("preferences", "person:" + person.personId);
  const link = { id: person.bindingId, origin: { platform: "whatsapp", connectionId: "fixture", authorityId: "fixture", userId: "fixture" }, personId: person.personId, revision: 1, active: true };
  insert(person.bindingId, preferences, "human-binding", person.bindingId, "granted", JSON.stringify(link));
  bindThread("reader-thread", person);
  bindThread("reader-task", person);
  bindThread("person-elsewhere", person);
  bindThread("stranger-thread", stranger);
  bindThread("numeric-person", { ...person, personId: 7 });
  const grants = { room: ensureScope("room", "shared-room"), project: ensureScope("project", "shared-project"), bot: ensureScope("bot", "other"), revoked: ensureScope("team", "withdrawn"), theirs: ensureScope("project", "stranger-project") };
  insert("g-room", grants.room, "person", person.personId);
  insert("g-project", grants.project, "person", person.personId);
  insert("g-bot", grants.bot, "person", person.personId);
  insert("g-revoked", grants.revoked, "person", person.personId, "revoked");
  insert("g-theirs", grants.theirs, "person", stranger.personId);
  return grants;
}
/** 50,000 system, pip, checkpoint and grant bindings that name nothing this view names. */
function seedNoise(total = 50_000) {
  const db = database(), scope = ensureScope("workspace", "noise");
  db.exec("BEGIN");
  try {
    for (let n = 0; n < total; n++) {
      const kind = n % 10;
      if (kind < 6) insert(`pip-reflect:${n}`, scope, "system", `noise-${n}`);
      else if (kind === 6) insert(`checkpoint:${n}`, scope, "system", "checkpoint-pending");
      else if (kind === 7) insert(`grant-bot:${n}`, scope, "bot", `noise-bot-${n}`);
      else if (kind === 8) insert(`grant-person:${n}`, scope, "person", `noise-person-${n}`);
      else insert(`grant-room:${n}`, scope, "room", `noise-room-${n}`, "revoked");
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

it("W-N1: a linked person's view reads a bounded number of rows by index when memory_scope_bindings holds 50,000 unrelated rows", () => {
  seedPersonWorld();
  expect(scopeOwnerIndex()).toBe(true);
  const small = measure();
  seedNoise();
  const started = performance.now();
  const large = measure();
  const ms = performance.now() - started;
  expect(large.result).toEqual(small.result);
  expect(large.statements).toBe(small.statements);
  expect(large.rows).toBe(small.rows);
  expect(large.statements).toBeLessThanOrEqual(40);
  expect(large.rows).toBeLessThanOrEqual(40);
  expect(ms).toBeLessThan(2_000);
});

it("W-N1b: without memory_scopes_owner the person scopes are walked, but the binding reads stay bounded on 50,000 rows", () => {
  seedPersonWorld(); withoutScopeOwnerIndex();
  const small = measure();
  seedNoise();
  const large = measure();
  expect(large.result).toEqual(small.result);
  expect(large.bindingRows).toBe(small.bindingRows);
  expect(large.bindingRows).toBeLessThanOrEqual(20);
});

it("W-A1: 50,000 other people's threads are classified in bounded recall slices", () => {
  seedPersonWorld();
  const small = measure().result;
  const db = database(), scope = ensureScope("conversation", "duplicate-thread");
  const add = db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'human-thread',?,1,'granted',?)");
  const duplicateRows = 70;
  const foreignIntents = [JSON.stringify(stranger), JSON.stringify({ ...stranger, personId: "fixture-other" })];
  db.exec("BEGIN");
  try {
    for (let n = 0; n < 50_000 + duplicateRows; n++) {
      const thread = n < duplicateRows ? "duplicate-thread" : `history-${n}`;
      add.run(`history-${n}`, scope, thread, foreignIntents[n % foreignIntents.length]);
    }
    bindThread("duplicate-thread", person);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }

  // Count SQLite's predicate/projection evaluations even when the statement returns no matching rows.
  const native = new DatabaseSync(":memory:");
  const extract = native.prepare("SELECT json_extract(?, ?) AS value");
  let visited = 0, maxSlice = 0;
  db.function("json_extract", (value, path) => {
    if (path === "$.personId") visited++;
    return extract.get(value, path)!.value;
  });
  try {
    const steps = recallMembershipSteps(db, binding, roster);
    for (;;) {
      const before = visited;
      let next = steps.next();
      for (let n = 1; n < RECALL_BUILD_SLICE && !next.done; n++) next = steps.next();
      maxSlice = Math.max(maxSlice, visited - before);
      if (next.done) {
        expect(next.value).toEqual({
          ...small,
          lineage: sorted([...small.lineage, scope]),
          personScopes: new Set([...small.personScopes, scope]),
        });
        break;
      }
    }
    expect(visited).toBeGreaterThanOrEqual(50_000 + duplicateRows);
    // A statement may materialize its 64-row page before the first row yields.
    expect(maxSlice).toBeLessThanOrEqual(RECALL_BUILD_SLICE + 64);
  } finally {
    closeDatabase();
    native.close();
  }
});

it("W-A2: a large person grant set refuses through the budget after bounded reads", () => {
  seedPersonWorld();
  const db = database();
  db.exec(`WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<33000)
    INSERT INTO memory_scopes SELECT 'bulk-scope-'||n,'workspace','bulk-owner-'||n,'{}',1 FROM rows`);
  db.prepare(`INSERT INTO memory_scope_bindings
    SELECT 'grant-'||id,id,'person',?,1,'granted','{}' FROM memory_scopes WHERE id GLOB 'bulk-scope-*'`)
    .run(person.personId);
  let maxRead = 0, totalRead = 0;
  expect(() => measure(rows => { maxRead = Math.max(maxRead, rows); totalRead += rows; }))
    .toThrow("MEMORY_RECALL_STORAGE_LIMIT");
  expect(maxRead).toBeLessThanOrEqual(64);
  expect(totalRead).toBeGreaterThan(64);
  expect(totalRead).toBeLessThan(33_000);
});

it.each([["with", true], ["without", false]] as const)("W-N2 (%s memory_scopes_owner): the indexed read keeps the walk's answers for a linked person: own threads, S(P) lineage, grant kinds and near misses", (_label, index) => {
  const grants = seedPersonWorld();
  for (let n = 0; n < 70; n++) {
    bindThread(`person-thread-${n}`, person);
    insert(`withdrawn-${n}`, ensureScope("workspace", `withdrawn-${n}`), "person", person.personId, "revoked");
  }
  const lateGrant = ensureScope("project", "later-shared-project");
  insert("late-grant", lateGrant, "person", person.personId);
  if (!index) withoutScopeOwnerIndex();
  expect(scopeOwnerIndex()).toBe(index);
  seedNoise(2_000);
  const { result } = measure();
  // the legacy oracle (every binding read in full) for the view's scopes, personReadableScopes for S(P)
  expect(result.scopes).toEqual(sorted(legacyRecallScopes("reader", "reader-thread", roster, false, person)));
  const readable = personReadableScopes(database(), person);
  expect(readable).not.toBe("unknown");
  expect(sorted(result.personScopes)).toEqual(sorted(readable as ReadonlySet<string>));
  expect(result.lineage).toEqual(sorted([...(readable as ReadonlySet<string>)].filter(scope => !result.scopes.includes(scope))));
  const conversation = (thread: string) => ensureScope("conversation", thread);
  expect(result.scopes).toContain(conversation("reader-thread"));
  expect(result.scopes).toContain(conversation("reader-task"));
  expect(result.lineage).toContain(conversation("person-elsewhere"));
  expect(result.scopes).toEqual(expect.arrayContaining([grants.room, grants.project, lateGrant, ensureScope("preferences", "person:" + person.personId)]));
  for (const denied of [grants.bot, grants.revoked, grants.theirs, conversation("stranger-thread"), conversation("numeric-person"), conversation("other-thread"), conversation("room-thread")]) {
    expect(result.scopes).not.toContain(denied);
    expect(result.lineage).not.toContain(denied);
  }
});

it("W-N3: a thread of the view bound to another person leaves it (sameAudience), read without the walk", () => {
  seedPersonWorld();
  insert("human-thread-relink:reader-task", ensureScope("conversation", "reader-task"), "human-thread", "reader-task", "granted", JSON.stringify(stranger));
  const { result } = measure();
  expect(result.scopes).toEqual(sorted(legacyRecallScopes("reader", "reader-thread", roster, false, person)));
  expect(result.scopes).not.toContain(ensureScope("conversation", "reader-task"));
});
