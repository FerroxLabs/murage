// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.16 memory screen, batch B1 (MEMORY-UI-BUILD-SPEC r3 sections 1 and 8): the list filters, pinned first, the payload, inspect, Learned
// today, Mode P, and the work bounds (keys examined per statement and per request) on dense, sparse and no-match cases at 3,000 and 30,000 rows.
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { OWNER_COUNT_CAP, OWNER_NEWEST_NOTICE, OWNER_PREPARING_NOTICE, OWNER_SLICE_ROWS, OWNER_TAIL_WINDOW, ownerSearchTrace, ownerSearchWork, recordChatSql } from "./owner-list.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { AGE_KEY_WINDOW, OWNER_SCOPE_KIND, OWNER_SCOPE_KIND_INDEX, RECORD_KEYS_BUILD, validateMemorySchema } from "./schema.ts";
import { OPTIONAL_INDEXES, optionalIndexReady } from "./optional-index.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

/** A made-up access key id, built at run time so the secret scan does not stop on the fixture. */
const FAKE_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";
const roster = {
  bots: [
    { id: "a", name: "Ada", threadId: "ta", tasks: [{ threadId: "ta", title: "Ideas", createdAt: 1 }, { threadId: "ta-trip", title: "Trip planning", createdAt: 2 }] },
    { id: "b", name: "Bo", threadId: "tb" },
  ],
  groups: [{ id: "g", name: "Crew", threadId: "tg", memberIds: ["a"] }],
};
type Row = { id: string; version: number; kind: string; createdAt?: number; ownerPinned: boolean; chat: { threadId: string; name: string | null } | null; bot: { id: string; name: string | null } | null; scopeKind: string | null };
type ListAnswer = { records: Row[]; nextCursor?: string; searchMode: string; searchNotice?: string; coverageComplete?: boolean; preparing?: boolean; matchCount?: number; matchCountLabel?: string };
const route = (body: unknown) => memoryOwnerRoute("/api/memory/action", body, ownerMemoryTicket(), roster as never);
const list = (body: Record<string, unknown>) => route({ action: "list", ...body }) as Promise<ListAnswer>;

beforeEach(() => {
  closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster as never);
  ownerSearchTrace.on = false; ownerSearchTrace.statements = []; ownerSearchTrace.times = [];
});

const insert = (db: DatabaseSync, id: string, scope: string, kind: string, at: number, extra: { text?: string; assertion?: string; state?: string; pinned?: number; version?: number } = {}) =>
  db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,?)").run(id, extra.version ?? 1, scope, kind, extra.text ?? `note ${id}`, extra.assertion ?? "owner-statement", extra.state ?? "active", extra.pinned ?? 0, at, at);
let sources = 0;
/** Evidence for a record: `count` rows from one source in `thread`, said by `speaker`. */
const evidence = (db: DatabaseSync, id: string, version: number, scope: string, thread: string, options: { speaker?: string; text?: string; count?: number; occurredAt?: number } = {}) => {
  const source = `src-${++sources}`, text = options.text ?? `words for ${id}`;
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,?,'text',?,'recorded',NULL,'active')").run(source, scope, thread, `m-${source}`, `h-${source}`, options.speaker ?? "owner");
  db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)").run(source, `h-${source}`, JSON.stringify({ text, ...(options.occurredAt ? { occurredAt: options.occurredAt } : {}) }));
  for (let n = 0; n < (options.count ?? 1); n++) db.prepare("INSERT INTO memory_evidence VALUES(?,?,?,1,?,?)").run(id, version, source, Math.min(n, text.length), text.length);
};

/** Work of one request: statements (distinct texts), rows per statement, keys examined in all. */
async function measured<T>(run: () => Promise<T>) {
  const before = ownerSearchWork.visited;
  ownerSearchTrace.statements = []; ownerSearchTrace.on = true;
  try {
    const answer = await run();
    const statements = ownerSearchTrace.statements.map(statement => ({ ...statement }));
    // `keys`: rows stepped by the key walk (statements on the key table); the rest of `visited` is the page's own row read (at most 50)
    const keys = statements.filter(s => s.sql.includes("memory_record_keys")).reduce((sum, s) => sum + (s.rows ?? 0), 0);
    return { answer, statements, visited: ownerSearchWork.visited - before, keys, texts: [...new Set(statements.map(s => s.sql))].sort(), widest: Math.max(0, ...statements.map(s => s.rows ?? 0)) };
  } finally { ownerSearchTrace.on = false; }
}

