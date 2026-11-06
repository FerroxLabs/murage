// SPDX-License-Identifier: AGPL-3.0-or-later
// T14 live-file cases (designs/SMOOTH-FTS-MERGE-R6.md §5, §8): REAL crashes. A child process runs the server stack with the real
// wal-maintenance worker (testing/search-merge-crash-child.ts) and is SIGKILLed at a named stage: no orderly close, no checkpoint on
// the way out. This process then opens the same file as the next start does and checks the marker is exactly right and gets paid:
// `done=0` exactly when the proof did not commit, `done=1` until a committed `scrub-done`, and after the scrub no deleted trigram is
// left in the index blocks or the -wal. Plus a worker-initiated log restart (the worker's own commit restarts a fully copied log).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { closeMessageDb, deleteThread, insertMessage } from "./message-db.ts";
import { resumeSearchMerge, searchMergeBusy, searchMergeFastPath, searchMergeOwing, searchMergeTestHooks, type SearchMergeEvent } from "./search-merge-runner.ts";
import { checkpointPassive, stopWalMaintenance, walMaintenanceReady, walMaintenanceTestHooks, walMark, walScrubbed, readWalHeader } from "./wal-maintenance.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { fileHas, markerRow, rawBlocksWith, tombstonePages } from "./testing/search-merge-fixtures.ts";

const walFile = () => join(DATA_DIR, "messages.db-wal");
const CHILD = fileURLToPath(new URL("./testing/search-merge-crash-child.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

beforeEach(async () => {
  closeMessageDb(); closeDatabase(); await stopWalMaintenance();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  walMaintenanceTestHooks.retryMs = 50; searchMergeTestHooks.kickMs = 10; searchMergeTestHooks.onEvent = null; searchMergeTestHooks.halt = false;
});
afterEach(async () => {
  walMaintenanceTestHooks.retryMs = 30_000; searchMergeTestHooks.kickMs = 250; searchMergeTestHooks.onEvent = null; searchMergeTestHooks.halt = false;
  closeMessageDb(); closeDatabase(); await stopWalMaintenance();
});

/** Runs the child to `stage`, then SIGKILLs it. Resolves with its output once it has really exited. */
function crashAt(stage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, stage], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MURAGE_DATA_DIR: DATA_DIR },
    });
    let out = "", err = "", killed = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`child never reached ${stage}: ${out} ${err.slice(-2000)}`)); }, 60_000);
    child.stdout!.on("data", chunk => {
      out += chunk;
      if (!killed && out.includes(`STAGE ${stage}`)) { killed = true; child.kill("SIGKILL"); }
      if (out.includes("ERROR")) { clearTimeout(timer); child.kill("SIGKILL"); reject(new Error(out + err.slice(-2000))); }
    });
    child.stderr!.on("data", chunk => { err += chunk; });
    child.on("exit", (_code, signal) => {
      clearTimeout(timer);
      if (killed && signal === "SIGKILL") resolve(out);
      else if (!killed) reject(new Error(`child exited before ${stage}: ${out} ${err.slice(-2000)}`));
    });
  });
}

/** The next start: open the file as the server does, record the marker it finds, and wait for the scheduler to pay it. */
async function nextStart() {
  const db = database();
  const found = markerRow(db);
  const owingAtOpen = searchMergeOwing();
  await vi.waitFor(() => { expect(walMaintenanceReady()).toBe(true); expect(searchMergeFastPath()).toBe(true); }, { timeout: 15_000 });
  await vi.waitFor(() => { expect(markerRow(db)).toBeUndefined(); expect(searchMergeOwing()).toBe(false); }, { timeout: 30_000, interval: 25 });
  return { db, found, owingAtOpen };
}

