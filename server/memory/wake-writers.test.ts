// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMORY V2 lane W: W-WRITERS and the static half of W-COMMIT (design 3.1).
//   - every writable `new DatabaseSync(` in server/** is classified; a new one fails here until it is;
//   - each worker that opens the main database writable declares its write set and refuses, on its own connection, every row write to a
//     memory table outside it (run here in a real worker thread, from the same source text production uses);
//   - no declared set holds a table that means a wake, so only the main connection can write one;
//   - the files that end transactions are listed, and nothing but the installer reaches around the commit observer.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ROOT_SET_RECLAIM_TABLES } from "./root-set-reclaim.ts";
import { DatabaseSync } from "node:sqlite";
import { guardWriteSet, WAKE_TABLES, WORKER_WRITE_SETS, writeSetGuardCall, type WorkerOpener } from "./wake.ts";

const SERVER = join(import.meta.dirname, "..");
const isTestFile = (path: string) => /\.test\.ts$|[\\/](?:testing|testdata)[\\/]|test-support\.ts$|\.fixture\.ts$|fixtures?\.ts$|\.gen\.ts$|\.d\.ts$/.test(path);
function sources(dir = SERVER, out: { path: string; text: string }[] = []): { path: string; text: string }[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules") sources(full, out); continue; }
    if (!entry.name.endsWith(".ts") || isTestFile(full)) continue;
    out.push({ path: relative(SERVER, full).split(sep).join("/"), text: readFileSync(full, "utf8") });
  }
  return out;
}
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** Every file that opens a connection that can write, and what that connection is. "main-db worker" entries name their write set. */
const WRITABLE_OPENERS: Record<string, { opens: string; worker?: WorkerOpener[] }> = {
  "database.ts": { opens: "the main database: the one connection the wake triggers and the commit observer are installed on" },
  "memory/root-set-reclaim.ts": { opens: "main database, worker threads", worker: ["root-set-reclaim", "root-set-vacuum"] },
  "memory/optional-index.ts": { opens: "main database, worker thread (one CREATE INDEX)", worker: ["optional-index"] },
  "memory/provenance-stamp.ts": { opens: "main database, worker thread (a read snapshot)", worker: ["provenance-stamp"] },
  "memory/root-set-compaction.ts": { opens: "main database, worker thread (checkpoint, DROP INDEX, VACUUM)", worker: ["root-set-compaction"] },
  "inbox-fill-worker.ts": { opens: "main database, worker thread: inbox tables only (no memory table)", worker: ["inbox-fill"] },
  "wal-maintenance.ts": { opens: "main database, worker thread: checkpoints only" },
  "email/restore-job-effects.ts": { opens: "main database during an owner restore job: restore and email tables only" },
  "email/restore-marker.ts": { opens: "main database at a boot step: restore and email tables only" },
  "installation-restore.ts": { opens: "the previous installation's database, at the restore switch" },
  "installation-restore-preparation.ts": { opens: "a restore candidate, not the live file" },
  "installation-memory-downgrade.ts": { opens: "the downgrade tool, with the app stopped" },
  "memory/restore.ts": { opens: "a restore candidate, not the live file" },
  "highlevel/thread-marks-restore.ts": { opens: "a restore candidate, not the live file" },
  "memory/lineage-warm-surface.ts": { opens: "a test-only seam" },
  "settle-copy.ts": { opens: "a private copy" },
  "memory/age-index.ts": { opens: "the memory index file" },
  "memory/index-wal.ts": { opens: "the memory index file" },
  "memory/index-reader.ts": { opens: "the memory index file (options passed by the caller)" },
  "search-index-worker.ts": { opens: "the search index file" },
  "web-document-budget.ts": { opens: "its own reservations file" },
  "engine-fs.ts": { opens: "an engine's own store" },
  "engine-structure-check.ts": { opens: "nothing: the text is in a comment" },
  "skill-search.ts": { opens: "the skills index file" },
  "connected-app-journal.ts": { opens: "its own journal file" },
  "sentinel/store.ts": { opens: "the sentinel's own file" },
  "sentinel/scan.ts": { opens: "the sentinel's own file" },
  "channels/delivery-ledger-store.ts": { opens: "a channel's delivery ledger" },
  "sqlite-file-checkpoint.ts": { opens: "delivery-ledger files: checkpoints only" },
  "health/stats-publisher.ts": { opens: "its own statistics file" },
  "session-proof-world.ts": { opens: "a model database of the proof, in memory or a scratch file" },
  "sqlite-open.ts": { opens: "the re-export other files construct through (the phone-calls file)" },
};

