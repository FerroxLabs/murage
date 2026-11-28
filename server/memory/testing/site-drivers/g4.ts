// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W-COMMIT per-site drivers (commit-site-harness.ts): message-search-index.ts, search-index-worker.ts, message-db.ts, message-tables.ts,
// message-walker.ts, inbox.ts, inbox-fill-worker.ts, transcript-backfill.ts, transcript-seq.ts, skill-search.ts, branch-fill.ts,
// flux-memory-spaces.ts, engine-exec.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../../../config.ts";
import { threadKey, invalidateThread } from "../../../branch-index.ts";
import { fillOneSliceOn, prepareSyncOn } from "../../../branch-fill.ts";
import { executeEnginePlans } from "../../../engine-exec.ts";
import type { HomePlanData } from "../../../engine-plan-core.ts";
import { initializeFluxSpaces, noteFluxCaptureAccepted } from "../../../flux-memory-spaces.ts";
import { drainInboxDeferredInline, inboxProjectionSlice, reclaimRetiredInboxProjection } from "../../../inbox.ts";
import { insertMessage, readThread } from "../../../message-db.ts";
import {
  disableMessageSearchIndex, messageSearchIndexReady, readMessageSearchCandidates, recovery, searchIndexTestHooks, settleInheritedSearchMerge,
  startSearchIndex, stopSearchIndex, trigramQuery,
} from "../../../message-search-index.ts";
import { ensureBrowserCheckIndex, indexBrowserCheckChunk } from "../../../message-tables.ts";
import { walkMessagesChunk } from "../../../message-walker.ts";
import { resetCatalogIndex, resetSkillIndex, searchCatalog, skillIndexStats } from "../../../skill-search.ts";
import type { Message } from "../../../store.ts";
import { indexOpenCardsChunk } from "../../../transcript-backfill.ts";
import { downgradeTranscriptSeqTo102 } from "../../../transcript-seq.ts";
import type { SiteDriver } from "../commit-site-harness.ts";

