// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner: fix/1022-schema-shutdown (preload: testing/shutdown-late-preload.mjs). A real server child takes SIGTERM: gracefulShutdown ->
// dataWriterGate.stop -> stopDataWriters closes messages.db (index.ts), the memory worker's idle pass, the two reclaim route timers and every other
// timer still alive run in the handover window that follows (the preload holds the exit for 1.5 s, as the restore swap does). After the close
// nothing may open messages.db again, write a row of it, or throw a schema or SQLite error out of a timer. Each row names the production site that
// must be reached (the preload reports the idle pass at its gate, the reclaim timers when they fire) and the sites that asked for the file.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRUB_PASS_TABLE } from "./memory/scrub-state.ts";
import { IDENTITY_CANON_INDEX, IDENTITY_PARTITION_INDEX, TOMBSTONE_FORGETS_INDEX, WAITING_REVIEW_INDEX } from "./memory/schema.ts";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { desktopHeaders, healthOk, startServer, waitExited } from "./testing/strict-fs.ts";

const PRELOAD = pathToFileURL(join(import.meta.dirname, "testing", "shutdown-late-preload.mjs")).href;
const probeLines = (out: string, name: string) => out.split("\n").filter(line => line.startsWith(`SHUTDOWN-PROBE ${name} `)).map(line => line.slice(`SHUTDOWN-PROBE ${name} `.length));
const INDEX_LINES = readFileSync(join(import.meta.dirname, "index.ts"), "utf8").split("\n");
/** The 1-based line of server/index.ts holding the production call a row is about (found by its text, so an edit above it does not break the row). */
const lineOf = (anchor: string): number => { const at = INDEX_LINES.findIndex(line => line.includes(anchor)); expect(at, `anchor not in server/index.ts: ${anchor}`).toBeGreaterThanOrEqual(0); return at + 1; };