describe("T14 real crash (child process, SIGKILL, the real worker)", () => {
  it("killed right after the deletion committed: the next start finds done=0 and pays it", { timeout: 120_000 }, async () => {
    await crashAt("after-delete");
    const { db, found, owingAtOpen } = await nextStart();
    expect(found).toEqual({ done: 0 });
    expect(owingAtOpen).toBe(true);
    expect(rawBlocksWith(db, "жжж")).toBe(0);
    expect(tombstonePages(db)).toBe(false);
    expect(fileHas(walFile(), "жжж")).toBe(false);
  });

  it("killed mid-run (slices committed, no proof): the next start finds done=0, the run resumes from the structure record and settles", { timeout: 120_000 }, async () => {
    await crashAt("mid-run");
    const { db, found } = await nextStart();
    expect(found).toEqual({ done: 0 });
    expect(rawBlocksWith(db, "жжж")).toBe(0);
    expect(fileHas(walFile(), "жжж")).toBe(false);
  });

  it("killed after the proof committed and before scrub-done: the next start finds done=1, scrubs, and deletes the row", { timeout: 120_000 }, async () => {
    await crashAt("after-prove");
    const events: SearchMergeEvent[] = [];
    searchMergeTestHooks.onEvent = event => { events.push(event); };
    const { db, found } = await nextStart();
    expect(found).toEqual({ done: 1 });
    // done=1: the index is already settled, so the next start goes straight to the scrub (no run)
    expect(events.some(e => e.kind === "first")).toBe(false);
    expect(events.some(e => e.kind === "scrub-done")).toBe(true);
    expect(rawBlocksWith(db, "жжж")).toBe(0);
    expect(fileHas(walFile(), "жжж")).toBe(false);
  });

  it("killed after a completed initial scrub, slices that rewrote input suffixes, and the proof: done=1 is found, the scrub runs, the -wal holds no deleted trigram after the restart", { timeout: 120_000 }, async () => {
    const out = await crashAt("scrubbed-then-prove");
    expect(out).toContain("INITIAL-SCRUB done");
    // what the crash left: the deletion's own frames were scrubbed before any slice ran, so any deleted bytes in the log now come from slices
    // (the child holds a reader inside the log from the scrub to the kill, so no idle-tick checkpoint restarts the log under the slices)
    const leftInLog = fileHas(walFile(), "жжж");
    console.log(`[T14] after the crash the -wal ${leftInLog ? "holds" : "does not hold"} the deleted trigram (frames written by slices)`);
    // the precondition the case is about: the slices really left deleted bytes in the log, so the restart's scrub has something to clear
    expect(leftInLog, "the slices left the deleted trigram in the -wal before the restart").toBe(true);
    const { db, found } = await nextStart();
    expect(found).toEqual({ done: 1 });
    expect(fileHas(walFile(), "жжж")).toBe(false);
    expect(rawBlocksWith(db, "жжж")).toBe(0);
  });

  it("a worker-initiated log restart: after a full PASSIVE the worker's own slice commit restarts the log and cuts it to its frames (journal_size_limit=0)", { timeout: 60_000 }, async () => {
    const db = database();
    await vi.waitFor(() => { expect(walMaintenanceReady()).toBe(true); expect(searchMergeFastPath()).toBe(true); }, { timeout: 15_000 });
    let clock = 1;
    const msg = (id: string, text: string): Message => ({ id, role: "user", kind: "text", text, at: ++clock });
    for (let r = 0; r < 12; r++) transaction(() => {
      for (let i = 0; i < 20; i++) insertMessage("keep", msg(`k${r}-${i}`, `kept ${r} ${i} words here`));
      for (let i = 0; i < 4; i++) insertMessage("gone", msg(`g${r}-${i}`, "жжж"));
    });
    await vi.waitFor(() => expect(searchMergeBusy()).toBe(false), { timeout: 15_000 });
    searchMergeTestHooks.halt = true;
    deleteThread("gone");
    // copy the whole log into the file (no writer restarts it yet)
    await vi.waitFor(async () => { const r = await checkpointPassive(); expect(r.busy).toBe(0); expect(r.log).toBe(r.checkpointed); }, { timeout: 10_000 });
    const mark = walMark(walFile());
    expect(mark).not.toBeNull();
    const framesBefore = readWalHeader(walFile()).frames;
    let firstWrite: SearchMergeEvent | undefined;
    searchMergeTestHooks.onEvent = event => { if (!firstWrite && (event.kind === "first" || event.kind === "slice") && event.reply?.busy === 0) firstWrite = event; };
    searchMergeTestHooks.halt = false;
    resumeSearchMerge();
    await vi.waitFor(() => expect(firstWrite).toBeDefined(), { timeout: 10_000 });
    // the worker's slice was the first commit after the full copy: the log restarted under it
    expect(walScrubbed(walFile(), mark)).toBe(true);
    console.log(`[T14] worker-initiated restart: frames before=${framesBefore} after=${readWalHeader(walFile()).frames} first write ms=${firstWrite!.reply!.ms.toFixed(2)}`);
    await vi.waitFor(() => expect(markerRow(db)).toBeUndefined(), { timeout: 30_000 });
  });
});
