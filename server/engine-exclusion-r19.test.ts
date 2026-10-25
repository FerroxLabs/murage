// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r19: Murage removes a deleted conversation from an engine's files ONLY while that engine is closed. The process list is modelled
// (testing/engine-exclusion-fake.ts); engine-exclusion.test.ts runs the same flows against the real addon and real second processes.
// The first group is the window itself (open before, open after, launched in between, cannot be told, a hold that failed, a verifying
// plan made while the engine was open); the second group is each r18 finding with the interleaving that reproduced it.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationDeletions, ownerNoticeText, runConversationDeletion } from "./conversation-deletion.ts";
import { engineState, processState } from "./engine-closed.ts";
import { executeEnginePlans } from "./engine-exec.ts";
import { forgetExclusionAddon, loadExclusionAddon, type NativeProcess } from "./engine-exclusion.ts";
import { exclOps, mutOps } from "./engine-fs.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { planEngineHistory, removeEngineHistoryFiles, runEngineHistoryJob } from "./engine-history-run.ts";
import { homeKey } from "./engine-plan-core.ts";
import { importsOf } from "./engine-structure-check.ts";
import { proc, useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture, canaryHits, walDatabase, type Fixture } from "./testing/engine-history-fixtures.ts";
import { validateEngineExclusionResource } from "../scripts/engine-exclusion-resource.mjs";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r19-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); });
afterEach(() => {
  fake.restore();
  vi.restoreAllMocks();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const job = (fx: Fixture, extra: Record<string, unknown> = {}) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const, ...extra });
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const C = (engine: string) => `canary-${engine}-5521`;
const run = (fx: Fixture, planned = planEngineHistory(job(fx))) => executeEnginePlans(structuredClone(planned.plans!));
const whole = (fx: Fixture, planned = planEngineHistory(job(fx))) => removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
const ASIDE = ".murage-deleting";
const writes = () => fake.calls.filter((call) => call === "pwrite" || call === "fsync" || call.startsWith("renameNoReplace") || call.startsWith("delete "));
const claudeHistory = (fx: Fixture) => join(fx.homes[0]!.home, "history.jsonl");
const claudeProject = (fx: Fixture) => join(fx.homes[0]!.home, "projects", fx.folders[0]!.replace(/[^a-zA-Z0-9]/g, "-"));
const HASH = "ab12cd34ef56ab12";
const codexTid = "019a0000-aaaa-7bbb-8ccc-000000000001";
const codexRollout = (fx: Fixture) => join(fx.homes[0]!.home, "sessions", "2026", "10", "11", `rollout-2026-10-11T10-00-00-${codexTid}.jsonl`);

class ScriptedWorker extends EventEmitter {
  threadId = 11;
  readonly script: (job: EngineHistoryJob, worker: ScriptedWorker) => void;
  constructor(script: (job: EngineHistoryJob, worker: ScriptedWorker) => void) { super(); this.script = script; }
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.script(message, this)); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}

// ── the window: the engine must be closed before, in between and after ────────────────────────────────────────────────────

