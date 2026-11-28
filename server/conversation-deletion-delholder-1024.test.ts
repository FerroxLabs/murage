// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// delholder-1024 (Sean's 1.0.22 logs 11-25..27, triage N2): deleted conversations stayed pending for days. The owner's own Claude Code in
// a terminal (versions/2.1.330, matched by its install path) held the default <HOME>/.claude only because that is where its HOME points,
// and every start gave each of the ~50 pending deletions a whole attempt (470-850 s).
//   W1  a process whose home comes only from the user's default holds it only when it really has it open (its working folder inside
//       it, or a file under it open); an engine variable naming the home, or a process that cannot be read, still holds it.
//   W2  the same rule with the real addon on a real second process (skipped where the addon is not built).
//   W4  a CLI that resumes the conversation between the plan and the execute job still holds the home at the write.
//   W5  that CLI in the deleted conversation holds the home for the looks with no plan too: the retry's look (W5a, one attempt
//       however many looks) and the attempt's own probe (W5b, the attempts the looks force pause no background run).
//   W6  Windows keeps the rule before delholder-1024: a CLI whose USERPROFILE gives the home holds it wherever it works.
//   W3  the start-up pass gives a home found held one attempt; the other deletions owed only on it are left to their quiet retry,
//       which finishes them once the home is free.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { engineState, probeDeletionHomes } from "./engine-closed.ts";
import { exclOps } from "./engine-fs.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import { BOT, buildFixture, canaryHits, THREAD } from "./testing/engine-history-fixtures.ts";
import { builtAddonPath, proc, useFakeExclusion, useRealExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-delholder-1024-")));
const databases: DatabaseSync[] = [];
afterAll(() => { for (const db of databases) db.close(); removeTempDirSync(scratch); });
let counter = 0;
const fresh = (name: string) => { const dir = join(scratch, `${name}-${++counter}`); mkdirSync(dir, { recursive: true }); return dir; };

class InlineWorker extends EventEmitter {
  threadId = 7;
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.emit("message", { type: "result", result: runEngineHistoryJob(message) })); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}