describe("filters", () => {
  it("lists by kind, assertion, chat, since, until and pin; refuses kinds and fields it does not list", async () => {
    const scope = ensureScope("bot", "a"), chatScope = ensureScope("conversation", "ta-trip");
    transaction(db => {
      insert(db, "fact-old", scope, "fact", 1000);
      insert(db, "fact-inferred", scope, "fact", 2000, { assertion: "assistant-inference" });
      insert(db, "relation", scope, "relation", 3000);
      insert(db, "concern", scope, "concern", 4000, { pinned: 1 });
      insert(db, "checkpoint", scope, "checkpoint", 5000);
      insert(db, "source-row", scope, "source", 6000);
      insert(db, "trip-fact", chatScope, "fact", 7000);
      evidence(db, "trip-fact", 1, chatScope, "ta-trip");
      evidence(db, "fact-old", 1, scope, "ta");
    });
    const ids = (answer: ListAnswer) => answer.records.map(row => row.id);
    // no kinds: the five default kinds, newest first, current only
    expect(ids(await list({ botId: "a" }))).toEqual(["trip-fact", "concern", "relation", "fact-inferred", "fact-old"]);
    expect(ids(await list({ botId: "a", kinds: ["checkpoint"] }))).toEqual(["checkpoint"]);
    expect(ids(await list({ botId: "a", kinds: ["fact"], assertion: "assistant-inference" }))).toEqual(["fact-inferred"]);
    expect(ids(await list({ botId: "a", threadId: "ta-trip" }))).toEqual(["trip-fact"]);
    expect(ids(await list({ botId: "a", threadId: "ta" }))).toEqual(["fact-old"]);
    expect(ids(await list({ botId: "a", since: 3000 }))).toEqual(["trip-fact", "concern", "relation"]);
    expect(ids(await list({ botId: "a", until: 3000 }))).toEqual(["fact-inferred", "fact-old"]);
    expect(ids(await list({ botId: "a", since: 2000, until: 4000 }))).toEqual(["relation", "fact-inferred"]);
    expect(ids(await list({ botId: "a", pinned: true }))).toEqual(["concern"]);
    expect(ids(await list({ botId: "a", pinned: false })).includes("concern")).toBe(false);
    // the same filters on a search (mode S: no index file)
    expect(ids(await list({ botId: "a", query: "note", kinds: ["fact"], assertion: "owner-statement" }))).toEqual(["trip-fact", "fact-old"]);
    expect(ids(await list({ botId: "a", query: "note", threadId: "ta-trip" }))).toEqual(["trip-fact"]);
    expect(ids(await list({ botId: "a", query: "note", until: 3000 }))).toEqual(["fact-inferred", "fact-old"]);
    expect(ids(await list({ botId: "a", query: "note", since: 4000 }))).toEqual(["trip-fact", "concern"]);
    // refused: a kind outside the list, tool-observation, a repeated kind, a topic (B6 adds it), a thread outside the roster
    for (const body of [{ kinds: ["source"] }, { kinds: ["continuity-brief"] }, { kinds: ["pip-proposal"] }, { kinds: ["fact", "fact"] }, { assertion: "tool-observation" }, { topic: "you" }, { threadId: "elsewhere" }, { kinds: [] }]) {
      await expect(list({ botId: "a", ...body })).rejects.toMatchObject({ message: "INVALID_MEMORY_ARGUMENTS", status: 400 });
    }
    // the old screen (it sends `view`) keeps its unfiltered list
    expect(ids(await list({ botId: "a", view: "search" }))).toContain("source-row");
  });

  it("puts pins first: 60 pins, pin 51 on page 2, then the rest; a 0-row page with a cursor carries on", async () => {
    const scope = ensureScope("bot", "a");
    transaction(db => {
      for (let n = 0; n < 60; n++) insert(db, `pin-${String(n).padStart(2, "0")}`, scope, "fact", 10_000 + n, { pinned: 1 });
      for (let n = 0; n < 10; n++) insert(db, `rest-${n}`, scope, "fact", 20_000 + n);
    });
    for (const withIndex of [false, true]) {
      if (withIndex) database().exec(OWNER_SCOPE_KIND.sql);
      const first = await list({ botId: "a", pinnedFirst: true });
      expect(first.records).toHaveLength(50);
      expect(first.records.every(row => row.ownerPinned)).toBe(true);
      expect(first.records[0].id).toBe("pin-59");
      const second = await list({ botId: "a", pinnedFirst: true, cursor: first.nextCursor });
      expect(second.records.map(row => row.id)).toEqual(Array.from({ length: 10 }, (_, n) => `pin-${String(9 - n).padStart(2, "0")}`));
      expect(JSON.parse(Buffer.from(second.nextCursor!, "base64url").toString())).toMatchObject({ p: "rest" });
      const third = await list({ botId: "a", pinnedFirst: true, cursor: second.nextCursor });
      expect(third.records.map(row => row.id)).toEqual(Array.from({ length: 10 }, (_, n) => `rest-${9 - n}`));
      expect(third.nextCursor).toBeUndefined();
    }
    // no pins at all: the pin phase answers 0 rows with a cursor, and the next page has the rest
    const other = ensureScope("bot", "b");
    transaction(db => { for (let n = 0; n < 3; n++) insert(db, `b-${n}`, other, "fact", 30_000 + n); });
    const empty = await list({ botId: "b", pinnedFirst: true });
    expect(empty.records).toEqual([]);
    expect(empty.nextCursor).toBeTruthy();
    expect((await list({ botId: "b", pinnedFirst: true, cursor: empty.nextCursor })).records.map(row => row.id)).toEqual(["b-2", "b-1", "b-0"]);
    // the same with scopes null (Settings): the pinned prefix, then the rest
    const all = await list({ pinnedFirst: true });
    expect(all.records.every(row => row.ownerPinned)).toBe(true);
  });

  it("dates: a key spilled past its window is in Older, not in Learned today; a backfill key far above its window is still found by until", async () => {
    const scope = ensureScope("bot", "a");
    const T = 5_000_000;
    // 2,049 records in one millisecond: the last one spills (rule 3) to T*2048, the base of the next millisecond's window
    transaction(db => {
      for (let n = 0; n < AGE_KEY_WINDOW + 1; n++) insert(db, `ms-${String(n).padStart(4, "0")}`, scope, "fact", T - 1);
      insert(db, "today", scope, "fact", T);
      insert(db, "ancient", scope, "fact", 5);
    });
    const spilled = database().prepare("SELECT record_id AS id FROM memory_record_keys WHERE age_key=?").get(T * AGE_KEY_WINDOW) as { id: string };
    expect(spilled.id).toBe(`ms-${String(AGE_KEY_WINDOW).padStart(4, "0")}`);
    const today = (await route({ action: "learned-today", since: T })) as { bots: Array<{ botId: string; count: number; label: string }> };
    expect(today.bots).toEqual([{ botId: "a", count: 1, label: "1" }]);
    expect((await list({ botId: "a", since: T })).records.map(row => row.id)).toEqual(["today"]);
    const older = await list({ botId: "a", until: T });
    expect(older.records[0].id).toBe(spilled.id);
    // a backfill-keyed row far above its own window (rule 3 unbounded above): `until` is never a key bound, so it is still found
    database().prepare("UPDATE memory_record_keys SET age_key=? WHERE record_id='ancient'").run((T + 10) * AGE_KEY_WINDOW);
    expect((await list({ botId: "a", until: 6 })).records.map(row => row.id)).toEqual(["ancient"]);
    expect((await list({ botId: "a", since: T + 5 })).records).toEqual([]);
  });
});