type Db = DatabaseSync;
const msg = (id: string, text: string): Message => ({ id, role: "user", kind: "text", text, at: Date.now() });
/** Waits on real timers (setup, own runs, and real-timer commits only). */
async function until(ok: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// ---- the search index (search.db worker, started by database()) ----
const searchFile = () => join(DATA_DIR, "messages.db");
const healthy = (db: Db) => until(() => messageSearchIndexReady(db) && recovery(db).state === "HEALTHY", "a healthy search index");
/** Every worker event from now on. */
function listen(): Array<{ type: string; [key: string]: unknown }> {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  searchIndexTestHooks.event = event => { events.push(event); };
  return events;
}
const newestIntent = (db: Db) => Number((db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM search_intents").get() as { n: number }).n);
/** A message indexed by a worker step: the step's snapshot (B) and its write (A) both committed. */
async function indexedStep(db: Db, id: string): Promise<boolean> {
  await healthy(db);
  const events = listen();
  insertMessage("s1", msg(id, "hello search world"));
  const seq = newestIntent(db);
  await until(() => events.some(e => e.type === "stepped" && e.worked === true && Number(e.applied) >= seq), "a worked step");
  return true;
}

// ---- an engine home (engine-exec.ts runs plans on the engine's own SQLite file) ----
function engineHome(): { home: string; file: string } {
  const home = join(DATA_DIR, "engine-home");
  mkdirSync(home, { recursive: true });
  const file = join(home, "state.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('gone'),('kept'); CREATE VIRTUAL TABLE session_docs_fts USING fts5(body); INSERT INTO session_docs_fts VALUES('one'),('two');");
  db.close();
  return { home, file };
}
function runPlan(steps: (file: string) => HomePlanData["steps"]): boolean {
  const { home, file } = engineHome();
  const heard: number[] = [];
  const result = executeEnginePlans({ [`fuigo\0${home}`]: { engine: "fuigo", home, steps: steps(file) } }, (_key, index) => { heard.push(index); });
  return heard.length === 1 && result.failed.length === 0 && result.failedHomes.length === 0;
}

export const DRIVERS: Record<string, SiteDriver> = {
  "branch-fill.ts prepareSyncOn#1": {
    conn: "main",
    setup: db => { insertMessage("b1", msg("m1", "one")); invalidateThread(db, threadKey(db, "b1")!); },
    commit: db => prepareSyncOn(db, "b1"),
  },
  "branch-fill.ts fillOneSliceOn#1": {
    conn: "main",
    setup: db => { insertMessage("b1", msg("m1", "one")); invalidateThread(db, threadKey(db, "b1")!); },
    commit: db => fillOneSliceOn(db, "b1"),
  },
  "engine-exec.ts sqlDeleteOn#1": {
    conn: "own",
    why: "the engine's own SQLite file (mutOps.openDbWrite), not messages.db",
    run: () => {
      let file = "";
      const ok = runPlan(f => { file = f; return [{ k: "sqlDelete", cls: "content", group: f, db: f, pragmas: "PRAGMA busy_timeout=5000;", stmts: [{ table: "sessions", where: "id=?", params: ["gone"] }] }]; });
      const left = new DatabaseSync(file, { readOnly: true });
      try { return ok && (left.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: string }>).map(r => r.id).join() === "kept"; } finally { left.close(); }
    },
  },
  "engine-exec.ts ftsOptimizeOn#1": {
    conn: "own",
    why: "the engine's own SQLite file (mutOps.openDbWrite), not messages.db",
    run: () => runPlan(f => [{ k: "ftsOptimize", cls: "hygiene", group: f, db: f }]),
  },
  "flux-memory-spaces.ts atomically#1": {
    conn: "main",
    setup: db => initializeFluxSpaces(db),
    commit: db => noteFluxCaptureAccepted(db, { threadId: "t1", botId: "bot1", keyFp: "fp1", space: "bot:space1", tag: "tag1", sourceId: "src1" }),
  },
  "inbox-fill-worker.ts step#1": {
    // the deferred drain on this connection (the server runs the same drain on a worker): one deferred row, one step
    conn: "main",
    setup: db => { insertMessage("d1", msg("m1", "one")); db.prepare("INSERT OR IGNORE INTO inbox_fill_deferred(source_row,thread_id) SELECT rowid,thread_id FROM messages WHERE thread_id='d1'").run(); },
    commit: db => drainInboxDeferredInline(db),
  },
  "inbox.ts inboxProjectionSlice#1": {
    // a priority conversation's slice: the fill not done, its high-water mark recorded by the slice itself
    conn: "main",
    setup: db => { insertMessage("p1", msg("m1", "one")); db.exec("DELETE FROM inbox_projection_state WHERE name IN ('inbox','high') OR name LIKE 't:%'"); },
    commit: db => inboxProjectionSlice(db, { rows: 100, weight: 64 * 1024 }, ["p1"]),
  },
  "inbox.ts inboxProjectionSlice#2": {
    conn: "main",
    setup: db => { db.exec("DELETE FROM inbox_projection_state WHERE name='inbox'"); },
    commit: db => inboxProjectionSlice(db, { rows: 100 }),
  },
  "inbox.ts reclaimRetiredInboxProjection#1": {
    // a set-aside table of an older layout
    conn: "main",
    setup: db => { db.exec("CREATE TABLE retired1_inbox_raw(x); INSERT INTO retired1_inbox_raw VALUES(1),(2)"); },
    commit: db => reclaimRetiredInboxProjection(db, 1_000),
  },
  "message-db.ts importLegacy#1": {
    conn: "main",
    setup: () => { writeFileSync(join(DATA_DIR, "messages-l1.json"), JSON.stringify({ messages: [msg("m1", "legacy line")], activeLeafId: "m1" })); },
    commit: () => readThread("l1", join(DATA_DIR, "messages-l1.json")),
  },
  "message-search-index.ts settleInheritedSearchMerge#3": {
    // an inherited messages_fts on the main file (a pre-worker build). A plain table stands in for the FTS5 one: the harness cannot put
    // its triggers on FTS5 shadow tables ("cannot create triggers on shadow tables"), and the site only probes the name and renames it.
    conn: "main",
    setup: db => { db.exec("CREATE TABLE messages_fts(t)"); },
    commit: db => settleInheritedSearchMerge(db, false),
  },
  "message-search-index.ts settleInheritedSearchMerge#1": {
    conn: "nested",
    why: "the retire-name savepoint is opened inside the merge's own BEGIN IMMEDIATE (or the caller's transaction): its RELEASE never ends one",
    setup: db => { db.exec("CREATE TABLE messages_fts(t)"); },
    commit: db => settleInheritedSearchMerge(db, false),
  },
  "message-search-index.ts acknowledgeSearchReset#1": {
    // a failed read asks the worker for a reset; its reset-needed is acknowledged with the marker intent on main
    conn: "main",
    realTimers: true,
    setup: db => healthy(db),
    commit: async db => { disableMessageSearchIndex(db, new Error("fixture read failure")); await until(() => recovery(db).state !== "HEALTHY", "the reset acknowledgement"); },
  },
  "message-search-index.ts readMessageSearchCandidates#1": {
    conn: "own",
    why: "the read-only search.db reader of the run, not the main handle",
    run: async db => {
      await indexedStep(db, "m1");
      const rowid = Number((db.prepare("SELECT rowid AS r FROM messages WHERE thread_id='s1' AND id='m1'").get() as { r: number }).r);
      const found = readMessageSearchCandidates(db, trigramQuery("search"), 10);
      return found.rowids.includes(rowid) && messageSearchIndexReady(db);
    },
  },
  "message-tables.ts indexBrowserCheckChunk#1": {
    // a file from a build that kept the partial index: filled from it in one statement
    conn: "main",
    setup: db => { ensureBrowserCheckIndex(db); db.exec("DELETE FROM transcript_index_state WHERE name='browser_check'"); },
    commit: db => indexBrowserCheckChunk(db),
  },
  "message-tables.ts indexBrowserCheckChunk#2": {
    conn: "main",
    setup: db => { db.exec("DELETE FROM transcript_index_state WHERE name='browser_check'"); },
    commit: db => indexBrowserCheckChunk(db),
  },
  "message-walker.ts walkMessagesChunk#1": {
    conn: "main",
    setup: db => { insertMessage("w1", msg("m1", "one")); db.exec("DELETE FROM transcript_index_state WHERE name='turn_first'"); },
    commit: db => walkMessagesChunk(db),
  },
  "search-index-worker.ts SEARCH_INDEX_WORKER_SOURCE>valid#1": {
    conn: "own",
    why: "the search worker's own connections (eval'd worker source)",
    // anchors are stamped by a reset taken after a message exists; a schema change on main then makes the next snapshot adopt it
    setup: async db => {
      insertMessage("s1", msg("m1", "anchored"));
      await healthy(db);
      disableMessageSearchIndex(db, new Error("fixture read failure"));
      await until(() => recovery(db).state !== "HEALTHY", "the reset"); await healthy(db);
    },
    run: async db => {
      const events = listen();
      db.exec("CREATE TABLE w_site_schema_bump(x)");
      insertMessage("s1", msg("m2", "after the schema change"));
      await until(() => events.some(e => e.type === "source-adopted"), "the source schema adoption");
      return true;
    },
  },
  "search-index-worker.ts SEARCH_INDEX_WORKER_SOURCE>snapshot#2": {
    conn: "own",
    why: "the search worker's read-only snapshot of messages.db (eval'd worker source)",
    run: db => indexedStep(db, "m1"),
  },
  "search-index-worker.ts SEARCH_INDEX_WORKER_SOURCE>write#1": {
    conn: "own",
    why: "the search worker's own search.db (eval'd worker source)",
    run: db => indexedStep(db, "m1"),
  },
  "search-index-worker.ts SEARCH_INDEX_WORKER_SOURCE>reset#1": {
    conn: "own",
    why: "the search worker's read-only snapshot of messages.db (eval'd worker source)",
    setup: db => healthy(db),
    run: async db => {
      const events = listen();
      disableMessageSearchIndex(db, new Error("fixture read failure"));
      await until(() => events.some(e => e.type === "ready"), "the reset's ready");
      return events.some(e => e.type === "reset-ack");
    },
  },
  "search-index-worker.ts SEARCH_INDEX_WORKER_SOURCE>activate#1": {
    // a restart on a valid index: activate's snapshot commits and the index is ready with no reset
    conn: "own",
    why: "the search worker's read-only snapshot of messages.db (eval'd worker source)",
    setup: db => healthy(db),
    run: async db => {
      await stopSearchIndex();
      const events = listen();
      startSearchIndex(db, searchFile());
      await until(() => events.some(e => e.type === "ready"), "the restarted worker's ready");
      return !events.some(e => e.type === "reset-needed" || e.type === "failure");
    },
  },
  "skill-search.ts buildIndexFile#1": {
    conn: "own",
    why: "the skill index's private temp file (its own DatabaseSync)",
    run: async () => { resetSkillIndex(); const stats = await skillIndexStats(); return stats.available && stats.count > 0; },
  },
  "skill-search.ts openCatalog#1": {
    conn: "own",
    why: "the catalog's in-memory database",
    run: () => {
      resetCatalogIndex();
      const hits = searchCatalog([{ slug: "team-a", name: "Newsletter team", summary: "writes the newsletter", category: "content", skills: ["teams/team-a/skills/launch-newsletter/SKILL.md"], requires: { apps: [] } }], "newsletter");
      return hits.some(hit => hit.slug === "team-a");
    },
  },
  "transcript-backfill.ts inTransaction#1": {
    conn: "main",
    setup: db => { db.exec("DELETE FROM transcript_index_state WHERE name='open_card'"); },
    commit: db => indexOpenCardsChunk(db),
  },
  "transcript-seq.ts downgradeTranscriptSeqTo102#1": {
    conn: "main",
    commit: db => downgradeTranscriptSeqTo102(db),
  },
};
