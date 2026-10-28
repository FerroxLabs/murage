// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMDEL-SIMPLIFY-109 through the real scheduler: the real MemoryWorkerController forks the real helper (worker.ts) on a fresh fixture
// in the throwaway HOME (server/testing/setup.ts). No engine, no model, never the user's data. A bulk deletion's batches are each
// acknowledged at once and share one index merge (plus at most one follow-up), and a helper killed mid-scrub is restarted for the
// index's durable debt alone and resumes that merge instead of starting another.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { MemoryIndex } from "./index.ts";
import { blockMemoryIndexReader, closeMemoryIndexReader } from "./index-reader.ts";
import { ensureScope } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

const MARKER = "orchidschedulerfixture";
/** More than three batches of 16, and a corpus large enough that one-page merge steps take seconds, not milliseconds. */
const FORGETS = 80, FILLER = 4096;
const indexFile = () => join(DATA_DIR, "memory-index.db");
type Internals = { child: ChildProcess | null; scrubOwed: boolean };
let controller: MemoryWorkerController | null = null;

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); });
afterEach(async () => { await controller?.stop().catch(() => {}); controller = null; closeMemoryIndexReader(); closeDatabase(); });

/** index_meta on a short-lived read-only connection, so no snapshot is held across a helper checkpoint. */
function meta(key: string): string | undefined {
  const db = new DatabaseSync(indexFile(), { readOnly: true });
  try { const row = db.prepare("SELECT value FROM index_meta WHERE key=?").get(key); return row ? String(row.value) : undefined; }
  finally { db.close(); }
}
const merges = () => Number(meta("delete_scrub_merges") ?? 0);
const entries = () => { const db = new DatabaseSync(indexFile(), { readOnly: true }); try { return Number(db.prepare("SELECT count(*) AS n FROM entries").get()!.n); } finally { db.close(); } };
/** Main-file pages holding the marker, by table (dbstat), and its WAL and SHM copies. */
function copies(): { pages: Array<{ name: string; pageno: number }>; logs: string[] } {
  const logs = [`${indexFile()}-wal`, `${indexFile()}-shm`].filter(file => existsSync(file) && readFileSync(file).includes(Buffer.from(MARKER)));
  const bytes = readFileSync(indexFile()), numbers = new Set<number>();
  const db = new DatabaseSync(indexFile(), { readOnly: true });
  try {
    const size = Number(db.prepare("PRAGMA page_size").get()!.page_size);
    for (let at = bytes.indexOf(MARKER); at >= 0; at = bytes.indexOf(MARKER, at + 1)) numbers.add(Math.floor(at / size) + 1);
    const pages = [...numbers].map(pageno => ({ name: String(db.prepare("SELECT name FROM dbstat WHERE pageno=?").get(pageno)?.name ?? "free"), pageno }));
    return { pages, logs };
  } finally { db.close(); }
}
/** What the deletion scrub owns: the word index, its rows and the log. A plain b-tree page rebuilt by SQLite (a split or merge of the
 * postings table) can keep a stale copy of a moved cell in its unallocated space that secure_delete does not zero; that residue is outside
 * this lane and is reported (MEMDEL-SIMPLIFY-109 notes), never counted as scrubbed. */
const marked = () => { const found = copies(); return [...found.logs, ...found.pages.filter(page => page.name !== "postings").map(page => `${page.name}:${page.pageno}`)]; };
const owedForgets = () => Number(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE record_id LIKE 'forget-%' AND lexical_status='delete-pending'").get()!.n);
const wait = (check: () => void, timeout: number) => vi.waitFor(check, { timeout, interval: 25 });

/** FORGETS indexed records carrying the marker, beside FILLER retained entries, written by this process before any helper runs. */
function seed(): string[] {
  const scope = ensureScope("conversation", "memdel-scheduler");
  const db = database();
  const ids = Array.from({ length: FORGETS }, (_, n) => `forget-${String(n).padStart(3, "0")}`);
  transaction(() => {
    for (const id of ids) {
      db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'fact',?,'observed','active',0,0)").run(id, scope, `${MARKER} ${id}`);
      db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'indexed','indexed',NULL)").run(id);
    }
  });
  const index = new MemoryIndex(indexFile());
  try {
    for (let at = 0; at < FILLER; at += 16) {
      index.upsert(Array.from({ length: 16 }, (_, k) => ({ id: `filler-${at + k}`, version: 1, scopeId: scope, deleted: false,
        text: Array.from({ length: 60 }, (_, word) => `fillerterm${at + k}part${word}`).join(" ") })));
    }
    for (let at = 0; at < FORGETS; at += 16) index.upsert(ids.slice(at, at + 16).map(id => ({ id, version: 1, scopeId: scope, deleted: false, text: `${MARKER} ${id}` })));
  } finally { index.close(); }
  expect(marked().length).toBeGreaterThan(0);
  return ids;
}
/** The owner forgets these records, as memory-revocation.ts affect() writes it. */
function forget(ids: readonly string[]): void {
  const db = database();
  transaction(() => {
    for (const id of ids) {
      db.prepare("UPDATE memory_records SET state='deleted',text='' WHERE id=? AND version=1").run(id);
      db.prepare("UPDATE memory_projection_receipts SET lexical_status='delete-pending',embedding_status='delete-pending' WHERE record_id=? AND record_version=1").run(id);
    }
  });
  controller?.wake();
}
function start(): MemoryWorkerController {
  controller = new MemoryWorkerController({ modelDirectory: join(DATA_DIR, "no-model") });
  controller.start();
  return controller;
}
const internals = () => controller as unknown as Internals;