describe("payload and inspect", () => {
  it("adds chat, bot, createdAt and scope kind; a continuity row has no chat", async () => {
    const scope = ensureScope("bot", "a"), chatScope = ensureScope("conversation", "ta-trip"), group = ensureScope("conversation", "tg");
    transaction(db => {
      insert(db, "trip", chatScope, "fact", 100);
      evidence(db, "trip", 1, chatScope, "ta-trip");
      insert(db, "home", scope, "fact", 200);
      evidence(db, "home", 1, scope, "ta");
      insert(db, "plain", scope, "fact", 300);
      insert(db, "promise", scope, "commitment", 400);
      evidence(db, "promise", 1, scope, "ta");
      insert(db, "crew", group, "fact", 500);
      evidence(db, "crew", 1, group, "tg");
    });
    const rows = new Map((await list({})).records.map(row => [row.id, row]));
    expect(rows.get("trip")).toMatchObject({ createdAt: 100, chat: { threadId: "ta-trip", name: "Trip planning" }, bot: { id: "a", name: "Ada" }, scopeKind: "conversation" });
    // the home thread (no execution store here: the oldest task) reads Main chat
    expect(rows.get("home")).toMatchObject({ chat: { threadId: "ta", name: "Main chat" }, bot: { id: "a", name: "Ada" }, scopeKind: "bot" });
    expect(rows.get("plain")).toMatchObject({ chat: null, bot: { id: "a", name: "Ada" } });
    expect(rows.get("promise")).toMatchObject({ chat: null });
    expect(rows.get("crew")).toMatchObject({ chat: { threadId: "tg", name: "Crew" }, bot: null });
  });

  it("the chat filter and label read one evidence row and one source row per key, whatever the record rests on", async () => {
    const scope = ensureScope("bot", "a");
    transaction(db => { insert(db, "heavy", scope, "fact", 100); evidence(db, "heavy", 1, scope, "ta-trip", { count: 200, text: "x".repeat(400) }); });
    const plan = (database().prepare(`EXPLAIN QUERY PLAN SELECT ${recordChatSql("r")} FROM memory_records r WHERE r.id=? AND r.version=?`).all("heavy", 1) as Array<{ detail: string }>).map(row => row.detail);
    // the evidence primary key (an automatic index on this rowid table), searched by the record and walked backwards: no sort, LIMIT 1 stops it
    expect(plan.some(detail => /SEARCH e USING (PRIMARY KEY|(COVERING )?INDEX sqlite_autoindex_memory_evidence_1) \(record_id=\? AND record_version=\?\)/.test(detail))).toBe(true);
    expect(plan.some(detail => /TEMP B-TREE/.test(detail))).toBe(false);
    expect((await list({ botId: "a", threadId: "ta-trip" })).records.map(row => row.id)).toEqual(["heavy"]);
  });

  it("inspect: earlier versions, no tool rows, quotes redacted, and who said it", async () => {
    const scope = ensureScope("bot", "a");
    transaction(db => {
      insert(db, "fact", scope, "fact", 100, { text: "first words", state: "superseded" });
      db.prepare("UPDATE memory_records SET valid_to=150 WHERE id='fact' AND version=1").run();
      insert(db, "fact", scope, "fact", 200, { text: "second words", version: 2 });
      evidence(db, "fact", 2, scope, "ta", { speaker: "owner", text: `my key is ${FAKE_KEY} ok`, occurredAt: 1234 });
      evidence(db, "fact", 2, scope, "ta", { speaker: "tool", text: "tool output here" });
      evidence(db, "fact", 2, scope, "ta", { speaker: "person:rosa-binding", text: "Rosa said this" });
      evidence(db, "fact", 2, scope, "ta", { speaker: "person:stranger", text: "someone said this" });
      evidence(db, "fact", 2, scope, "ta", { speaker: "a", text: "Ada said this" });
      db.prepare("INSERT INTO memory_scope_bindings VALUES('rosa-binding',?,'human-binding','rosa-binding',0,'granted',?)").run(scope,
        JSON.stringify({ id: "rosa-binding", origin: { kind: "telegram" }, personId: null, revision: 1, active: true, display: { name: "Rosa" } }));
    });
    const inspected = await route({ action: "inspect", id: "fact", version: 2 }) as { earlier: Array<{ version: number; text: string; replacedAt: number | null }>; evidence: Array<Record<string, unknown>> };
    expect(inspected.earlier).toEqual([{ version: 1, text: "first words", replacedAt: 150 }]);
    const said = inspected.evidence.map(row => ({ who: row.who, name: row.name, text: row.text }));
    expect(said).toHaveLength(4);
    expect(said.find(row => String(row.text).startsWith("my key"))).toMatchObject({ who: "you" });
    expect(said.some(row => String(row.text).includes(FAKE_KEY))).toBe(false);
    expect(said.find(row => row.text === "Rosa said this")).toEqual({ who: "person", name: "Rosa", text: "Rosa said this" });
    expect(said.find(row => row.text === "someone said this")).toEqual({ who: "person", name: undefined, text: "someone said this" });
    expect(said.find(row => row.text === "Ada said this")).toMatchObject({ who: "bot", name: "Ada" });
    expect(inspected.evidence.find(row => String(row.text).startsWith("my key"))).toMatchObject({ at: 1234 });
    // the raw speaker id never leaves the server
    expect(JSON.stringify(inspected)).not.toContain("rosa-binding");
    expect(JSON.stringify(inspected)).not.toContain("stranger");
    expect(JSON.stringify(inspected)).not.toContain("tool output");
    // a forgotten record: no words, no earlier versions
    database().prepare("INSERT INTO memory_tombstones VALUES('t1','record','fact',NULL,NULL,1,'owner',1)").run();
    expect(await route({ action: "inspect", id: "fact", version: 2 })).toMatchObject({ evidence: [], earlier: [] });
  });

  it("learned today: counts per bot, zero omitted, the cap label", async () => {
    const a = ensureScope("bot", "a"), b = ensureScope("bot", "b");
    transaction(db => {
      for (let n = 0; n < OWNER_COUNT_CAP + 5; n++) insert(db, `a-${n}`, a, "fact", 10_000 + n);
      insert(db, "a-yesterday", a, "fact", 500);
      insert(db, "b-yesterday", b, "fact", 500);
      insert(db, "a-checkpoint", a, "checkpoint", 20_000);
    });
    expect(await route({ action: "learned-today", since: 10_000 })).toEqual({ bots: [{ botId: "a", count: OWNER_COUNT_CAP, label: "1,000+" }] });
    expect(await route({ action: "learned-today", since: 10_000 + OWNER_COUNT_CAP })).toEqual({ bots: [{ botId: "a", count: 5, label: "5" }] });
    const counted = await list({ botId: "a", since: 10_000 + OWNER_COUNT_CAP });
    expect(counted).toMatchObject({ matchCount: 5, matchCountLabel: "5" });
  });
});

