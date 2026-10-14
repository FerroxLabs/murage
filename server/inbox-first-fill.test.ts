// SPDX-License-Identifier: AGPL-3.0-or-later
// The Inbox projection's first fill on an installation that predates it runs
// after the server listens, in short background slices, and the Inbox says it
// is getting ready meanwhile: /api/health is answered first, and no list or
// count is ever served as complete while the history is still being read.
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { initializeInbox, inboxProjectionReady, inboxProjectionStep, listInbox, startInboxProjectionFill } from "./inbox.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const SECRET = "0123456789abcdef".repeat(4);
const CARDS = 2_000, ROWS = 120_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A history written before the projection existed: chat lines and owed approval cards. */
function history(db: DatabaseSync, rows = ROWS, cards = CARDS) {
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  const every = Math.floor(rows / cards);
  db.exec("BEGIN");
  for (let i = 0; i < rows; i++) {
    const thread = `t${i % 40}`, id = `m${i}`, at = 1_700_000_000_000 + i * 1000;
    if (i % every === 0) insert.run(thread, id, at, "bot", "options", null, JSON.stringify({ id, at, role: "bot", kind: "options", card: { requestId: `req${i}`, title: "Command", options: ["Allow", "Deny"], tool: "Bash" } }));
    else insert.run(thread, id, at, "user", "text", `line ${i}`, JSON.stringify({ id, at, role: "user", kind: "text", text: `line ${i}` }));
  }
  db.exec("COMMIT");
}

describe("the first fill, in process", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } } });
  const access = { owner: true, threads: Array.from({ length: 40 }, (_, i) => ({ threadId: `t${i}`, label: `Bot ${i}` })) };

  it("says it is getting ready until every message is read, then answers in full", async () => {
    const db = new DatabaseSync(":memory:"); databases.push(db);
    initializeMessageTables(db);
    history(db, 40_000, 400);
    initializeInbox(db);
    const early = listInbox(db, { view: "decisions" }, access);
    expect(early).toMatchObject({ preparing: true, items: [], total: 0, decisions: 0 });
    // part of the history read is still "getting ready", never a short list
    inboxProjectionStep(db, 10_000);
    expect(listInbox(db, { view: "decisions" }, access).preparing).toBe(true);
    const fill = startInboxProjectionFill(db);
    expect(await fill.done).toEqual({ filled: true });
    console.log(`[fill] slices=${fill.stats.slices} max=${fill.stats.maxSliceMs.toFixed(1)} ms`);
    expect(fill.stats.maxSliceMs).toBeLessThanOrEqual(50);
    expect(inboxProjectionReady(db)).toBe(true);
    const page = listInbox(db, { view: "decisions" }, access);
    expect(page.preparing).toBeUndefined();
    expect(page.total).toBe(400);
  });

  it("resumes from its cursor after an interrupted run, and a new installation is ready at once", () => {
    const db = new DatabaseSync(":memory:"); databases.push(db);
    initializeMessageTables(db);
    history(db, 10_000, 100);
    initializeInbox(db);
    inboxProjectionStep(db, 4_000);
    // a message written meanwhile is projected by the triggers, and kept
    db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)")
      .run("t1", "new", 1_800_000_000_000, "bot", "options", null, JSON.stringify({ id: "new", at: 1_800_000_000_000, role: "bot", kind: "options", card: { requestId: "new", title: "Command", options: ["Allow"], tool: "Bash" } }));
    initializeInbox(db); // the next start: the same layout, nothing rebuilt
    while (!inboxProjectionStep(db, 1_500)) { /* next slice */ }
    expect(listInbox(db, { view: "decisions" }, access).total).toBe(101);
    const fresh = new DatabaseSync(":memory:"); databases.push(fresh);
    initializeMessageTables(fresh); initializeInbox(fresh);
    expect(inboxProjectionReady(fresh)).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("the first fill at server start", () => {
  let child: ChildProcess | undefined, home = "";
  afterAll(async () => { if (child) await waitForExit(child, { signal: "SIGTERM" }); if (home) await removeTempDir(home); });

  it("answers /api/health first, then says the Inbox is getting ready until the fill is done", async () => {
    const port = await freePortBlock([0, 1], 19_399, 200);
    const base = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), "murage-inbox-fill-"));
    const dataDir = join(home, ".murage");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {} }));
    // An installation from before the projection: its messages, no projection.
    const seeded = new DatabaseSync(join(dataDir, "messages.db"));
    initializeMessageTables(seeded);
    history(seeded);
    seeded.close();
    let stdout = "", stderr = "";
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_TURN_TRACE: "1", MURAGE_DEV_DESKTOP_SECRET: SECRET },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => (stdout += chunk));
    child.stderr!.on("data", chunk => (stderr += chunk));
    const deadline = Date.now() + 90_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await sleep(10);
    }
    const inbox = async () => (await (await fetch(`${base}/api/inbox?view=decisions`, { headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": SECRET } })).json()) as { preparing?: boolean; total: number; decisions: number };
    // Health answered; the history is still being read: said, not shown.
    const first = await inbox();
    expect(first.preparing, stdout).toBe(true);
    expect(first.total).toBe(0);
    let answer = first;
    while (answer.preparing && Date.now() < deadline) { await sleep(50); answer = await inbox(); }
    expect(answer.preparing).toBeUndefined();
    while (!stdout.includes("phase=startup.deferred.done") && Date.now() < deadline) await sleep(20);
    const phases = [...stdout.matchAll(/phase=startup\.([\w.]+) ms=(\d+)/g)].map(match => match[1]!);
    expect(phases.indexOf("deferred.inboxProjection"), stdout).toBeGreaterThan(phases.indexOf("health.answered"));
    expect(phases.indexOf("health.answered")).toBeGreaterThan(-1);
    // every card of the history is in the projection (the boot sweep may
    // have marked them orphaned since: their request died with no process)
    const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
    try {
      expect((db.prepare("SELECT done FROM inbox_projection_state WHERE name='inbox'").get() as { done: number }).done).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS n FROM inbox_items WHERE kind='options'").get() as { n: number }).n).toBe(CARDS);
    } finally { db.close(); }
  }, 120_000);
});