describe("W1/W3 (the process list as the system gives it)", () => {
  let fake: FakeExclusion;
  /** what /proc shows of each listed process: its working folder and its open files (null: cannot be read) */
  const views = new Map<number, { cwd: string | null; files: string[] | null }>();
  beforeEach(() => {
    fake = useFakeExclusion();
    Object.assign(exclOps, {
      procView: "linux",
      procCwd: (pid: number) => (views.has(pid) ? views.get(pid)!.cwd : null),
      procFiles: (pid: number) => (views.has(pid) ? views.get(pid)!.files : null),
    });
    engineHistoryTestHooks.createWorker = () => new InlineWorker() as unknown as Worker;
  });
  afterEach(() => {
    fake.restore(); views.clear(); vi.restoreAllMocks();
    for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
  });

  /** The owner's own Claude Code (the native install, named by its version), not started by Murage. */
  function ownerCli(environment: Record<string, string>, view: { cwd: string | null; files: string[] | null }, args: string[] = []): void {
    const item = proc("/Users/x/.local/share/claude/versions/2.1.330", ["/Users/x/.local/share/claude/versions/2.1.330", ...args], 7100 + counter++);
    fake.processes.push(item);
    fake.environments.set(item.pid, environment);
    views.set(item.pid, view);
  }

  async function deleteWith(setup: (home: string, user: string, folder: string) => void) {
    const fx = buildFixture("claude", scratch);
    const home = fx.homes[0]!.home;
    setup(home, path.dirname(home), fx.folders[0]!);
    const data = join(fx.root, "data");
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, "messages.db"));
    databases.push(db);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [], holdHomes: async () => ({ release: () => {}, skipped: [] }) });
    try {
      const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
      // fx.gone[0]: the conversation's own transcript folder (projects/<its folder>)
      return { report, pending: deletions.pending().length, canaries: canaryHits(fx.root, fx.canaries), transcriptKept: existsSync(fx.gone[0]!) };
    } finally { deletions.dispose(); }
  }

  it("W1a: the owner's Claude Code on the default ~/.claude, working elsewhere with nothing of it open, does not keep the deletion pending", async () => {
    const elsewhere = fresh("project");
    const got = await deleteWith((_home, user) => ownerCli({ HOME: user }, { cwd: elsewhere, files: [join(elsewhere, "notes.md")] }));
    expect(got.report.failed, "a CLI that only has HOME set holds nothing of the home").toEqual([]);
    expect(got.pending).toBe(0);
    expect(got.canaries).toEqual([]);
  });

  it("W1b-h: it still holds the home when it works inside it, has a file of it open, names it in CLAUDE_CONFIG_DIR, cannot be read, is in the deleted conversation, or runs on Windows", async () => {
    const elsewhere = fresh("project");
    const rows: Array<[string, (home: string, user: string, folder: string) => void]> = [
      ["cwd inside", (home, user) => ownerCli({ HOME: user }, { cwd: join(home, "projects"), files: [] })],
      ["file open", (home, user) => ownerCli({ HOME: user }, { cwd: elsewhere, files: [join(home, "history.jsonl")] })],
      ["CLAUDE_CONFIG_DIR", (home) => ownerCli({ HOME: fresh("other"), CLAUDE_CONFIG_DIR: home }, { cwd: elsewhere, files: [] })],
      ["unreadable", (_home, user) => ownerCli({ HOME: user }, { cwd: elsewhere, files: null })],
      // Windows proves a working folder only, never the open files: a default-home CLI there still holds the home
      // the owner's CLI in the deleted conversation itself: resumed by its session id, or working in its folder
      ["resumed", (_home, user) => ownerCli({ HOME: user }, { cwd: elsewhere, files: [] }, ["--resume", "sess-claude-1"])],
      ["in its folder", (_home, user, folder) => ownerCli({ HOME: user }, { cwd: folder, files: [] })],
      // one CLI names the home outright (the open-home pass runs), another `claude -c` works in the conversation's folder
      ["two CLIs", (home, user, folder) => { ownerCli({ HOME: fresh("other"), CLAUDE_CONFIG_DIR: home }, { cwd: fresh("elsewhere"), files: [] }); ownerCli({ HOME: user }, { cwd: folder, files: [] }, ["-c"]); }],
      ["windows", (_home, user) => { Object.assign(exclOps, { procView: "win32" }); ownerCli({ HOME: user }, { cwd: elsewhere, files: [] }); }],
    ];
    for (const [name, setup] of rows) {
      // each row on its own process list: a CLI left from an earlier row (one resumed by the session id) would keep the home whole
      fake.processes.length = 0; fake.environments.clear(); views.clear();
      Object.assign(exclOps, { procView: "linux" });
      const got = await deleteWith(setup);
      expect(got.pending, name).toBe(1);
      expect(got.report.failed.length, name).toBeGreaterThan(0);
      // a CLI in the deleted conversation itself: its transcript is never removed under it (its next append would write it back)
      if (name === "resumed" || name === "in its folder" || name === "two CLIs") expect(got.transcriptKept, `${name}: transcript kept`).toBe(true);
    }
  });

  it("W4: the owner's CLI resuming the conversation after the plan and before the execute job keeps its transcript", async () => {
    const fx = buildFixture("claude", scratch);
    const home = fx.homes[0]!.home;
    let resumed = false;
    // the worker as production runs it, with the owner's `claude --resume <id>` started in the gap between the plan and the execute job
    engineHistoryTestHooks.createWorker = () => {
      const worker = new InlineWorker();
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message: EngineHistoryJob) => {
        if (message.kind === "execute" && !resumed) { resumed = true; ownerCli({ HOME: path.dirname(home) }, { cwd: fresh("elsewhere"), files: [] }, ["--resume", "sess-claude-1"]); }
        post(message);
      };
      return worker as unknown as Worker;
    };
    const data = join(fx.root, "data");
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, "messages.db"));
    databases.push(db);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [], holdHomes: async () => ({ release: () => {}, skipped: [] }) });
    try {
      await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
      expect(resumed, "an execute job ran after a plan").toBe(true);
      expect(existsSync(fx.gone[0]!), "the resumed conversation's transcript is not removed under it").toBe(true);
      expect(deletions.pending()).toHaveLength(1);
    } finally { deletions.dispose(); }
  });

  it("W6: on Windows a CLI whose USERPROFILE gives the home still holds it, working on another drive (its open files cannot be proven)", () => {
    // the whole exclusion in its Windows mode (the paths, the process view and the working-folder proof), not a Linux view of it
    fake.restore();
    fake = useFakeExclusion("win32");
    Object.assign(exclOps, {
      procView: "win32",
      realpathOf: (target: string) => (/^[a-z]:\\/i.test(target) ? target : null),
      winLocalVolume: (target: string) => /^[cd]:/i.test(target),
      winCwd: (pid: number) => (views.has(pid) ? views.get(pid)!.cwd : null),
    });
    const home = "C:\\Users\\x\\.claude";
    const item = proc("C:\\Users\\x\\.local\\share\\claude\\versions\\2.1.330", ["C:\\Users\\x\\.local\\share\\claude\\versions\\2.1.330"], 7900);
    fake.processes.push(item);
    fake.environments.set(item.pid, { USERPROFILE: "C:\\Users\\x" });
    views.set(item.pid, { cwd: "D:\\work", files: null });
    expect(engineState("claude", home).state, "a default-home CLI on Windows working elsewhere").toBe("open");
  });

  /** A deletion with the owner's default-home CLI in the conversation; the first attempt plans the home once and learns its session id. */
  async function heldByItsCli(cwdOf: (folder: string) => string, args: string[], openLooksMax: number) {
    fake.processes.length = 0; fake.environments.clear(); views.clear();
    const fx = buildFixture("claude", scratch);
    const home = fx.homes[0]!.home;
    ownerCli({ HOME: path.dirname(home) }, { cwd: cwdOf(fx.folders[0]!), files: [] }, args);
    const data = join(fx.root, "data");
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, "messages.db"));
    databases.push(db);
    const seen = { pauses: 0, probes: 0 };
    const deletions = new ConversationDeletions({
      dataDir: data, database: () => db, retryDelaysMs: [40], openRetryMs: 40, openLooksMax,
      holdHomes: async () => ({ release: () => {}, skipped: [] }),
      pauseBackgroundRuns: async () => { seen.pauses++; return () => {}; },
      probeHomes: (owed) => { seen.probes++; return probeDeletionHomes(owed, join(data, "native")); },
    });
    const finish = vi.spyOn(deletions, "finish");
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    return { fx, deletions, finish, seen, first: { ...seen } };
  }
  const inConversation: Array<[string, (folder: string) => string, string[]]> = [
    ["resumed", () => fresh("elsewhere"), ["--resume", "sess-claude-1"]],
    ["in its folder", (folder) => folder, ["-c"]],
  ];

  it("W5a: a default-home CLI in the deleted conversation keeps the retry's looks quiet: one attempt over many looks", async () => {
    for (const [name, cwdOf, args] of inConversation) {
      const { fx, deletions, finish, seen } = await heldByItsCli(cwdOf, args, 1000);
      try {
        await vi.waitFor(() => expect(seen.probes, `${name}: looks taken`).toBeGreaterThanOrEqual(8), { timeout: 10_000, interval: 20 });
        // every look (probeDeletionHomes) sees the CLI as the attempt's gate did: no whole attempt at each look
        expect(finish.mock.calls.length, `${name}: attempts while the CLI runs`).toBe(1);
        expect(existsSync(fx.gone[0]!), `${name}: transcript kept`).toBe(true);
        expect(deletions.pending(), name).toHaveLength(1);
      } finally { deletions.dispose(); }
    }
  });

  it("W5b: the attempts the looks force on that home pause no background run (the attempt's own probe sees the CLI)", async () => {
    for (const [name, cwdOf, args] of inConversation) {
      const { fx, deletions, finish, seen, first } = await heldByItsCli(cwdOf, args, 1);
      try {
        // two forced attempts after the first: each attempt and each look count one skip, so the home's whole try (FULL_TRY_EVERY = 6
        // skips, at most one per FULL_TRY_MS, which pauses as designed) is not reached yet
        await vi.waitFor(() => expect(finish.mock.calls.length, `${name}: attempts`).toBeGreaterThanOrEqual(3), { timeout: 10_000, interval: 5 });
        expect(finish.mock.calls.length, `${name}: attempts`).toBe(3);
        // probeEngineHomes, with the ids the first attempt found: each later attempt leaves the home before anything is paused
        expect(seen.pauses, `${name}: background runs paused after the first attempt`).toBe(first.pauses);
        expect(existsSync(fx.gone[0]!), `${name}: transcript kept`).toBe(true);
      } finally { deletions.dispose(); }
    }
  });

  /** Deleted conversations' Fuigo search rows, one per thread. */
  function fuigoSetup(threads: string[]) {
    const data = fresh("data"), fuigoHome = fresh("fuigo");
    const db = new DatabaseSync(join(data, "messages.db"));
    databases.push(db);
    db.exec("CREATE TABLE IF NOT EXISTS messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
    const index = join(fuigoHome, "sessions", "session_search.sqlite");
    mkdirSync(path.dirname(index), { recursive: true });
    const seeded = new DatabaseSync(index);
    seeded.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_docs (session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS session_docs_fts USING fts5(title, content, content='session_docs', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS session_docs_ai AFTER INSERT ON session_docs BEGIN
        INSERT INTO session_docs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content); END;
      CREATE TRIGGER IF NOT EXISTS session_docs_ad AFTER DELETE ON session_docs BEGIN
        INSERT INTO session_docs_fts(session_docs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content); END;`);
    threads.forEach((thread, n) => {
      const desk = join(data, "workspaces", BOT, "threads", thread);
      mkdirSync(desk, { recursive: true });
      writeFileSync(join(desk, "a.md"), "x");
      seeded.prepare("INSERT INTO session_docs(session_id, cwd, updated_at, title, content, content_hash) VALUES (?,?,?,?,?,?)").run(`gone-${n}`, desk, 1, "t", "private-words-1024", "h");
    });
    seeded.exec("PRAGMA wal_checkpoint(TRUNCATE)"); seeded.close();
    return { data, fuigoHome, db, index };
  }

  it("W3: at start-up ten deletions owed on one held home get one attempt; the rest finish on their quiet retry once it is free", async () => {
    const threads = Array.from({ length: 10 }, (_, n) => `${n.toString(16).padStart(8, "0")}-6f1e-4c0a-9d42-51a6e8f0c311`);
    const { data, fuigoHome, db, index } = fuigoSetup(threads);
    const closeOwner = fake.openEngine("fuigo"); // the owner's own program in a terminal, for the whole start-up pass
    const homes = [{ engine: "fuigo" as const, home: fuigoHome }];
    const before = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [], holdHomes: async () => ({ release: () => {}, skipped: [] }) });
    for (const thread of threads) await runConversationDeletion(before, { threadIds: [thread], engineHomes: homes }, () => true);
    expect(before.pending()).toHaveLength(10);
    before.dispose();
    // the next start
    const after = new ConversationDeletions({
      // the first retry waits 2 s, so every probe counted below is one the start-up pass itself made
      dataDir: data, database: () => db, retryDelaysMs: [2_000, 40, 40, 40, 40, 40], openRetryMs: 40, openLooksMax: 1000,
      holdHomes: async () => ({ release: () => {}, skipped: [] }),
      probeHomes: (owed) => { probes++; return probeDeletionHomes(owed, join(data, "native")); },
    });
    let probes = 0;
    const finish = vi.spyOn(after, "finish");
    try {
      await after.reconcile(() => false, () => {});
      expect(finish.mock.calls.length, "one attempt learns the home is held; the other nine are not tried again now").toBe(1);
      expect(probes, "the holders of the one owed home are read once in the pass, not once per deletion (lsof on macOS)").toBe(1);
      expect(after.pending()).toHaveLength(10);
      closeOwner();
      await vi.waitFor(() => expect(after.pending()).toEqual([]), { timeout: 10_000 });
      const check = new DatabaseSync(index);
      try { expect(check.prepare("SELECT count(*) AS n FROM session_docs").get()).toEqual({ n: 0 }); } finally { check.close(); }
    } finally { after.dispose(); }
  });
});

const built = builtAddonPath();
describe.skipIf(!built || process.platform !== "linux")("W2: the real addon on a real second process", () => {
  const children: ChildProcess[] = [];
  let restore: (() => void) | undefined;
  afterEach(() => {
    for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    restore?.(); restore = undefined;
  });
  const sleepMs = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
  function start(env: Record<string, string>, cwd: string, script = "setInterval(() => {}, 1000)"): ChildProcess {
    const child = spawn(process.execPath, ["-e", script], { env: { PATH: process.env.PATH ?? "", ...env }, cwd, stdio: "ignore", argv0: "claude" });
    children.push(child);
    for (let tries = 0; tries < 200 && !exclOps.environment(child.pid!, ["HOME"])?.HOME; tries++) sleepMs(10);
    return child;
  }
  const settles = (home: string, want: string) => { for (let tries = 0; tries < 200; tries++) { if (engineState("claude", home).state === want) return true; sleepMs(10); } return false; };

  it("a real `claude` whose HOME gives the home, working elsewhere, leaves it closed; working inside it or holding a file of it, open", () => {
    restore = useRealExclusion(built!);
    const user = fresh("user"), home = join(user, ".claude"), elsewhere = fresh("work");
    mkdirSync(home, { recursive: true });
    const outside = start({ HOME: user }, elsewhere);
    expect(settles(home, "closed"), "HOME alone, cwd elsewhere").toBe(true);
    outside.kill("SIGKILL");
    const inside = start({ HOME: user }, home);
    expect(settles(home, "open"), "cwd inside the home").toBe(true);
    inside.kill("SIGKILL");
    const file = join(home, "history.jsonl");
    closeSync(openSync(file, "a"));
    start({ HOME: user }, elsewhere, `require("node:fs").openSync(${JSON.stringify(file)}, "r"); setInterval(() => {}, 1000)`);
    expect(settles(home, "open"), "a file of the home open").toBe(true);
  });
});