describe("Mode P (the key table is not filled yet)", () => {
  for (const size of [3_000, 30_000]) it(`browse answers no rows and the notice, search keeps a constant window (${size})`, async () => {
    const scope = ensureScope("bot", "a");
    transaction(db => { for (let n = 0; n < size; n++) insert(db, `r-${n}`, scope, "fact", 1000 + n, { text: n === size - 7 ? "ravenpeak note" : `note ${n}` }); });
    database().prepare(`UPDATE ${RECORD_KEYS_BUILD} SET ready=0,cursor_rowid=0 WHERE id=1`).run();
    const browse = await measured(() => list({ botId: "a" }));
    expect(browse.answer).toMatchObject({ records: [], preparing: true, searchNotice: OWNER_PREPARING_NOTICE });
    expect(browse.answer.nextCursor).toBeUndefined();
    expect(browse.statements.filter(statement => statement.sql.includes("memory_records"))).toEqual([]);
    expect((await list({ botId: "a", view: "recent" })).preparing).toBe(true);
    expect(await route({ action: "learned-today", since: 0 })).toEqual({ bots: [], preparing: true });
    const search = await measured(() => list({ botId: "a", query: "ravenpeak", kinds: ["fact"] }));
    expect(search.answer.records.map(row => row.id)).toEqual([`r-${size - 7}`]);
    expect(search.statements.length).toBeLessThanOrEqual(81);
  });
});