// Table of the late callers (the lane SITES.md). "reached" is the production site the row proves ran after the close.
const ROWS = [
  // the memory worker's start pass, still waiting for the boot to settle at SIGTERM, takes its idle branch (the preload's owner clock) and asks for the file at the shape-marks step
  { site: "idle-pass (file damaged)", damage: true, anchor: 'heldStep("memory.shape-marks"', reached: "shape-marks", fire: false, reclaim: false, v7: false, index: "", restore: false, timer: "", exitCode: 0, errors: [] as string[] },
  // the same pass on a healthy file: nothing may reopen it and no row of it may change
  { site: "idle-pass (healthy file)", damage: false, anchor: 'heldStep("memory.shape-marks"', reached: "shape-marks", fire: false, reclaim: false, v7: false, index: "", restore: false, timer: "", exitCode: 0, errors: [] as string[] },
  // POST /api/memory/storage/reclaim answers 202 and arms a 50 ms timer (the preload moves it behind the close, same callback)
  { site: "reclaim-roots timer", damage: false, anchor: "setTimeout(()=>{ void reclaimRootSetsWhenIdle(database()", reached: "reclaim-roots", fire: false, reclaim: true, v7: false, index: "", restore: false, timer: "", exitCode: 0, errors: [] as string[] },
  // the same route on a file that predates the certificate (the v7 conversion row says the space is ready to hand back): the worker variant of the timer
  { site: "reclaim-worker timer", damage: false, anchor: "setTimeout(()=>{ void reclaimLineageSpaceInWorker(database()", reached: "reclaim-worker", fire: false, reclaim: true, v7: true, index: "", restore: false, timer: "", exitCode: 0, errors: [] as string[] },
  // every hourly and daily timer the server armed (the guardedWriter ones among them) fires its own callback once in the window
  { site: "long timers (15 min and over)", damage: false, anchor: "", reached: "", fire: true, reclaim: false, v7: false, index: "", restore: false, timer: "", exitCode: 0, errors: [] as string[] },
  { site: "raw-database", damage: true, anchor: "", reached: "", fire: false, reclaim: false, v7: false, index: "", restore: false, timer: "database", exitCode: 0, errors: [] as string[] },
  // must stay fatal: the absorbing listener only knows the refusal
  // the eager-index build (index.ts memory worker, buildEagerIndexes -> optional-index.ts attempt): an index missing from the file starts a worker thread that
  // opens messages.db BY NAME, so the seal in database() does not reach it. Its first attempt fails at once and leaves a retry timer; the retry runs after the close
  { site: "eager-index retry", damage: false, anchor: "", reached: "", fire: false, reclaim: false, v7: false, timer: "", index: "fail", exitCode: 0, errors: [] as string[] },
  // an index build worker still running when the server closes the file must be ended with it (its connection is a writer of the file)
  { site: "eager-index build in flight", damage: false, anchor: "", reached: "", fire: false, reclaim: false, v7: false, timer: "", index: "slow", exitCode: 0, errors: [] as string[] },
  // the same retry, in the restore handover: POST /api/restore-job/start of a local archive runs closeForSwap (dataWriterGate.stop) and swaps the file in; the
  // retry that wakes after the close must not start a worker on it (the file the swap installs must still be the archive's, to the row)
  { site: "eager-index retry in the restore handover", damage: false, anchor: "", reached: "", fire: false, reclaim: false, v7: false, timer: "", index: "fail", restore: true, exitCode: 75, errors: [] as string[] },
  // the build worker is slow to end (2.5 s after it is asked) and the restore swaps the file in as soon as the writers are reported gone
  { site: "eager-index build in flight at the restore handover", damage: false, anchor: "", reached: "", fire: false, reclaim: false, v7: false, timer: "", index: "slow", restore: true, exitCode: 75, errors: [] as string[] },
  { site: "other-fault", damage: true, anchor: "", reached: "", fire: false, reclaim: false, v7: false, index: "", restore: false, timer: "other-error", exitCode: 1, errors: ["PROBE_OTHER_FAULT"] },
];
// Closes ASTRA n4:6292: the two threads that hold messages.db by name and were not tracked. "counts" = the exact-counts worker (memory/upgrade-counts.ts, a read
// transaction held at SIGTERM or at the restore close); "publish" = the Cloud boot-recovery publisher (email/restore-job.ts startPublish -> workerPublish: a
// (no restore-handover row for the publisher: RestoreJobStore.arm refuses with backup_running while a boot publication is reserved, restore-job.ts arm()) swapped job journal and the data-ops lock busy for 2 s at boot (the preload: the lock path is fixed in /run, which a test container cannot write) make recover() publish "freed"; slow = its write transaction held, late = the setImmediate that starts it runs after the close).
const base = { damage: false, anchor: "", reached: "", fire: false, reclaim: false, v7: false, index: "", timer: "", errors: [] as string[] };
// Closes ASTRA n4:6363: "helper" = the forked memory helper (memory/worker.ts, spawned by worker-controller.ts: its age-index scan holds a read transaction on messages.db),
// which closeForSwap (dataWriterGate.stop) must end and join before the file is closed and the restore unlinks its WAL/SHM (restore-job-effects.ts install).
type Extra = { counts?: string; publish?: string; helper?: string };
const MORE = [
  { ...base, site: "exact-counts worker in flight", counts: "slow", restore: false, exitCode: 0 },
  { ...base, site: "exact-counts worker in flight at the restore handover", counts: "slow", restore: true, exitCode: 75 },
  { ...base, site: "boot-recovery publisher in flight", publish: "slow", restore: false, exitCode: 0 },
  { ...base, site: "boot-recovery publisher started after the close", publish: "late", restore: false, exitCode: 0 },
  { ...base, site: "memory helper process at SIGTERM", helper: "on", restore: false, exitCode: 0 },
  { ...base, site: "memory helper process at the restore handover", helper: "on", restore: true, exitCode: 75 },
  // the helper did not end at the owner's first stop (memory switched off over the real route: stop() hits its kill wait and lets it go), and the restore then finds no helper in its slot: it must still wait for that process
  { ...base, site: "memory helper process let go by an earlier stop, at the restore handover", helper: "stuck", restore: true, exitCode: 75 },
];
const TABLE: Array<(typeof ROWS)[number] & Extra> = [...ROWS, ...MORE];
it.each(TABLE)("after the shutdown close, a late $site of the real server does not reopen messages.db, write it, or throw a schema or SQLite error", { timeout: 240_000 }, async ({ damage, anchor, reached, fire, reclaim, v7, timer, index, restore, exitCode, errors, counts = "", publish = "", helper = "" }) => {
  const root = mkdtempSync(join(tmpdir(), "shutdown-seal-")), home = join(root, "home"), data = join(home, ".murage");
  mkdirSync(data, { recursive: true }); writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {} }));
  const line = anchor ? lineOf(anchor) : 0;
  let started: { child: { kill(signal: NodeJS.Signals): boolean } } | undefined;
  try {
    const port = await freePortBlock([0, 1], 19_871, 200);
    if (index || publish || restore || counts || helper) {
      // a file whose eager indexes are missing and that is not migrating: the build runs after listen, in the memory worker's pass (index.ts buildEagerIndexes)
      const first = startServer(home, port, {});
      expect(await healthOk(port, first), first.out().slice(-4000)).toBe(true);
      first.child.kill("SIGTERM");
      expect(await waitExited(first), first.out().slice(-4000)).toBe(true);
      const db = new DatabaseSync(join(data, "messages.db"));
      try {
        if (index) for (const name of [IDENTITY_CANON_INDEX, IDENTITY_PARTITION_INDEX, WAITING_REVIEW_INDEX, TOMBSTONE_FORGETS_INDEX]) db.exec(`DROP INDEX IF EXISTS ${name}`);
        // (a file that still owes the scrub pass: the server starts its background upgrade work after listen, and with it the exact-counts thread)
        if (counts) db.exec(`DELETE FROM ${SCRUB_PASS_TABLE}`);
        if (publish) {
          // a restore job whose swap is done and whose preparation is owed (the state a boot after a restore finds), and the Cloud data-ops lock held by someone else for 2 s
          db.exec("CREATE TABLE IF NOT EXISTS restore_job_marks (kind TEXT PRIMARY KEY, job_id TEXT NOT NULL)");
          db.exec("INSERT OR REPLACE INTO restore_job_marks (kind, job_id) VALUES ('swapped', 'job1')");
        }
      } finally { db.close(); }
      if (publish) {
        writeFileSync(join(data, "restore-job.json"), JSON.stringify({ version: 1, id: "job1", archiveId: "arc0", source: "owner", phase: "swapped", at: Date.now() }));
        writeFileSync(join(root, "data-ops.lock"), "");
      }
    }
    const archive = join(data, "restore-archives", "arc1", "messages.db");
    if (restore) { mkdirSync(join(data, "restore-archives", "arc1"), { recursive: true }); copyFileSync(join(data, "messages.db"), archive); }
    const run = startServer(home, port, {
      SHUTDOWN_PROBE_ARCHIVE: restore ? archive : "", NODE_OPTIONS: `--import=${PRELOAD}`, SHUTDOWN_PROBE_DB: join(data, "messages.db"), SHUTDOWN_PROBE_TIMER: timer, SHUTDOWN_PROBE_DAMAGE: damage ? "1" : "0",
      SHUTDOWN_PROBE_SITES: reached === "shape-marks" ? `shape-marks=${line}` : "", SHUTDOWN_PROBE_RECLAIM_HOLD: reclaim ? "1500" : "0", SHUTDOWN_PROBE_FIRE: fire ? "1" : "0", SHUTDOWN_PROBE_INDEX: index,
      SHUTDOWN_PROBE_HELPER: helper, SHUTDOWN_PROBE_COUNTS: counts, SHUTDOWN_PROBE_PUBLISH: publish, ...(publish ? { SHUTDOWN_PROBE_LOCK: `${join(root, "data-ops.lock")},2000`, SHUTDOWN_PROBE_LOCK_LINE: String(lineOf('dataOpsLock: process.env.MURAGE_CLOUD_ROLE === "home"')) } : {}),
    });
    started = run;
    expect(await healthOk(port, run), run.out().slice(-4000)).toBe(true);
    if (reclaim) {
      // the route answers 202 once the post-upgrade integrity pass is over (409 until then)
      const headers = await desktopHeaders(port);
      if (v7) {
        // (a second connection, as an older build's file would look: no certificate row, the conversion finished and the space not yet handed back)
        const db = new DatabaseSync(join(data, "messages.db"));
        try {
          db.exec("PRAGMA busy_timeout=10000");
          db.exec("DELETE FROM memory_lineage_cert");
          db.exec("CREATE TABLE IF NOT EXISTS memory_root_set_compaction (id INTEGER PRIMARY KEY CHECK(id=1), total INTEGER NOT NULL CHECK(total>=0), done INTEGER NOT NULL CHECK(done>=0), cursor TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, finished_at INTEGER, reclaimed_at INTEGER)");
          db.exec("INSERT OR REPLACE INTO memory_root_set_compaction(id,total,done,started_at,finished_at) VALUES(1,1,1,1,2)");
        } finally { db.close(); }
      }
      let status = 0;
      for (let tries = 0; tries < 240 && status !== 202; tries++) {
        status = (await fetch(`http://127.0.0.1:${port}/api/memory/storage/reclaim`, { method: "POST", headers, body: "{}" })).status;
        if (status !== 202) await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(status, run.out().slice(-4000)).toBe(202);
    }
    if (index) {
      // the first build attempt ran before the SIGTERM (a build that has not started proves nothing)
      for (let tries = 0; tries < 480 && !run.out().includes("[memory] index build start name="); tries++) await new Promise(resolve => setTimeout(resolve, 250));
      expect(run.out().includes("[memory] index build start name="), run.out().slice(-4000)).toBe(true);
      if (index === "fail") for (let tries = 0; tries < 240 && !run.out().includes("SHUTDOWN-PROBE retry-armed"); tries++) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (counts) {
      // the counting thread started and is inside its read transaction (a thread that has not started proves nothing)
      for (let tries = 0; tries < 80 && !run.out().includes("SHUTDOWN-PROBE counts-worker"); tries++) await new Promise(resolve => setTimeout(resolve, 250));
      expect(probeLines(run.out(), "counts-worker")[0], run.out().slice(-4000)).toBe("slow");
    }
    if (helper) {
      // the memory helper process is forked and running (a row without a helper proves nothing). On an idle server the io budget refuses the helper's start
      // (no owner action in the minute), so the owner switches memory on over the real route right away, and again each second until the boot warm has forked it
      const headers = { ...(await desktopHeaders(port)), "content-type": "application/json" };
      for (let tries = 0; tries < 90 && !run.out().includes("SHUTDOWN-PROBE helper-fork"); tries++) {
        await fetch(`http://127.0.0.1:${port}/api/memory/action`, { method: "POST", headers, body: JSON.stringify({ action: "configure", mode: "active" }) });
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      expect(probeLines(run.out(), "helper-fork").filter(entry => entry.startsWith("before-close")).length, run.out().slice(-4000)).toBe(1);
    }
    if (helper === "stuck") {
      // memory off over the real route: stop() asks the helper to end, is not obeyed, kills it (not delivered) and lets it go after its waits (5 s + 0.5 s)
      await fetch(`http://127.0.0.1:${port}/api/memory/action`, { method: "POST", headers: { ...(await desktopHeaders(port)), "content-type": "application/json" }, body: JSON.stringify({ action: "configure", mode: "off" }) });
      expect(run.out().includes("SHUTDOWN-PROBE helper-kill-skipped"), run.out().slice(-4000)).toBe(true);
    }
    if (publish) {
      // boot recovery found the swapped job and went on to publish (slow: the publisher thread is running; late: its start is held back behind the close)
      for (let tries = 0; tries < 80 && !run.out().includes(publish === "slow" ? "SHUTDOWN-PROBE publish-worker" : "SHUTDOWN-PROBE publish-held"); tries++) await new Promise(resolve => setTimeout(resolve, 250));
      expect(probeLines(run.out(), publish === "slow" ? "publish-worker" : "publish-held").length, run.out().slice(-4000)).toBe(1);
    }
    if (restore) {
      run.child.kill("SIGUSR2");
      const restoring = fetch(`http://127.0.0.1:${port}/api/restore-job/start`, { method: "POST", headers: { ...(await desktopHeaders(port)), "content-type": "application/json" }, body: JSON.stringify({ archiveId: "arc1" }) });
      // (the let-go helper takes the handover 5 s to join: the owner changes the memory settings meanwhile, and nothing may bring a helper back in that window)
      if (helper === "stuck") { await new Promise(resolve => setTimeout(resolve, 1500)); run.child.kill("SIGWINCH"); await fetch(`http://127.0.0.1:${port}/api/memory/action`, { method: "POST", headers: { ...(await desktopHeaders(port)), "content-type": "application/json" }, body: JSON.stringify({ action: "configure", mode: "active" }) }).catch(() => undefined); }
      const answer = await restoring;
      run.child.kill("SIGHUP");
      expect(answer.status, run.out().slice(-4000)).toBe(200);
      // the owner changes the memory settings in the window (POST /api/memory/action configure; its database is closed, so it answers an error)
      if (helper) await fetch(`http://127.0.0.1:${port}/api/memory/action`, { method: "POST", headers: { ...(await desktopHeaders(port)), "content-type": "application/json" }, body: JSON.stringify({ action: "configure", mode: "active" }) }).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 300));
    } else run.child.kill("SIGTERM");
    expect(await waitExited(run), run.out().slice(-4000)).toBe(true);
    const out = run.out();
    const closedAt = out.indexOf("SHUTDOWN-PROBE closed"), closed = probeLines(out, "closed")[0], atExit = probeLines(out, "exit")[0];
    expect(closed, out.slice(-4000)).toBeDefined();
    const afterClose = out.slice(closedAt).split("\n");
    // precondition: the production site ran after the close (an idle pass that did not reach its gate, or a reclaim timer that fired before the close, proves nothing)
    const ran = [...probeLines(out, "reached"), ...probeLines(out, "timer").filter(entry => entry.endsWith("after-close")).map(entry => entry.split(" ")[0]!)];
    expect(ran, out.slice(-4000)).toEqual(reached ? [reached] : []);
    // precondition: the guardedWriter timers of index.ts were armed, and fired in the window
    if (fire) expect((probeLines(out, "long-timers")[0] ?? "").split(",").filter(site => site === `index.ts:${lineOf('guardedWriter("held-reconcile"')}` || site === `index.ts:${lineOf('guardedWriter("room-prune"')}`), out.slice(-4000)).toHaveLength(2);
    // (the restore handover opens the file itself: the job swapping it in is not a late timer)
    const asked = probeLines(out, "reopen").filter(who => !(restore && /(^|<)email\/restore-[\w-]+\.ts:/.test(who))), report = [`closed=${closed?.slice(0, 12)} exit=${atExit?.slice(0, 12)}`, `asked: ${asked.slice(0, 12).join(" | ")}`, ...afterClose].join("\n").slice(0, 3000);
    // (soft: each of the four behaviours below reports its own failing line)
    // nothing asked for the file from the production site this row is about
    expect.soft(line ? asked.filter(who => who.includes(`index.ts:${line}`)) : [], report).toEqual([]);
    // nothing asked for the file from anywhere
    expect.soft(asked.length, report).toBe(0);
    // no row of any table changed after the close (a process that died in the window never reaches the exit probe)
    expect.soft(restore ? 0 : Number(atExit !== undefined && atExit !== closed), report).toBe(0);
    // (the restored file: no index the archive lacks was built into it by a worker of the server that was closing)
    if (restore && (index || counts || publish)) { const db = new DatabaseSync(join(data, "messages.db"), { readOnly: true }); try { expect.soft((db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name IN (?,?,?,?)").all(IDENTITY_CANON_INDEX, IDENTITY_PARTITION_INDEX, WAITING_REVIEW_INDEX, TOMBSTONE_FORGETS_INDEX) as Array<{ name: string }>).map(row => row.name), report).toEqual([]); } finally { db.close(); } }
    // no schema or SQLite error came out of a timer, and the exit status is the one the row names
    expect.soft([...new Set(afterClose.map(text => /MEMORY_SCHEMA_UNSUPPORTED|ERR_SQLITE_ERROR|PROBE_OTHER_FAULT/.exec(text)?.[0]).filter(Boolean))], report).toEqual(errors);
    expect.soft(run.exited(), report).toBe(exitCode);
    // no worker thread of the server was started on messages.db after the close, and none was still alive when the file was handed over
    expect.soft(probeLines(out, "worker").filter(entry => entry.startsWith("after-close")), report).toEqual([]);
    expect.soft(exitCode === 0 ? probeLines(out, "workers-alive")[0] : "0", report).toBe("0");
    // the retry (or the build in flight) of the eager-index rows really was in the window
    // (the exit was awaited, not only asked for: the worker ends 2.5 s after it is asked, and none may be alive when the restore route answers, i.e. right after the swap)
    expect.soft(restore && (index === "slow" || counts === "slow" || publish === "slow") ? probeLines(out, "alive-now")[0] : "0", report).toBe("0");
    // the memory helper process was ended and joined by the close: none alive when the restore route answers (right after the swap) or at the exit, none forked after the close
    if (helper) {
      expect.soft(restore ? probeLines(out, "helper-alive-now")[0] : probeLines(out, "helper-alive")[0], report).toBe("0");
      expect.soft(probeLines(out, "helper-fork").filter(entry => entry.startsWith("after-close")), report).toEqual([]);
    }
    // the late publisher really started after the close, and the server declined (the job's own log line)
    if (publish === "late") { expect.soft(probeLines(out, "publish-fired").length, report).toBe(1); expect.soft(out.includes("boot wait publication: skipped, shutting down"), report).toBe(true); }
    if (index === "fail") expect(probeLines(out, "retry-fired").length, report).toBe(1);
    if (index) expect(probeLines(out, "index-worker")[0], report).toBe(index);
    // a background writer that wakes after the close ends quietly, without logging a failure
    expect.soft(afterClose.filter(text => text.startsWith("[background]")), report).toEqual([]);
  } finally { try { started?.child.kill("SIGKILL"); } catch { /* gone */ } await new Promise(resolve => setTimeout(resolve, 200)); removeTempDirSync(root); }
});