describe("an engine's files are changed only while that engine is closed", () => {
  it("an engine open before the steps: not one write, not one rename, and the home says engine-open", () => {
    for (const [engine, exe] of [["claude", "claude"], ["codex", "codex"], ["fuigo", "fuigo"]] as const) {
      const fx = buildFixture(engine, scratch);
      const planned = planEngineHistory(job(fx));
      const release = fake.openEngine(exe);
      fake.calls.length = 0;
      const ran = run(fx, planned);
      expect(ran.homeReasons[key(fx)], engine).toBe("engine-open");
      expect(ran.failedHomes, engine).toEqual([key(fx)]);
      expect(ran.staleHomes, engine).toEqual([]);
      expect(writes(), engine).toEqual([]);
      expect(canaryHits(fx.root, fx.canaries).length, engine).toBeGreaterThan(0); // nothing was removed
      release();
      expect(run(fx, planEngineHistory(job(fx))).failed, engine).toEqual([]);
      expect(canaryHits(fx.root, fx.canaries), engine).toEqual([]);
    }
  });

  it("an engine launched between the first and the second look: still nothing is written", () => {
    const fx = buildFixture("claude", scratch);
    const planned = planEngineHistory(job(fx));
    fake.onProcesses = (call) => (call >= 2 ? [proc("/usr/local/bin/claude")] : []);
    fake.calls.length = 0;
    const ran = run(fx, planned);
    expect(ran.homeReasons[key(fx)]).toBe("engine-open");
    expect(writes()).toEqual([]);
    expect(readFileSync(claudeHistory(fx), "utf8")).toContain(C("claude"));
  });

  it("an engine that opens while the steps run: the home stays pending (the next attempt verifies it)", () => {
    const fx = buildFixture("claude", scratch);
    const planned = planEngineHistory(job(fx));
    fake.onProcesses = () => (fake.calls.includes("pwrite") ? [proc("/usr/local/bin/claude")] : []);
    const ran = run(fx, planned);
    expect(ran.homeReasons[key(fx)]).toBe("engine-open");
    expect(ran.failedHomes).toEqual([key(fx)]);
    // and a whole run does not call it finished
    const again = buildFixture("claude", scratch);
    fake.onProcesses = () => (fake.calls.includes("pwrite") ? [proc("/usr/local/bin/claude")] : []);
    const result = whole(again);
    expect(result.failedHomes).toContain(key(again));
    expect(result.homeReasons?.[key(again)]).toBe("engine-open");
  });

  it("an engine that cannot be told is not written to, and is not called open: the home says it could not check", () => {
    const fx = buildFixture("claude", scratch);
    const planned = planEngineHistory(job(fx));
    // a process of this user whose program and name cannot be seen
    fake.processes = [{ pid: 4242, ppid: 1, mine: true, start: 1, exe: null, argv: null }];
    fake.calls.length = 0;
    expect(run(fx, planned).homeReasons[key(fx)]).toBe("engine-unchecked");
    expect(writes()).toEqual([]);
    // a node process whose arguments cannot be read
    fake.processes = [{ pid: 4243, ppid: 1, mine: true, start: 1, exe: "/usr/bin/node", argv: null }];
    expect(run(fx, planned).homeReasons[key(fx)]).toBe("engine-unchecked");
    // the process list itself cannot be read
    fake.processes = [];
    fake.processesFail = true;
    expect(run(fx, planned).homeReasons[key(fx)]).toBe("engine-unchecked");
    expect(writes()).toEqual([]);
    fake.processesFail = false;
    expect(run(fx, planned).failed).toEqual([]);
  });

  it("who counts as the engine: its program, its package under node or python, its bundle; not this process, not another user's, not a bystander", () => {
    const node = (script: string) => proc("/usr/local/bin/node", ["/usr/local/bin/node", script]);
    const closed = (engine: string, list: NativeProcess[]) => processState(engine, list, 1);
    expect(closed("claude", [proc("/home/u/.local/share/claude/versions/2.1.296", ["claude", "--resume"])])).toBe("open");
    expect(closed("claude", [node("/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js")])).toBe("open");
    expect(closed("claude", [proc("/Applications/Claude.app/Contents/MacOS/Claude")])).toBe("open");
    expect(closed("codex", [proc("/usr/bin/codex", ["codex", "app-server"])])).toBe("open");
    expect(closed("codex", [node("/usr/lib/node_modules/@openai/codex/bin/codex.js")])).toBe("open");
    expect(closed("gemini", [node("/usr/lib/node_modules/@google/gemini-cli/dist/index.js")])).toBe("open");
    expect(closed("qwen", [node("/usr/lib/node_modules/@qwen-code/qwen-code/cli.js")])).toBe("open");
    expect(closed("kimi", [proc("/usr/bin/python3", ["python3", "/home/u/.local/bin/kimi"])])).toBe("open");
    expect(closed("hermes", [proc("/usr/bin/python3", ["python3", "/home/u/.local/bin/hermes", "chat"])])).toBe("open");
    expect(closed("opencode", [proc("/usr/local/bin/opencode", ["opencode", "serve"])])).toBe("open");
    expect(closed("droid", [proc("/usr/local/bin/droid")])).toBe("open");
    expect(closed("cursor", [proc("/Applications/Cursor.app/Contents/MacOS/Cursor")])).toBe("open");
    expect(closed("cursor", [node("/home/u/.local/share/cursor-agent/versions/1/index.js")])).toBe("open");
    expect(closed("antigravity", [proc("/Applications/Antigravity.app/Contents/Resources/app/bin/language_server_macos_arm")])).toBe("open");
    expect(closed("fuigo", [proc("/opt/murage/fuigo")])).toBe("open");
    // not the engine
    expect(closed("claude", [node("/home/u/project/server.js"), proc("/usr/bin/vim", ["vim", "claude-notes.txt"])])).toBe("closed");
    expect(closed("claude", [{ ...proc("/usr/bin/claude"), mine: false }])).toBe("open"); // whoever runs it
    expect(processState("claude", [{ ...proc("/usr/bin/claude"), pid: 77 }], 77)).toBe("closed"); // this process
    expect(closed("claude", [{ pid: 9, ppid: 1, mine: false, start: 1, exe: null, argv: null }])).toBe("unknown"); // neither its program nor its name can be read
    expect(closed("claude", [{ pid: 9, ppid: 1, mine: true, start: 1, exe: "", argv: [] }])).toBe("closed"); // a zombie
    expect(closed("claude", [node("/home/u/other/script.js")])).toBe("closed");
    expect(closed("nobody", [])).toBe("unknown");
  });

  it("an engine's own lock is part of 'open': Codex's and Fuigo's whole-file locks, Claude's fresh history lock, an IDE lock", () => {
    const codex = buildFixture("codex", scratch);
    const log = join(codex.homes[0]!.home, "history.jsonl");
    const release = fake.keepLock(log);
    expect(engineState("codex", codex.homes[0]!.home).state).toBe("open");
    release();
    expect(engineState("codex", codex.homes[0]!.home).state).toBe("closed");
    const claude = buildFixture("claude", scratch);
    const home = claude.homes[0]!.home;
    mkdirSync(`${claudeHistory(claude)}.lock`);
    expect(engineState("claude", home).state).toBe("open");
    utimesSync(`${claudeHistory(claude)}.lock`, new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
    expect(engineState("claude", home).state).toBe("closed"); // abandoned by the engine's own 10 s rule
    mkdirSync(join(home, "ide"), { recursive: true });
    writeFileSync(join(home, "ide", "1.lock"), JSON.stringify({ pid: 5151 }));
    expect(engineState("claude", home).state).toBe("closed"); // its process is not running
    fake.processes = [{ ...proc("/usr/bin/code"), pid: 5151 }];
    expect(engineState("claude", home).state).toBe("open");
    fake.processes = [];
    writeFileSync(join(home, "ide", "1.lock"), "not json");
    expect(engineState("claude", home).state).toBe("unknown"); // cannot be read
  });

  it("a home that was changed is finished only when the plan that shows nothing left was made while its engine was closed", () => {
    const fx = buildFixture("claude", scratch);
    // the steps run with the engine closed; the engine opens as soon as the last of the content is gone, before the window's last look
    fake.onProcesses = () => (canaryHits(fx.root, fx.canaries).length === 0 ? [proc("/usr/local/bin/claude")] : []);
    const result = whole(fx);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]); // the content is gone
    expect(result.failedHomes).toContain(key(fx)); // but it is not called done
    expect(result.homeReasons?.[key(fx)]).toBe("engine-open");
    // with the engine closed throughout, the same run is finished
    fake.onProcesses = undefined;
    fake.processes = [];
    const clean = buildFixture("claude", scratch);
    expect(whole(clean).failedHomes).toEqual([]);
    // and the plan says which homes it saw closed
    expect(planEngineHistory(job(clean)).closedHomes).toEqual([key(clean)]);
    const release = fake.openEngine("claude");
    expect(planEngineHistory(job(clean)).closedHomes).toEqual([]);
    release();
  });

  it("the service: an engine that is open leaves the pending line in the owner's words, with Try again, and changes nothing; closing it finishes the removal", async () => {
    const fx = buildFixture("fuigo", scratch);
    const data = join(fx.root, "data");
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [], owedGraceMs: 0 });
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker((message, worker) => worker.emit("message", { type: "result", result: runEngineHistoryJob(message) })) as unknown as Worker;
    const release = fake.openEngine("fuigo");
    const first = await runConversationDeletion(deletions, { threadIds: ["2e9018ee-1f45-46be-8ed1-7a02fc022807"], engineHomes: fx.homes }, () => true);
    expect(first.report.failed).toContain(fx.homes[0]!.home);
    expect(writes()).toEqual([]);
    expect(deletions.notices().map((item) => [item.text, item.tryAgain])).toEqual([["Fuigo is open. Murage finishes removing this conversation from it by itself once Fuigo is closed. Nothing is needed from you.", true]]);
    release();
    expect((await deletions.retryNow()).finished).toEqual(["fuigo"]);
    expect(deletions.pending()).toEqual([]);
    expect(deletions.notices()).toEqual([]); // F16: no "Removed from" line
    deletions.dispose();
  });

  it("the service asks again every openRetryMs while an engine is open, after the schedule has run out, and finishes once it is closed", async () => {
    const fx = buildFixture("fuigo", scratch);
    const data = join(fx.root, "data");
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [5], openRetryMs: 20, staleQuietMs: 0 });
    let jobs = 0;
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker((message, worker) => { jobs++; worker.emit("message", { type: "result", result: runEngineHistoryJob(message) }); }) as unknown as Worker;
    const release = fake.openEngine("fuigo");
    await runConversationDeletion(deletions, { threadIds: ["2e9018ee-1f45-46be-8ed1-7a02fc022807"], engineHomes: fx.homes }, () => true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(jobs).toBeGreaterThan(6); // well past the one listed pause
    expect(deletions.pending().length).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(deletions.pending()).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    deletions.dispose();
  }, 20_000);

  it("the service: Murage's own sessions that cannot be held leave the home untouched, and the owner is not told an engine is open (none was seen)", async () => {
    const fx = buildFixture("fuigo", scratch);
    const data = join(fx.root, "data");
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [], holdHomes: async () => { throw new Error("close failed"); } });
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker((message, worker) => worker.emit("message", { type: "result", result: runEngineHistoryJob(message) })) as unknown as Worker;
    fake.calls.length = 0;
    const first = await runConversationDeletion(deletions, { threadIds: ["2e9018ee-1f45-46be-8ed1-7a02fc022807"], engineHomes: fx.homes }, () => true);
    expect(first.report.failed).toContain(fx.homes[0]!.home);
    expect(writes()).toEqual([]);
    expect(deletions.pending()[0]!.owed?.items.map((item) => [item.engine, item.code])).toEqual(fx.homes.map(() => ["fuigo", "engine-unchecked"]));
    expect(canaryHits(fx.root, fx.canaries).length).toBeGreaterThan(0);
    deletions.dispose();
  });

  it("the owner's words", () => {
    expect(ownerNoticeText("Codex", "engine-open")).toBe("Codex is open. Murage finishes removing this conversation from it by itself once Codex is closed. Nothing is needed from you.");
    expect(ownerNoticeText("Claude Code", "engine-open")).not.toMatch(/—|–|\bsafe(ly|ty)?\b|\bunsafe\b/i);
  });
});