describe("work bounds (keys examined) at 3,000 and 30,000 rows", () => {
  /** `size` facts of bot a, 3 concerns spread among them, every 50th fact from chat ta-trip, all made at `at0 + n`. */
  function seed(size: number, at0 = 1_000_000) {
    const scope = ensureScope("bot", "a");
    transaction(db => {
      for (let n = 0; n < size; n++) {
        const id = `f-${String(n).padStart(6, "0")}`;
        insert(db, id, scope, [Math.floor(size / 4), Math.floor(size / 2), size - 10].includes(n) ? "concern" : "fact", at0 + n);
        if (n % 50 === 0) evidence(db, id, 1, scope, "ta-trip");
      }
    });
  }
  const cases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: "dense group", body: { botId: "a", kinds: ["fact"], pinnedFirst: true } },
    { name: "sparse kind", body: { botId: "a", kinds: ["concern"] } },
    { name: "no-match chat", body: { botId: "a", kinds: ["fact"], threadId: "tb" } },
    { name: "until older than every row", body: { botId: "a", kinds: ["fact"], until: 10 } },
    { name: "Settings, scopes null, sparse kind", body: { kinds: ["concern"] } },
    { name: "Settings, scopes null, dense", body: { kinds: ["fact"] } },
  ];
  for (const withIndex of [true, false]) for (const item of cases) it(`${item.name}, ${withIndex ? "with" : "without"} the scope-kind index`, async () => {
    const runs: Array<Awaited<ReturnType<typeof measured<ListAnswer>>>> = [];
    for (const size of [3_000, 30_000]) {
      closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster as never);
      seed(size);
      if (withIndex) database().exec(OWNER_SCOPE_KIND.sql);
      expect(optionalIndexReady(database(), OWNER_SCOPE_KIND_INDEX)).toBe(withIndex);
      runs.push(await measured(() => list(item.body)));
    }
    const [small, large] = runs as [typeof runs[0], typeof runs[0]];
    // the same statements at both sizes
    expect(large.texts).toEqual(small.texts);
    const keyed = item.body.botId !== undefined;
    // with the index, a bot's kind scan names it, so the planner never walks the scope index past a kind the scope does not hold
    if (keyed && withIndex && !item.body.pinnedFirst) expect(large.texts.some(text => text.includes(`INDEXED BY ${OWNER_SCOPE_KIND_INDEX}`))).toBe(true);
    if (!withIndex) expect(large.texts.some(text => text.includes("INDEXED BY"))).toBe(false);
    const perStatement = keyed && !withIndex ? OWNER_SLICE_ROWS : 51;
    for (const run of runs) {
      // every statement steps at most one slice of keys, and a request at most the window: the last slice asks only for what is left
      expect(run.widest).toBeLessThanOrEqual(perStatement);
      // spec r3 8: keys examined per request <= OWNER_TAIL_WINDOW (exact, the walk alone); the page's row read is one statement of <= 50 rows
      expect(run.keys).toBeLessThanOrEqual(OWNER_TAIL_WINDOW);
      expect(run.visited - run.keys).toBeLessThanOrEqual(50);
    }
    if (item.name === "sparse kind" && withIndex || item.name.startsWith("Settings")) {
      // an exact prefix: the page costs its own rows, whatever the history holds
      expect(large.visited).toBe(small.visited);
      expect(large.visited).toBeLessThanOrEqual(51 + 50 + 1);
    }
    if (item.name === "dense group") {
      // the pin phase reads the pinned prefix: nothing pinned costs nothing at any size; the rest phase is a page
      expect(large.answer.records).toEqual([]);
      expect(large.visited).toBe(0);
      const rest = await list({ ...item.body, cursor: large.answer.nextCursor });
      expect(rest.records).toHaveLength(50);
    }
    if (item.name === "sparse kind") expect(small.answer.records.map(row => row.kind)).toEqual(["concern", "concern", "concern"]);
    if (item.name === "no-match chat" || item.name.startsWith("until")) {
      expect(small.answer.records).toEqual([]);
      expect(small.answer.coverageComplete).toBe(true);
      // at 30,000 the walk stops at the window and says so; the next page carries on from there
      expect(large.answer.coverageComplete).toBe(false);
      expect(large.answer.searchNotice).toBe(OWNER_NEWEST_NOTICE);
      expect(large.answer.nextCursor).toBeTruthy();
    }
  });

  it("the pin phase is bounded: another bot's pins never cost more than the window, and the walk carries on from its frontier", async () => {
    const runs: Array<Awaited<ReturnType<typeof measured<ListAnswer>>>> = [];
    for (const size of [3_000, 30_000]) {
      closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster as never);
      const a = ensureScope("bot", "a"), b = ensureScope("bot", "b");
      transaction(db => {
        // bot a's three pins are older than every one of bot b's pins, so the pinned prefix passes all of b's first
        for (let n = 0; n < 3; n++) insert(db, `a-pin-${n}`, a, "fact", 500_000 + n, { pinned: 1 });
        for (let n = 0; n < size; n++) insert(db, `b-pin-${String(n).padStart(6, "0")}`, b, "fact", 1_000_000 + n, { pinned: 1 });
      });
      runs.push(await measured(() => list({ botId: "a", kinds: ["fact"], pinnedFirst: true })));
    }
    const [small, large] = runs as [typeof runs[0], typeof runs[0]];
    // the same key walk at both sizes (the small page also reads its 3 rows; the large one has none to read)
    const walk = (run: typeof runs[0]) => run.texts.filter(text => text.includes("memory_record_keys"));
    expect(walk(large)).toEqual(walk(small));
    expect(walk(small)).toHaveLength(1);
    for (const run of runs) {
      expect(run.widest).toBeLessThanOrEqual(51);
      expect(run.keys).toBeLessThanOrEqual(OWNER_TAIL_WINDOW);
      expect(run.visited - run.keys).toBeLessThanOrEqual(50);
    }
    expect(small.answer.records.map(row => row.id)).toEqual(["a-pin-2", "a-pin-1", "a-pin-0"]);
    expect(small.answer.coverageComplete).toBe(true);
    // at 30,000 the pin phase stops at the window, says so, and the next page reaches bot a's pins
    expect(large.answer.records).toEqual([]);
    expect(large.answer.coverageComplete).toBe(false);
    expect(large.answer.searchNotice).toBe(OWNER_NEWEST_NOTICE);
    expect(JSON.parse(Buffer.from(large.answer.nextCursor!, "base64url").toString())).toMatchObject({ p: "pin" });
    const next = await measured(() => list({ botId: "a", kinds: ["fact"], pinnedFirst: true, cursor: large.answer.nextCursor }));
    expect(next.keys).toBeLessThanOrEqual(OWNER_TAIL_WINDOW);
    expect(next.visited - next.keys).toBeLessThanOrEqual(50);
    expect(next.answer.records.map(row => row.id)).toEqual(["a-pin-2", "a-pin-1", "a-pin-0"]);
  });

  it("the scope-kind index is registered, optional, and accepted with or without", () => {
    seed(10);
    expect(OPTIONAL_INDEXES.map(index => index.name)).toContain(OWNER_SCOPE_KIND_INDEX);
    expect(optionalIndexReady(database(), OWNER_SCOPE_KIND_INDEX)).toBe(false);
    validateMemorySchema(database());
    database().exec(OWNER_SCOPE_KIND.sql);
    validateMemorySchema(database());
    const plan = (database().prepare("EXPLAIN QUERY PLAN SELECT record_id FROM memory_record_keys WHERE scope_id=? AND kind=? AND state=? AND age_key BETWEEN ? AND ? ORDER BY age_key DESC LIMIT 51").all("s", "fact", "active", 0, 1) as Array<{ detail: string }>).map(row => row.detail).join("|");
    expect(plan).toContain(OWNER_SCOPE_KIND_INDEX);
    expect(plan).not.toContain("TEMP B-TREE");
  });
});