describe("W-WRITERS: every connection that can write is known, and a worker on the main database stays inside its declared set", () => {
  const openers = new Map<string, number>();
  for (const { path, text } of sources()) {
    const sites = text.split("\n").filter(line => /new DatabaseSync\(/.test(line) && !/readOnly:\s*true/.test(line) && !/new DatabaseSync\(\s*["']:memory:["']/.test(line)).length;
    if (sites > 0) openers.set(path, sites);
  }

  it("the scan finds the main connection and the four worker files (it is not vacuous)", () => {
    expect(openers.size).toBeGreaterThan(20);
    for (const file of ["database.ts", "memory/root-set-reclaim.ts", "memory/optional-index.ts", "memory/provenance-stamp.ts", "memory/root-set-compaction.ts"]) expect(openers.has(file), file).toBe(true);
  });

  it("every writable opener is classified; a new one must be added to the list with what it writes", () => {
    expect([...openers.keys()].filter(file => !(file in WRITABLE_OPENERS)).sort()).toEqual([]);
    expect(Object.keys(WRITABLE_OPENERS).filter(file => !openers.has(file)).sort()).toEqual([]); // no stale entry
  });

  it("each worker opener installs its write-set guard once per connection it opens, and its parent adopts the worker", () => {
    const text = new Map(sources().map(source => [source.path, source.text]));
    const declared = new Set<string>();
    for (const [file, entry] of Object.entries(WRITABLE_OPENERS)) {
      if (!entry.worker) continue;
      const source = text.get(file)!;
      expect(openers.get(file), file).toBe(entry.worker.length);
      // a worker started from source text carries the guard's text; a module worker calls the same guard as a function
      for (const name of entry.worker) { declared.add(name); expect(source.split(`writeSetGuardCall("${name}")`).length - 1 + (source.split(`guardWriteSet(db, "${name}")`).length - 1), `${file} ${name}`).toBe(1); }
      expect((source.match(/adoptWorker\(worker, /g) ?? []).length, file).toBe((source.match(/new Worker\(/g) ?? []).length);
    }
    expect([...declared].sort()).toEqual(Object.keys(WORKER_WRITE_SETS).sort());
  });

  it("the reclaim worker's declared set covers every table its plan clears or drops (the set is exact, not a guess)", () => {
    for (const table of ROOT_SET_RECLAIM_TABLES) expect(WORKER_WRITE_SETS["root-set-reclaim"] as readonly string[], table).toContain(table);
  });

  it("no worker's declared set holds a table that means a wake: only the main connection can write one", () => {
    expect(WAKE_TABLES).toEqual(["memory_deny_pending", "memory_deny_pending_scope", "memory_jobs", "memory_projection_receipts", "memory_recall_changes", "memory_receipt_flips", "memory_revoke_jobs", "memory_scope_bindings"]);
    for (const [name, writes] of Object.entries(WORKER_WRITE_SETS)) {
      for (const table of WAKE_TABLES) expect(writes.some(write => write === table || (write.endsWith("*") && table.startsWith(write.slice(0, -1)))), `${name} ${table}`).toBe(false);
    }
  });

  it("no worker may move a record's scope, id or version, a job's source or a source's scope: lane A's old-scope notes live on the main handle (CONTRACT-REQ W from A)", () => {
    // memory_records, memory_jobs and memory_sources stay out of every declared set, so the run-time guard refuses any such write by a worker
    for (const [name, writes] of Object.entries(WORKER_WRITE_SETS)) {
      for (const table of ["memory_records", "memory_jobs", "memory_sources"]) expect(writes.some(write => write === table || (write.endsWith("*") && table.startsWith(write.slice(0, -1)))), `${name} ${table}`).toBe(false);
    }
  });

  it("the installer drops no TEMP object of another lane (recall_journal_wake, recall_reclaim_*): wake.ts holds no DROP at all", () => {
    expect(withoutComments(readFileSync(join(import.meta.dirname, "wake.ts"), "utf8"))).not.toMatch(/\bDROP\s+(?:TRIGGER|TABLE|INDEX|VIEW)\b/i);
  });
});

// The guard text is run here in a real worker thread on the real v13 file with hand-written statements. That the REAL worker scripts
// still do their work with the guard in them is shown by their own suites (optional-index, root-set-reclaim-*, root-set-compaction*,
// provenance-stamp-callers, inbox fill), which run those scripts unchanged apart from the guard.
describe("W-WRITERS at run time: the guard text every worker source carries, in a worker thread on the real file", () => {
  beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(() => { closeDatabase(); });
  /** Runs each statement on a worker's own connection after the guard (or without it) and reports what happened to each. */
  const inWorker = (opener: WorkerOpener | null, statements: string[]) => new Promise<{ refused: number; results: string[]; triggers: string[] }>((resolve, reject) => {
    const source = `
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.file);
db.exec("PRAGMA busy_timeout=5000");
let refused = -1;
${opener ? writeSetGuardCall(opener).replace(/\nguardWriteSet\(/, "\nrefused = guardWriteSet(") : ""}
const results = workerData.statements.map(sql => { try { db.exec(sql); return "ok"; } catch (error) { return String(error && error.message || error); } });
const triggers = db.prepare("SELECT name || ':' || sql AS t FROM temp.sqlite_schema WHERE type='trigger' ORDER BY name").all().map(row => row.t);
db.close();
parentPort.postMessage({ refused, results, triggers });`;
    const worker = new Worker(source, { eval: true, workerData: { file: join(DATA_DIR, "messages.db"), statements } });
    worker.once("message", resolve); worker.once("error", reject);
  });
  const WAKE_WRITES = [
    "INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('thread-w',1,1)",
    "INSERT INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('scope-w',1,1)",
    "INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(41,'line','{}',1,1,'mark','','active')",
    "INSERT INTO memory_receipt_flips(thread_no,first_lsn,bundle_id) VALUES(1,1,'bundle-w')",
    "INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record','rec-w',1)",
    "INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) VALUES('job-w','src-w',1,'capture','1','pending',0,0)",
    "INSERT INTO memory_projection_receipts(record_id,record_version,index_generation,lexical_status,embedding_status) VALUES('rec-w',1,1,'pending','pending')",
    "INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES('notebook-link:src-w','scope-w','notebook','n',0,'granted','{}')",
    "UPDATE memory_meta SET policy_revision=policy_revision WHERE id=1", // a row write of a table outside every set, wake or not
  ];

  it("every opener refuses each wake-table write, and the file is left as it was", async () => {
    database(); closeDatabase(); // the real v13 schema
    for (const opener of Object.keys(WORKER_WRITE_SETS) as WorkerOpener[]) {
      const { refused, results } = await inWorker(opener, WAKE_WRITES);
      expect(refused, opener).toBeGreaterThan(40); // the memory tables of the file, less the declared set
      for (const [index, result] of results.entries()) expect(result, `${opener}: ${WAKE_WRITES[index]}`).toMatch(new RegExp(`memory write outside the declared set of ${opener}: memory_`));
    }
    const db = database();
    for (const table of ["memory_deny_pending", "memory_revoke_jobs", "memory_jobs", "memory_receipt_flips"]) expect(Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n), table).toBe(0);
    expect(Number(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'mem\\_writeset%' ESCAPE '\\'").get()!.n)).toBe(0); // TEMP only: nothing persisted
  });

  it("the module form of the guard installs exactly the triggers the text form does", async () => {
    database(); closeDatabase();
    const fromText = await inWorker("inbox-fill", []);
    const own = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      expect(guardWriteSet(own, "inbox-fill")).toBe(fromText.refused);
      expect(own.prepare("SELECT name || ':' || sql AS t FROM temp.sqlite_schema WHERE type='trigger' ORDER BY name").all().map(row => row.t)).toEqual(fromText.triggers);
      expect(fromText.triggers.length).toBe(fromText.refused * 3);
      expect(() => own.exec("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('thread-w',1,1)")).toThrow(/outside the declared set of inbox-fill: memory_deny_pending/);
    } finally { own.close(); }
  });

  it("without the guard the same worker writes them (what the guard is for)", async () => {
    database(); closeDatabase();
    const { results } = await inWorker(null, WAKE_WRITES.slice(0, 3));
    expect(results).toEqual(["ok", "ok", "ok"]);
  });

  it("the reclaim worker may still write its own set, create and drop an index, checkpoint and vacuum", async () => {
    database(); closeDatabase();
    const { results } = await inWorker("root-set-reclaim", [
      "INSERT OR REPLACE INTO memory_lineage_lsn_meta(key,value) VALUES('root_sets_dropped',1)",
      "UPDATE memory_lineage_lsn_meta SET value=1 WHERE key='root_sets_dropped'",
      "DELETE FROM memory_root_set_members", "DELETE FROM memory_root_set_parents", "DELETE FROM memory_root_sets", "DELETE FROM memory_output_roots", "DELETE FROM memory_session_roots",
      "DELETE FROM memory_lineage_lsn_meta WHERE key='root_sets_dropped'",
      "CREATE INDEX IF NOT EXISTS memory_witness_index ON memory_revoke_jobs(state)",
      "DROP INDEX memory_witness_index",
      "PRAGMA wal_checkpoint(PASSIVE)",
      "PRAGMA incremental_vacuum(1)",
    ]);
    expect(results).toEqual(Array.from({ length: 12 }, () => "ok"));
    const vacuum = await inWorker("root-set-vacuum", ["PRAGMA wal_checkpoint(TRUNCATE)", "VACUUM", "INSERT INTO memory_lineage_lsn_meta(key,value) VALUES('witness',1)"]);
    expect(vacuum.results.slice(0, 2)).toEqual(["ok", "ok"]);
    expect(vacuum.results[2]).toMatch(/outside the declared set of root-set-vacuum: memory_lineage_lsn_meta/);
  });
});

describe("the bus loads wherever the connection does", () => {
  it("wake.ts loads in a child process that only strips types (crash children and tools import it through database.ts)", () => {
    const url = pathToFileURL(join(import.meta.dirname, "wake.ts")).href;
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(url)}); const e = new m.LostWakeError("s", "t"); process.stdout.write(e.subscriber + ":" + e.topic + ":" + typeof m.onWake);`], { encoding: "utf8" });
    expect(out.stderr.replace(/^.*ExperimentalWarning.*$\n?|^\(Use `node --trace-warnings.*$\n?/gm, "")).toBe("");
    expect(out.stdout).toBe("s:t:function");
  });
});

describe("W-COMMIT, the static half: where transactions are ended, and that nothing reaches around the observer", () => {
  it("only the installer and the wrapper touch the un-instrumented connection or attach an observer", () => {
    const users = sources().filter(({ text }) => /\b(?:rawConnection|observeConnection)\(/.test(withoutComments(text))).map(source => source.path).sort();
    expect(users).toEqual(["database.ts", "io-budget.ts"]);
  });

  it("the commit observer is driven by the connection's state in every wrapper path, never by statement text", () => {
    const text = readFileSync(join(SERVER, "io-budget.ts"), "utf8");
    const body = text.slice(text.indexOf("const observed = ("), text.indexOf("const wal=source"));
    expect(body).toContain("db.isTransaction");
    expect(body).not.toMatch(/COMMIT|RELEASE|END_TRANSACTION/);
    // the wrapper's own raw rollbacks (the microtask and afterWrite) have no cheap run-time witness: their hooks are pinned here
    expect(text).toMatch(/exec\("ROLLBACK"\);\}finally\{observed\(true,false,undefined,true\);\}/);
    expect(text).toMatch(/try\{exec\("ROLLBACK"\);\}catch\{[^}]*\}finally\{observer\?\.undone\(\);\}/);
  });

  it("every file a line scan finds ending a transaction has its sites in commit-sites.txt (the parser's list, wake-commit-sites.test.ts)", () => {
    // a statement that begins with COMMIT, END or RELEASE, alone or last in a multi-statement text (also the `nested ? "RELEASE x" : "COMMIT"` form).
    // The list itself is the TypeScript parser's (testing/commit-site-scan.ts), one line per call site, checked exactly there; this line
    // scan is an independent cross-check that the parser misses no file.
    const ends = /\.(?:exec|prepare)\(\s*(?:[A-Za-z_.]+\s*\?\s*)?[`"'](?:[^`"'\n]*;\s*)?(?:COMMIT|END|RELEASE)\b(?!\s*\))/;
    const found = sources().filter(({ text }) => ends.test(withoutComments(text))).map(source => source.path).sort();
    expect(found.length).toBeGreaterThan(50);
    const listed = new Set(readFileSync(join(import.meta.dirname, "testing", "commit-sites.txt"), "utf8").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(line => line.slice(0, line.indexOf(":"))));
    // a file listed only for a CREATE TEMP TRIGGER body's END is not a site (the parser classifies the text)
    expect(found.filter(file => !listed.has(file) && file !== "memory/audience-cache.ts")).toEqual([]);
  });
});