it("a bulk deletion over several batches is acknowledged batch by batch and costs one merge plus at most one follow-up", async () => {
  const ids = seed();
  forget(ids.slice(0, 16));
  start();
  // The first batch is acknowledged, and its merge is under way.
  await wait(() => { expect(owedForgets()).toBe(0); expect(merges()).toBe(1); expect(meta("delete_scrub_owed")).toBe("merge"); }, 60_000);
  // The rest arrive while that merge runs: four more batches, none waiting on any scrub.
  forget(ids.slice(16));
  await wait(() => expect(owedForgets()).toBe(0), 60_000);
  expect(merges(), JSON.stringify([meta("delete_scrub_merge"), meta("delete_scrub_target"), meta("delete_generation")])).toBe(1);
  expect(meta("delete_scrub_owed")).toBeDefined();
  // The running merge finishes, then one more covers every later batch; the helper reports the debt paid.
  const trail: string[] = [];
  await wait(() => {
    const now = JSON.stringify([meta("delete_scrub_owed"), meta("delete_scrub_merge"), meta("delete_scrub_target"), meta("delete_generation"), merges(), owedForgets()]);
    if (trail.at(-1) !== now) trail.push(now);
    expect(meta("delete_scrub_owed")).toBeUndefined(); expect(internals().scrubOwed).toBe(false);
  }, 150_000);
  expect(merges(), trail.join("\n")).toBe(2);
  expect(entries()).toBe(FILLER);
  expect(marked(), JSON.stringify(copies())).toEqual([]);
}, 240_000);

// memdel r2 High #2 and #3: the restart may come with memory off or paused (no capture or recall work at all), or with the index unreadable
// at the controller's first look (unknown is owed, not clean): the helper still starts for the debt and finishes it.
it.each([
  { mode: "capture", probe: "readable" }, { mode: "off", probe: "readable" }, { mode: "paused", probe: "readable" }, { mode: "capture", probe: "unreadable" },
] as const)("a helper killed mid-scrub is restarted for the index's debt alone (memory $mode, index $probe at start), resumes the same merge and erases the bytes", async ({ mode, probe }) => {
  const ids = seed();
  forget(ids);
  start();
  await wait(() => {
    expect(owedForgets()).toBe(0);
    // Mid-way through the merge that covers every removal (a forget removed while an earlier merge ran owes one follow-up).
    const merge = JSON.parse(meta("delete_scrub_merge") ?? "{}") as { generation?: number; started?: boolean };
    expect(meta("delete_scrub_owed")).toBe("merge");
    expect(merge.started).toBe(true);
    expect(merge.generation).toBeGreaterThanOrEqual(Number(meta("delete_scrub_target")));
  }, 60_000);
  const started = merges();
  expect(started).toBeGreaterThanOrEqual(1);
  // Crash: the helper dies mid-merge (a step in flight rolls back), then the app stops too.
  const child = internals().child!;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  await controller!.stop();
  controller = null;
  expect(meta("delete_scrub_owed")).toBe("merge");
  expect(marked().length).toBeGreaterThan(0);
  // Restart with nothing else for memory to do: no receipt, no capture job. The index's own marker starts a helper.
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status IN ('pending','pending-archive','delete-pending')").get()!.n)).toBe(0);
  setMemoryMode(mode);
  // the controller's own read of the marker finds no handle (as while the file is locked or being replaced); the helper's start unblocks it
  if (probe === "unreadable") blockMemoryIndexReader();
  start();
  expect(internals().scrubOwed).toBe(true);
  await wait(() => expect(internals().child).not.toBeNull(), 30_000);
  await wait(() => { expect(meta("delete_scrub_owed")).toBeUndefined(); expect(internals().scrubOwed).toBe(false); }, 150_000);
  expect(merges(), JSON.stringify(readdirSync(DATA_DIR))).toBe(started);
  expect(entries()).toBe(FILLER);
  expect(marked(), JSON.stringify(copies())).toEqual([]);
}, 240_000);

// memdel r2 High #2: a deletion while memory is off or paused still leaves the index, and its scrub still runs; nothing else is projected.
it.each(["off", "paused"] as const)("with memory %s, an owner deletion is removed from the index and scrubbed", async mode => {
  const ids = seed();
  const db = database();
  // a pending capture projection stays owed to when memory is on again
  db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES('later-1',1,?,'fact','laterwords','observed','active',0,0)").run(ensureScope("conversation", "memdel-scheduler"));
  db.prepare("INSERT INTO memory_projection_receipts VALUES('later-1',1,0,'pending','pending',NULL)").run();
  setMemoryMode(mode);
  forget(ids);
  start();
  await wait(() => expect(owedForgets()).toBe(0), 60_000);
  await wait(() => { expect(meta("delete_scrub_owed")).toBeUndefined(); expect(internals().scrubOwed).toBe(false); }, 150_000);
  expect(entries()).toBe(FILLER);
  expect(marked(), JSON.stringify(copies())).toEqual([]);
  expect(db.prepare("SELECT lexical_status FROM memory_projection_receipts WHERE record_id='later-1'").get()!.lexical_status).toBe("pending");
}, 240_000);