// ── r18 findings ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("r18-1: Claude's history lock is taken before the history is looked for", () => {
  it("the history is gone after the plan; Claude makes it, with a row that names the paste, before the paste is removed: the paste stays", () => {
    const fx = buildFixture("claude", scratch);
    const history = claudeHistory(fx);
    const paste = join(fx.homes[0]!.home, "paste-cache", `${HASH}.txt`);
    const planned = planEngineHistory(job(fx));
    rmSync(history);
    const lock = `${history}.lock`;
    const real = exclOps.renameNoReplace;
    // the moment Murage's lock takes its name, Claude's row (which names the paste) is already there: the check must see it
    exclOps.renameNoReplace = ((from: string, to: string) => { const out = real(from, to); if (to === lock && out === "ok") writeFileSync(history, dump({ sessionId: "sess-new", project: "/other", pastedContents: { 1: { contentHash: HASH } } })); return out; }) as typeof real;
    try { run(fx, planned); } finally { exclOps.renameNoReplace = real; }
    expect(existsSync(paste)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("r18-2: Claude's directory lock cannot be stolen, outlive its budget, or be removed after its owner changed", () => {
  const lockOf = (fx: Fixture) => `${claudeHistory(fx)}.lock`;

  it("a stale lock replaced by a fresh one before it is removed: the fresh one stays and nothing is written", () => {
    const fx = buildFixture("claude", scratch);
    const lock = lockOf(fx);
    const planned = planEngineHistory(job(fx));
    const before = readFileSync(claudeHistory(fx));
    mkdirSync(lock);
    const old = new Date(Date.now() - 30_000);
    utimesSync(lock, old, old);
    // the third look at the process list is the stale removal's own: the engine takes the lock just then
    fake.onProcesses = (call) => {
      if (call === 3) { removeTempDirSync(lock); mkdirSync(lock); writeFileSync(join(lock, "engine"), "engine"); }
      return [];
    };
    const ran = run(fx, planned);
    expect(ran.homeReasons[key(fx)]).toBe("engine-open");
    expect(readFileSync(join(lock, "engine"), "utf8")).toBe("engine");
    expect(readFileSync(claudeHistory(fx)).equals(before)).toBe(true);
  });

  it("11 seconds pass while the lock is held: the step stops before it writes (twice, so the home is planned again), and lets go of its own lock", () => {
    const fx = buildFixture("claude", scratch);
    const planned = planEngineHistory(job(fx));
    const realNow = mutOps.now;
    let offset = 0;
    mutOps.now = () => realNow() + offset;
    const real = mutOps.openReadWrite;
    mutOps.openReadWrite = ((path: string) => { if (path === claudeHistory(fx)) offset += 11_000; return real(path); }) as typeof mutOps.openReadWrite;
    fake.calls.length = 0;
    let ran!: ReturnType<typeof run>;
    try { ran = run(fx, planned); } finally { mutOps.openReadWrite = real; mutOps.now = realNow; }
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(fake.calls.includes("pwrite")).toBe(false);
    expect(readFileSync(claudeHistory(fx), "utf8")).toContain(C("claude"));
    expect(existsSync(lockOf(fx))).toBe(false);
  });

  it("the lock folder is replaced by another while the work runs: it is not removed at the end", () => {
    const fx = buildFixture("claude", scratch);
    const lock = lockOf(fx);
    const planned = planEngineHistory(job(fx));
    const realFsync = mutOps.fsync;
    let swapped = false;
    mutOps.fsync = ((fd: never) => {
      realFsync(fd);
      if (!swapped) {
        swapped = true;
        const other = `${lock}-other`;
        mkdirSync(other); // a different folder (a different inode) takes the name
        writeFileSync(join(other, "engine"), "engine");
        removeTempDirSync(lock);
        renameSync(other, lock);
      }
    }) as typeof mutOps.fsync;
    try { run(fx, planned); } finally { mutOps.fsync = realFsync; }
    expect(swapped).toBe(true);
    expect(readFileSync(join(lock, "engine"), "utf8")).toBe("engine"); // still there: it was never Murage's
  });
});

describe("r18-3: on Windows a file that died with its handle is never unlinked by name", () => {
  it("a replacement made at the name before the folder is cleaned up survives, and the home is planned again", () => {
    fake.restore();
    fake = useFakeExclusion("win32");
    const fx = buildFixture("claude", scratch);
    const transcript = join(claudeProject(fx), "sess-claude-1.jsonl");
    const planned = planEngineHistory(job(fx));
    const realClose = mutOps.close;
    mutOps.close = ((file: never) => {
      realClose(file);
      const last = fake.calls.at(-1) ?? "";
      if (last.startsWith("delete ") && last.endsWith("sess-claude-1.jsonl") && last.includes(ASIDE)) writeFileSync(last.slice("delete ".length), "a replacement nobody here opened");
    }) as typeof mutOps.close;
    let ran!: ReturnType<typeof run>;
    try { ran = run(fx, planned); } finally { mutOps.close = realClose; }
    expect(ran.staleHomes).toEqual([key(fx)]);
    const survivors = canaryHits(fx.root, ["a replacement nobody here opened"]);
    expect(survivors.length).toBe(1);
    expect(readFileSync(transcript, "utf8")).toBe("a replacement nobody here opened"); // put back under the name it came from, untouched
  });
});

describe("r18-4: a Codex rollout is removed only while its first line still says what the plan read", () => {
  const replaceFirstLine = (file: string, id: string, cwd: string) => writeFileSync(file, dump({ type: "session_meta", payload: { id, cwd } }) + dump({ type: "event", text: "someone else's words" }));

  it("replaced by a rollout of another folder: it survives and the home is stale", () => {
    const fx = buildFixture("codex", scratch);
    const planned = planEngineHistory(job(fx));
    replaceFirstLine(codexRollout(fx), "019a0000-aaaa-7bbb-8ccc-0000000000ee", "/foreign");
    const ran = run(fx, planned);
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(readFileSync(codexRollout(fx), "utf8")).toContain("someone else's words");
    expect(existsSync(`${codexRollout(fx)}${ASIDE}`)).toBe(false);
  });

  it("replaced by another thread of the same folder: it is not removed unseen; the next plan learns its id and removes it and its history", () => {
    const fx = buildFixture("codex", scratch);
    const planned = planEngineHistory(job(fx));
    const other = "019a0000-aaaa-7bbb-8ccc-0000000000dd";
    writeFileSync(join(fx.homes[0]!.home, "history.jsonl"), readFileSync(join(fx.homes[0]!.home, "history.jsonl"), "utf8") + dump({ session_id: other, text: "other-thread-private-text" }));
    replaceFirstLine(codexRollout(fx), other, fx.folders[0]!);
    const ran = run(fx, planned);
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(existsSync(codexRollout(fx))).toBe(true);
    expect(whole(fx, planEngineHistory(job(fx, { known: planned.discovery }))).failedHomes).toEqual([]);
    expect(existsSync(codexRollout(fx))).toBe(false);
    expect(readFileSync(join(fx.homes[0]!.home, "history.jsonl"), "utf8")).not.toContain("other-thread-private-text");
  });
});

describe("r18-5: a Codex thread found by its folder is checked inside the delete", () => {
  it("its folder changed after the plan: ROLLBACK, stale, the dependent history lines are untouched, and the next plan drops the id", () => {
    const fx = buildFixture("codex", scratch);
    const home = fx.homes[0]!;
    const orphan = "019a0000-aaaa-7bbb-8ccc-0000000000aa";
    walDatabase(join(home.sqliteHome!, "state_2.sqlite"), (db) => {
      db.exec("CREATE TABLE threads(id TEXT, first_user_message TEXT, cwd TEXT); CREATE TABLE logs(thread_id TEXT, body TEXT);");
      db.prepare("INSERT INTO threads VALUES(?,?,?)").run(orphan, "orphan-canary-7731", fx.folders[0]!);
      db.prepare("INSERT INTO logs VALUES(?,?)").run(orphan, "orphan-canary-7731");
    });
    const historyPath = join(home.home, "history.jsonl");
    writeFileSync(historyPath, readFileSync(historyPath, "utf8") + dump({ session_id: orphan, text: "orphan-canary-7731" }));
    const planned = planEngineHistory(job(fx));
    const db = new DatabaseSync(join(home.sqliteHome!, "state_2.sqlite"));
    openDatabases.push(db);
    db.prepare("UPDATE threads SET cwd = ?, first_user_message = ? WHERE id = ?").run("/foreign", "foreign-thread-words", orphan);
    const historyBefore = readFileSync(historyPath);
    const ran = run(fx, planned);
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(db.prepare("SELECT first_user_message FROM threads").all()).toEqual([{ first_user_message: "foreign-thread-words" }]);
    expect(readFileSync(historyPath).equals(historyBefore)).toBe(true); // the guard runs before the history is touched
    // the next plan, with the ids the first one found, drops the thread that is no longer this conversation's
    const replanned = planEngineHistory(job(fx, { known: planned.discovery }));
    const sqlSteps = Object.values(replanned.plans!).flatMap((plan) => plan.steps).filter((step) => step.k === "sqlDelete" && step.stmts.some((stmt) => stmt.params.includes(orphan)));
    expect(sqlSteps).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM threads").get()).toEqual({ n: 1 });
  });
});

describe("r18-7: a leftover aside is never put back by a step that did not make it", () => {
  it("only a leftover project folder aside, and a file in it in use: it stays aside, the home is pending", () => {
    fake.restore();
    fake = useFakeExclusion("win32");
    const fx = buildFixture("claude", scratch);
    const project = claudeProject(fx);
    renameSync(project, `${project}${ASIDE}`);
    const planned = planEngineHistory(job(fx));
    fake.refuse.add(join(project, "sess-claude-1.jsonl"));
    const ran = run(fx, planned);
    expect(ran.homeReasons[key(fx)]).toBe("held");
    expect(existsSync(project)).toBe(false);
    expect(existsSync(`${project}${ASIDE}`)).toBe(true);
  });
});

describe("r18-8: no way round the import rules in an executor file", () => {
  it("an alias of Function and the global object are escapes", () => {
    expect(importsOf('const Make = Function;\nMake("return process")().getBuiltinModule("fs")["readFileSync"]("/x");', "engine-exec.ts").escapes).toContain("Function");
    expect(importsOf('global["process"]["getBuiltinModule"]("fs")["readFileSync"]("/x");', "engine-exec.ts").escapes).toContain("global");
    expect(importsOf("const point = { global: 1, Function: 2 }; point.global + point.Function;", "engine-exec.ts").escapes).toEqual([]);
  });
});

describe("r18-9: the packaged addon is checked for what it is", () => {
  it("a zero-filled file with a Mach-O number, an image for another machine, and an addon of another version are refused", () => {
    const dir = mkdtempSync(join(scratch, "pkg-"));
    const put = (bytes: Buffer) => { writeFileSync(join(dir, "engine-exclusion.node"), bytes); return dir; };
    const zero = Buffer.alloc(4096);
    zero.writeUInt32BE(0xcffaedfe, 0);
    expect(() => validateEngineExclusionResource(put(zero), "darwin", "arm64")).toThrow(/MISMATCH/);
    const macho = (cputype: number) => { const b = Buffer.alloc(4096); b.writeUInt32BE(0xcffaedfe, 0); b.writeUInt32LE(cputype, 4); b.writeUInt32LE(8, 12); return b; };
    expect(validateEngineExclusionResource(put(macho(0x0100000c)), "darwin", "arm64")).toMatch(/engine-exclusion\.node$/);
    expect(() => validateEngineExclusionResource(put(macho(0x01000007)), "darwin", "arm64")).toThrow(/MISMATCH/);
    const elf = (machine: number) => { const b = Buffer.alloc(4096); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(b); b.writeUInt16LE(machine, 18); b.writeUInt16LE(3, 16); return b; };
    expect(validateEngineExclusionResource(put(elf(0x3e)), "linux", "x64")).toMatch(/engine-exclusion\.node$/);
    expect(() => validateEngineExclusionResource(put(elf(0xb7)), "linux", "x64")).toThrow(/MISMATCH/);
    const pe = (machine: number) => { const b = Buffer.alloc(4096); b[0] = 0x4d; b[1] = 0x5a; b.writeUInt32LE(0x80, 0x3c); b.writeUInt32BE(0x50450000, 0x80); b.writeUInt16LE(machine, 0x84); b.writeUInt16LE(0x2000, 0x80 + 22); return b; };
    expect(validateEngineExclusionResource(put(pe(0x8664)), "win32", "x64")).toMatch(/engine-exclusion\.node$/);
    expect(() => validateEngineExclusionResource(put(pe(0xaa64)), "win32", "x64")).toThrow(/MISMATCH/);
    // an addon that answers with another version does not load
    const file = join(dir, "other-version.cjs");
    writeFileSync(file, "module.exports={lock:()=>true,processes:()=>[],renameNoReplace:()=>0,version:()=>2};");
    const saved = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
    process.env.MURAGE_ENGINE_EXCLUSION_PATH = file;
    forgetExclusionAddon();
    try { expect(loadExclusionAddon()?.version()).not.toBe(2); } finally {
      if (saved === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = saved;
      forgetExclusionAddon();
    }
  });
});

